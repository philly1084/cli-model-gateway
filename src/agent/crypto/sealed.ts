import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";

export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJSON(v)}`)
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Value is not JSON");
  return encoded;
}
export const digest = (value: unknown): string =>
  createHash("sha256").update(canonicalJSON(value)).digest("hex");
export const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
export interface KeyProvider {
  getDataKey(kid: string): Buffer;
  getMacKey(): Buffer;
}
export class StaticKeyProvider implements KeyProvider {
  constructor(
    private readonly keys: Record<string, Buffer>,
    private readonly mac: Buffer,
  ) {
    if (Object.values(keys).some((k) => k.length !== 32) || mac.length !== 32)
      throw Error("Keys must be 32 bytes");
  }
  getDataKey(kid: string): Buffer {
    const key = this.keys[kid];
    if (!key) throw Error("Unknown key id");
    return Buffer.from(key);
  }
  getMacKey(): Buffer {
    return Buffer.from(this.mac);
  }
}
export class SopsKeyProvider extends StaticKeyProvider {
  static async load(
    file: string,
    checkerFile: string,
    spawnFn: typeof spawn = spawn,
  ): Promise<SopsKeyProvider> {
    const decrypt = (source: string) =>
      new Promise<unknown>((resolve, reject) => {
        const child = spawnFn("sops", ["-d", "--output-type", "json", source], {
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        });
        const chunks: Buffer[] = [];
        let size = 0;
        child.stdin?.end();
        child.stdout?.on("data", (b: Buffer) => {
          size += b.length;
          if (size > 65536) {
            child.kill();
            reject(Error("Key document too large"));
          } else chunks.push(b);
        });
        child.stderr?.resume();
        child.on("error", () => reject(Error("SOPS unavailable")));
        const timer = setTimeout(() => {
          child.kill();
          reject(Error("SOPS timeout"));
        }, 10000);
        child.on("close", (code) => {
          clearTimeout(timer);
          try {
            if (code !== 0) throw Error();
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(Error("Invalid SOPS key document"));
          } finally {
            chunks.forEach((b) => b.fill(0));
          }
        });
      });
    const data = z
      .object({ keys: z.record(z.string()) })
      .parse(await decrypt(file));
    const checker = z
      .object({ macKey: z.string() })
      .parse(await decrypt(checkerFile));
    return new SopsKeyProvider(
      Object.fromEntries(
        Object.entries(data.keys).map(([id, key]) => [
          id,
          Buffer.from(key, "base64"),
        ]),
      ),
      Buffer.from(checker.macKey, "base64"),
    );
  }
}
export const sealedSchema = z
  .object({
    v: z.literal(1),
    kid: z.string().min(1),
    iv: z.string(),
    tag: z.string(),
    ct: z.string(),
  })
  .strict();
export type Sealed = z.infer<typeof sealedSchema>;
export class Sealer {
  constructor(
    readonly keys: KeyProvider,
    readonly kid = "data",
  ) {}
  seal(obj: unknown, aad: string): Sealed {
    const key = this.keys.getDataKey(this.kid),
      iv = randomBytes(12),
      plain = Buffer.from(canonicalJSON(obj));
    try {
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(aad));
      const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
      return {
        v: 1,
        kid: this.kid,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ct: ct.toString("base64"),
      };
    } finally {
      key.fill(0);
      plain.fill(0);
    }
  }
  open<T = unknown>(input: unknown, aad: string): T {
    const s = sealedSchema.parse(input),
      key = this.keys.getDataKey(s.kid);
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(s.iv, "base64"),
      );
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(Buffer.from(s.tag, "base64"));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(s.ct, "base64")),
        decipher.final(),
      ]);
      try {
        return JSON.parse(plain.toString("utf8")) as T;
      } finally {
        plain.fill(0);
      }
    } finally {
      key.fill(0);
    }
  }
}
export const seal = (
  obj: unknown,
  aad: string,
  keys: KeyProvider,
  kid = "data",
) => new Sealer(keys, kid).seal(obj, aad);
export const open = <T = unknown>(
  obj: Sealed,
  aad: string,
  keys: KeyProvider,
) => new Sealer(keys).open<T>(obj, aad);
