import type { SealedLog } from "../store/sealed-log.js";
export type MemoryLayer =
  | "caller_profile"
  | "agent_profile"
  | "journal"
  | "facts";
export interface MemoryRecord {
  layer: MemoryLayer;
  id: string;
  text: string;
  status?: "proposed" | "verified" | "retracted";
  source?: string;
  provenance?: { jobId: string; receiptId?: string };
}
export interface Embedder {
  embed(text: string): Promise<number[]>;
}
const terms = (text: string): string[] =>
  text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
export class KeywordIndex {
  private docs = new Map<string, MemoryRecord>();
  put(record: MemoryRecord): void {
    this.docs.set(`${record.layer}:${record.id}`, structuredClone(record));
  }
  retrieve(
    query: string,
    budgetChars: number,
  ): { untrusted: true; text: string; records: MemoryRecord[] } {
    const words = [...new Set(terms(query))],
      docs = [...this.docs.values()].filter((d) => d.status !== "retracted");
    const avg =
      docs.reduce((n, d) => n + terms(d.text).length, 0) / (docs.length || 1) ||
      1;
    const scored = docs
      .map((doc) => {
        const tokens = terms(doc.text);
        let score = 0;
        for (const term of words) {
          const tf = tokens.filter((t) => t === term).length,
            df = docs.filter((d) => terms(d.text).includes(term)).length;
          score +=
            (Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)) * tf * 2.2) /
            (tf + 1.2 * (0.25 + (0.75 * tokens.length) / avg));
        }
        return { doc, score };
      })
      .filter((d) => d.score > 0)
      .sort((a, b) => b.score - a.score);
    let text = "";
    const records: MemoryRecord[] = [];
    for (const { doc } of scored) {
      const remaining = Math.max(0, budgetChars - text.length);
      if (!remaining) break;
      const addition =
        `${text ? "\n" : ""}[${doc.layer}:${doc.id}] ${doc.text}`.slice(
          0,
          remaining,
        );
      text += addition;
      records.push({ ...doc, text: addition });
    }
    return { untrusted: true, text, records };
  }
}
export class AgentMemory {
  readonly index = new KeywordIndex();
  private records = new Map<string, MemoryRecord>();
  constructor(private log: SealedLog) {
    for (const r of log.read())
      if (r.type === "memory") this.remember(r.body as MemoryRecord);
  }
  private remember(r: MemoryRecord): void {
    this.records.set(`${r.layer}:${r.id}`, structuredClone(r));
    this.index.put(r);
  }
  write(record: MemoryRecord, approvalReceiptId?: string): void {
    if (
      ["caller_profile", "agent_profile"].includes(record.layer) &&
      !approvalReceiptId
    )
      throw Error("Profile approval required");
    if (
      record.layer === "journal" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(record.id) || !record.provenance?.receiptId)
    )
      throw Error("Journal needs date and receipt");
    if (
      record.layer === "facts" &&
      record.status === "verified" &&
      !record.provenance?.receiptId
    )
      throw Error("Promotion needs receipt");
    this.log.append("memory", `${record.layer}:${record.id}`, record);
    this.remember(record);
  }
  promote(id: string, receiptId: string): void {
    const record = this.records.get(`facts:${id}`);
    if (!record || !receiptId || !record.provenance)
      throw Error("Promotion needs provenance and receipt");
    this.write({
      ...record,
      status: "verified",
      provenance: { ...record.provenance, receiptId },
    });
  }
  retrieve(query: string, budgetChars: number) {
    return this.index.retrieve(query, budgetChars);
  }
}
