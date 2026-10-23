import type { UnifiedRequest } from "../types.js";

/** A local request rejection before provider execution, never an uncertain outcome. */
export class RequestCapabilityError extends Error {
  constructor(message: string, readonly code = "model_capability_mismatch") {
    super(message);
    this.name = "RequestCapabilityError";
  }
}

export function requestRequiresTools(request: Pick<UnifiedRequest, "tools" | "metadata">): boolean {
  const metadata = request.metadata;
  if (request.tools.length > 0) return true;
  if ([metadata?.tools, metadata?.functions].some(value => Array.isArray(value) && value.length > 0)) return true;
  const choice = metadata?.tool_choice ?? metadata?.function_call;
  return choice !== undefined && choice !== null && choice !== "none" && choice !== "auto";
}
