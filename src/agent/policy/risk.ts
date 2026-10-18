import { z } from "zod";
import { digest } from "../crypto/sealed.js";
export const tierSchema = z.enum(["R0", "R1", "R2", "R3", "R4"]);
export const effectSchema = z.enum([
  "read",
  "write",
  "execute",
  "send",
  "spend",
  "delete",
  "deploy",
  "dns",
  "merge",
  "contact",
]);
export type Tier = z.infer<typeof tierSchema>;
export type Effect = z.infer<typeof effectSchema>;
export interface RiskStep {
  tier?: Tier;
  effect?: Effect;
  external?: boolean;
  [key: string]: unknown;
}
export function classify(step: RiskStep): {
  tier: Tier;
  effect: Effect;
  needsApproval: boolean;
  fresh: boolean;
} {
  const effect = step.effect ?? "write";
  let tier: Tier = [
    "spend",
    "delete",
    "deploy",
    "dns",
    "merge",
    "contact",
  ].includes(effect)
    ? "R4"
    : effect === "read"
      ? step.external
        ? "R1"
        : "R0"
      : effect === "write"
        ? "R2"
        : "R3";
  if (!step.effect) tier = "R3";
  if (step.tier && step.tier > tier) tier = step.tier;
  return { tier, effect, needsApproval: tier >= "R2", fresh: tier === "R4" };
}
export function autoRunDigest(spec: RiskStep): string {
  const { autoRun: _a, autoRunApprovalDigest: _d, ...action } = spec;
  return digest({ kind: "autoRun", spec: action });
}
export function canAutoRun(spec: RiskStep): boolean {
  return (
    classify(spec).tier <= "R1" &&
    spec.autoRun === true &&
    spec.autoRunApprovalDigest === autoRunDigest(spec)
  );
}
