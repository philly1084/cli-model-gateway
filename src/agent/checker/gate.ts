import { timingSafeEqual } from "node:crypto";
import { canonicalJSON, sha256 } from "../crypto/sealed.js";
import { receiptMac, type CheckRequest, type Receipt } from "./checker.js";
export function isDone(
  job: Pick<CheckRequest, "jobId" | "artifacts">,
  receipt: Receipt | undefined,
  checkerKey: Buffer,
): boolean {
  try {
    if (
      !receipt ||
      receipt.jobId !== job.jobId ||
      receipt.verdict !== "pass" ||
      !receipt.checks.length ||
      receipt.checks.some((c) => !c.pass)
    )
      return false;
    const { mac, ...unsigned } = receipt,
      expected = Buffer.from(receiptMac(unsigned, checkerKey), "hex"),
      actual = Buffer.from(mac, "hex");
    return (
      actual.length === expected.length &&
      timingSafeEqual(actual, expected) &&
      canonicalJSON(receipt.artifactDigests) ===
        canonicalJSON(
          job.artifacts.map((a) => ({
            name: a.name,
            sha256: sha256(a.content),
          })),
        ) &&
      job.artifacts.every((a) => sha256(a.content) === a.sha256)
    );
  } catch {
    return false;
  }
}
