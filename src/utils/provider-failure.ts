import type { ProviderResult } from "../types.js";

export const finishReasons = ["stop", "length", "tool_calls", "content_filter", "absent", "other"] as const;
export type SafeFinishReason = typeof finishReasons[number];
export const safeFinishReason = (value: unknown): SafeFinishReason => value == null ? "absent"
  : finishReasons.includes(value as SafeFinishReason) ? value as SafeFinishReason : "other";
export type ProviderFailureCode = "empty_completion" | "output_truncated" | "upstream_timeout" | "upstream_transport" | "reasoning_content_required" | "provider_error";
export class ProviderFailure extends Error {
  readonly name = "ProviderFailure";
  readonly httpStatus: number;
  readonly finishReason: SafeFinishReason;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  constructor(readonly code: ProviderFailureCode, details: { finishReason?: unknown; usage?: { inputTokens?: number; outputTokens?: number }; uncertain?: boolean } = {}) {
    super(`Provider request failed: ${code}`);
    this.httpStatus = code === "reasoning_content_required" ? 400 : code === "upstream_timeout" ? 504 : 502;
    this.finishReason = safeFinishReason(details.finishReason);
    this.promptTokens = tokenCount(details.usage?.inputTokens);
    this.completionTokens = tokenCount(details.usage?.outputTokens);
    this.uncertain = details.uncertain ?? false;
  }
  readonly uncertain: boolean;
}
export function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// Read only protocol metadata. Provider content and reasoning never enter errors.
export function rejectTruncatedPayload(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const p = payload as Record<string, unknown>;
  const choice = Array.isArray(p.choices) ? p.choices[0] as { finish_reason?: unknown } | undefined : undefined;
  if (choice?.finish_reason !== "length" && p.stop_reason !== "max_tokens") return;
  const usage = p.usage as Record<string, unknown> | undefined;
  throw new ProviderFailure("output_truncated", { finishReason: "length", usage: {
    inputTokens: tokenCount(usage?.prompt_tokens ?? usage?.input_tokens),
    outputTokens: tokenCount(usage?.completion_tokens ?? usage?.output_tokens),
  } });
}
export function invalidCompletion(result: ProviderResult): ProviderFailure {
  const raw = result.raw && typeof result.raw === "object" ? result.raw as Record<string, unknown> : undefined;
  const choice = Array.isArray(raw?.choices) ? raw.choices[0] as { finish_reason?: unknown } | undefined : undefined;
  const reason = raw && "choices" in raw ? choice?.finish_reason : result.finishReason;
  return new ProviderFailure(result.finishReason === "length" ? "output_truncated"
    : !result.outputText.trim() && !result.toolCalls.length ? "empty_completion" : "provider_error",
  { finishReason: reason, usage: result.usage });
}
