import {
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  closeSync,
  unlinkSync,
  fsyncSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJSON, digest, Sealer } from "../crypto/sealed.js";
import { hasSecret } from "../checker/checker.js";
import type { LeaseManager } from "../pool/leases.js";

export interface LogRecord {
  seq: number;
  type: string;
  id: string;
  prevHash: string;
  body: unknown;
}
export class SealedLog {
  readonly logId: string;
  readonly path: string;
  private readonly lock: string;
  private readonly nonce = randomUUID();
  private records: LogRecord[] = [];
  private fd: number;
  private closed = false;
  constructor(
    directory: string,
    readonly sealer: Sealer,
    logId = "agent",
  ) {
    if (!/^[a-zA-Z0-9_-]+$/.test(logId)) throw Error("Invalid log id");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.logId = logId;
    this.path = join(directory, `${logId}.jsonl`);
    this.lock = join(directory, "writer.lock");
    // Fail closed on stale locks too: removing one requires operator reconciliation.
    const lock = openSync(this.lock, "wx", 0o600);
    writeFileSync(lock, canonicalJSON({ pid: process.pid, nonce: this.nonce }));
    closeSync(lock);
    try {
      this.replay();
      this.fd = openSync(this.path, "a", 0o600);
    } catch (error) {
      unlinkSync(this.lock);
      throw error;
    }
  }
  append(type: string, id: string, body: unknown): LogRecord {
    if (this.closed) throw Error("Log closed");
    if (hasSecret(canonicalJSON(body)))
      throw Error("Secret detected; record rejected");
    const previous = this.records.at(-1);
    const record: LogRecord = {
      seq: this.records.length,
      type,
      id,
      prevHash: previous ? digest(previous) : "0".repeat(64),
      body: structuredClone(body),
    };
    // Type and id stay inside the envelope; stable log identity binds the AAD.
    writeFileSync(
      this.fd,
      `${canonicalJSON(this.sealer.seal(record, `log:${this.logId}:${record.seq}`))}\n`,
    );
    fsyncSync(this.fd);
    this.records.push(record);
    return structuredClone(record);
  }
  read(fromSeq = 0, toSeq = this.records.length - 1): LogRecord[] {
    return structuredClone(
      this.records.filter((r) => r.seq >= fromSeq && r.seq <= toSeq),
    );
  }
  appendFenced(
    type: string,
    id: string,
    body: unknown,
    leases: LeaseManager,
    key: string,
    token: number,
  ): LogRecord {
    leases.assertFence(key, token);
    return this.append(type, id, body);
  }
  replay(): LogRecord[] {
    const raw = existsSync(this.path) ? readFileSync(this.path, "utf8") : "";
    if (raw && !raw.endsWith("\n")) throw Error("Truncated log");
    const records = raw
      .split("\n")
      .filter(Boolean)
      .map((line, seq) =>
        this.sealer.open<LogRecord>(
          JSON.parse(line),
          `log:${this.logId}:${seq}`,
        ),
      );
    records.forEach((r, i) => {
      if (
        r.seq !== i ||
        r.prevHash !== (i ? digest(records[i - 1]) : "0".repeat(64))
      )
        throw Error("Broken log chain");
    });
    this.records = records;
    return this.read();
  }
  verifyChain(): boolean {
    try {
      this.replay();
      return true;
    } catch {
      return false;
    }
  }
  close(): void {
    if (!this.closed) {
      closeSync(this.fd);
      this.closed = true;
      const lock = JSON.parse(readFileSync(this.lock, "utf8")) as {
        nonce: string;
      };
      if (lock.nonce === this.nonce) unlinkSync(this.lock);
    }
  }
}
