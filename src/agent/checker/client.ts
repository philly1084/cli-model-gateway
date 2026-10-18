import { spawn } from "node:child_process";
import { join } from "node:path";
import type { KeyProvider } from "../crypto/sealed.js";
import { Sealer } from "../crypto/sealed.js";
import type { CheckRequest, Receipt } from "./checker.js";
export interface CheckerClient {
  verify(request: CheckRequest): Promise<Receipt>;
}
export class ProcessCheckerClient implements CheckerClient {
  constructor(
    private keys: KeyProvider,
    private timeoutMs = 30000,
  ) {}
  async verify(request: CheckRequest): Promise<Receipt> {
    const sealer = new Sealer(this.keys),
      data = this.keys.getDataKey("data"),
      mac = this.keys.getMacKey();
    try {
      return await new Promise<Receipt>((resolve, reject) => {
        const child = spawn(process.execPath, [join(__dirname, "cli.js")], {
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
        });
        const chunks: Buffer[] = [];
        let size = 0;
        const timer = setTimeout(() => {
          child.kill();
          reject(Error("Checker timeout"));
        }, this.timeoutMs);
        child.stdout.on("data", (b: Buffer) => {
          size += b.length;
          if (size > 1048576) {
            child.kill();
            reject(Error("Checker receipt too large"));
          } else chunks.push(b);
        });
        child.stderr.resume();
        child.on("error", () => {
          clearTimeout(timer);
          reject(Error("Checker unavailable"));
        });
        child.stdin.on("error", () => {});
        child.on("close", (code) => {
          clearTimeout(timer);
          try {
            if (code !== 0) throw Error("Checker failed");
            resolve(
              sealer.open<Receipt>(
                JSON.parse(Buffer.concat(chunks).toString("utf8")),
                "checker:receipt",
              ),
            );
          } catch {
            reject(Error("Checker receipt rejected"));
          }
        });
        child.stdin.end(
          JSON.stringify({
            dataKey: data.toString("base64"),
            checkerKey: mac.toString("base64"),
            request: sealer.seal(request, "checker:request"),
          }),
        );
      });
    } finally {
      data.fill(0);
      mac.fill(0);
    }
  }
}
