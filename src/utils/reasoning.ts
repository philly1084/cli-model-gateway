import { REASONING_EFFORT_VALUES, type ReasoningEffort, type ReasoningEffortReceipt } from "../types";

const REASONING_EFFORT_SET = new Set<ReasoningEffort>(REASONING_EFFORT_VALUES);

export function normalizeModelReasoningEffort(model: string, effort?: ReasoningEffort): ReasoningEffort | undefined {
  if (!effort) return undefined;
  const id = model.split("/").pop()!.toLowerCase();
  const supported: readonly ReasoningEffort[] = /^gpt-6\.1-sol(?:-|$)/.test(id)
    ? ["low", "medium", "high", "xhigh"]
    : /^(?:o[134](?:-|$)|gpt-oss-)/.test(id)
      ? ["low", "medium", "high"]
      : REASONING_EFFORT_VALUES;
  const index = REASONING_EFFORT_VALUES.indexOf(effort);
  return supported.reduce((nearest, candidate) =>
    Math.abs(REASONING_EFFORT_VALUES.indexOf(candidate) - index) < Math.abs(REASONING_EFFORT_VALUES.indexOf(nearest) - index)
      ? candidate : nearest, supported[0]!);
}

export function buildReasoningEffortReceipt(
  requested: ReasoningEffort | undefined,
  forwarded: string | null,
  model: string,
  providerId: string,
  applied: boolean | "unconfirmed" = "unconfirmed",
): ReasoningEffortReceipt | undefined {
  if (!requested) return undefined;
  return { requested, forwarded, applied, model, providerId,
    ...(requested !== forwarded ? { normalizedFrom: requested } : {}) };
}

// Only structured provider metadata qualifies; generated assistant text never does.
export function confirmedReasoningEffort(value: unknown, forwarded?: string | null): boolean | "unconfirmed" {
  const effort = returnedReasoningEffort(value);
  return effort !== undefined && forwarded ? effort === forwarded : "unconfirmed";
}

export function returnedReasoningEffort(value: unknown): string | undefined {
  const record = asRecord(value);
  const effort = record?.reasoningEffort ?? record?.reasoning_effort ?? asRecord(record?.reasoning)?.effort;
  return typeof effort === "string" ? effort : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "max") {
    return "xhigh";
  }
  if (!normalized || !REASONING_EFFORT_SET.has(normalized as ReasoningEffort)) {
    return undefined;
  }

  return normalized as ReasoningEffort;
}

export function resolveReasoningEffort(
  value: unknown,
  fallback?: ReasoningEffort,
): ReasoningEffort | undefined {
  const record = asRecord(value);
  if (!record) {
    return fallback;
  }

  const nestedReasoning = asRecord(record.reasoning);

  return (
    parseReasoningEffort(record.reasoning_effort) ??
    parseReasoningEffort(record.reasoningEffort) ??
    parseReasoningEffort(nestedReasoning?.effort) ??
    fallback
  );
}
