import { z } from "zod";
import { Sealer, StaticKeyProvider, sealedSchema } from "../crypto/sealed.js";
import { check, type CheckRequest } from "./checker.js";
// Keys are bootstrap material on an inherited private pipe, never argv/env/files.
export async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const b = Buffer.from(chunk as Buffer);
    size += b.length;
    if (size > 16 * 1024 * 1024) throw Error("Request too large");
    chunks.push(b);
  }
  const frame = z
    .object({
      dataKey: z.string(),
      checkerKey: z.string(),
      request: sealedSchema,
    })
    .strict()
    .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const key = Buffer.from(frame.dataKey, "base64"),
    mac = Buffer.from(frame.checkerKey, "base64");
  try {
    const sealer = new Sealer(new StaticKeyProvider({ data: key }, mac));
    const request = sealer.open<CheckRequest>(frame.request, "checker:request");
    const receipt = await check(request, mac);
    process.stdout.write(
      JSON.stringify(sealer.seal(receipt, "checker:receipt")),
    );
  } finally {
    chunks.forEach((b) => b.fill(0));
    key.fill(0);
    mac.fill(0);
  }
}
if (require.main === module)
  void main().catch(() => {
    process.stderr.write("Checker request rejected\n");
    process.exitCode = 1;
  });
