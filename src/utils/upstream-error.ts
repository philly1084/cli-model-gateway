import type { UnifiedRequest } from "../types.js";

export function hasUpstreamError(payload: unknown): boolean {
  if (Array.isArray(payload)) return payload.some(hasUpstreamError);
  return !!payload && typeof payload === "object" && "error" in payload && !!payload.error;
}

// Inspect diagnostic lines only; never retain upstream messages in the thrown error.
export function cliModelErrorDetector(patterns?: string[]): (stream: "stdout" | "stderr", chunk: string) => UpstreamError | undefined {
  const matches = (message: string) => patterns ? patterns.some(pattern => new RegExp(pattern, "i").test(message)) : unsupportedModel(message);
  const pending = { stdout: "", stderr: "" };
  return (stream, chunk) => {
    pending[stream] += chunk;
    const lines = pending[stream].split(/\r?\n/);
    pending[stream] = (lines.pop() ?? "").slice(-65536);
    for (const line of [...lines, pending[stream]]) {
      const diagnostic = line.trim().replace(/^ERROR:\s*/i, "");
      try {
        const payload = JSON.parse(diagnostic);
        if (!hasUpstreamError(payload)) continue;
        const status = payload.status ?? payload.statusCode ?? payload.error?.status;
        const code = payload.error?.code ?? payload.error?.type;
        const message = payload.error?.message;
        if (status === 404 || code === "model_not_found" || (typeof message === "string" && matches(message))) {
          return new UpstreamError(status === 400 || status === 404 ? status : code === "model_not_found" ? 404 : 400, payload);
        }
      } catch { /* Incomplete JSON or a plain CLI diagnostic. */ }
      if ((stream === "stderr" || /^(?:ERROR:\s*|error\b|(?:the\s+)?(?:['"][^'"]{1,128}['"]\s+)?model\b)/i.test(line.trim())) && matches(diagnostic)) {
        return new UpstreamError(400, { error: { message: diagnostic } });
      }
    }
    return undefined;
  };
}

function unsupportedModel(message: string): boolean {
  return /\bmodel\b[^\r\n]{0,256}\b(?:is\s+)?not supported\b/i.test(message);
}

export class UpstreamError extends Error {
  readonly code: string;
  readonly upstreamCode?: string;
  readonly quotaExhausted: boolean;
  readonly retryAfterMs?: number;
  constructor(readonly status?: number, payload?: unknown, decodeArrayErrors = true, retryAfter?: string | null) {
    const value = Array.isArray(payload) ? (decodeArrayErrors ? payload.find(item => item?.error)?.error : undefined) : (payload as { error?: unknown } | undefined)?.error;
    const error = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const upstreamCode = error.code ?? error.status ?? error.type;
    status ??= typeof error.code === "number" ? error.code : undefined;
    // Only known protocol codes are retained; upstream messages may contain secrets or content.
    const code = status === 401 || status === 403 || /UNAUTHENTICATED|PERMISSION_DENIED|invalid_authentication_error|invalid_api_key/.test(String(upstreamCode)) ? "auth"
      : status === 404 || upstreamCode === "NOT_FOUND" || upstreamCode === "model_not_found" || ((status === 400 || status === undefined) && typeof error.message === "string" && unsupportedModel(error.message)) ? "model_unavailable"
      : status === 429 || upstreamCode === "RESOURCE_EXHAUSTED" || upstreamCode === "rate_limit_exceeded" ? "rate_limited"
      : status === 503 || upstreamCode === "UNAVAILABLE" ? "capacity_exhausted" : "upstream_error";
    super(`Provider API request failed (${status ?? "stream"}): ${code}`);
    this.code = code;
    this.status = status;
    // Retain classification and timing only; diagnostics can contain credentials.
    this.quotaExhausted = /exceeded your current quota/i.test(String(error.message ?? "")) ||
      (code === "rate_limited" && /per.?day|daily|requestsperday|billing/i.test(JSON.stringify(error)));
    const details = Array.isArray(error.details) ? error.details : [];
    const delay = details.find(item => item && typeof item === "object" && typeof item.retryDelay === "string")?.retryDelay;
    const seconds = typeof delay === "string" && /^\d+(\.\d+)?s$/.test(delay) ? Number(delay.slice(0, -1)) * 1000 : undefined;
    const headerMs = retryAfter ? (/^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : undefined;
    const delays = [seconds, headerMs].filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0);
    if (delays.length) this.retryAfterMs = Math.max(...delays);
    if (typeof upstreamCode === "string" && /^(UNAVAILABLE|RESOURCE_EXHAUSTED|NOT_FOUND|UNAUTHENTICATED|PERMISSION_DENIED|invalid_authentication_error|invalid_api_key|invalid_request_error|model_not_found|rate_limit_exceeded)$/.test(upstreamCode)) this.upstreamCode = upstreamCode;
  }
  get transient(): boolean { return this.code === "rate_limited" || this.code === "capacity_exhausted"; }
}

export function replaySafeChat(request: Pick<UnifiedRequest, "messages" | "tools" | "metadata" | "requestKind">): boolean {
  if (request.requestKind && request.requestKind !== "chat_completions" && request.requestKind !== "responses") return false;
  if (request.tools.length || request.messages.some(m => m.role !== "system" && m.role !== "user")) return false;
  const stateful = (value: unknown): boolean => !!value && typeof value === "object" && Object.entries(value).some(([key, item]) =>
    /session|thread|conversation|previous_response|remote|sticky/i.test(key) || (key === "metadata" && stateful(item)));
  return !stateful(request.metadata);
}
