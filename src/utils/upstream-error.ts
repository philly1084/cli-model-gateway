import type { UnifiedRequest } from "../types.js";

export function hasUpstreamError(payload: unknown): boolean {
  if (Array.isArray(payload)) return payload.some(hasUpstreamError);
  return !!payload && typeof payload === "object" && "error" in payload && !!payload.error;
}

export class UpstreamError extends Error {
  readonly code: string;
  readonly upstreamCode?: string;
  constructor(readonly status?: number, payload?: unknown) {
    const value = Array.isArray(payload) ? payload.find(item => item?.error)?.error : (payload as { error?: unknown } | undefined)?.error;
    const error = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const upstreamCode = error.code ?? error.status ?? error.type;
    status ??= typeof error.code === "number" ? error.code : undefined;
    // Only known protocol codes are retained; upstream messages may contain secrets or content.
    const code = status === 401 || status === 403 || /UNAUTHENTICATED|PERMISSION_DENIED|invalid_authentication_error|invalid_api_key/.test(String(upstreamCode)) ? "auth"
      : status === 404 || upstreamCode === "NOT_FOUND" || upstreamCode === "model_not_found" ? "model_unavailable"
      : status === 429 || upstreamCode === "RESOURCE_EXHAUSTED" || upstreamCode === "rate_limit_exceeded" ? "rate_limited"
      : status === 503 || upstreamCode === "UNAVAILABLE" ? "capacity_exhausted" : "upstream_error";
    super(`Provider API request failed (${status ?? "stream"}): ${code}`);
    this.code = code;
    this.status = status;
    if (typeof upstreamCode === "string" && /^(UNAVAILABLE|RESOURCE_EXHAUSTED|NOT_FOUND|UNAUTHENTICATED|PERMISSION_DENIED|invalid_authentication_error|invalid_api_key|model_not_found|rate_limit_exceeded)$/.test(upstreamCode)) this.upstreamCode = upstreamCode;
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
