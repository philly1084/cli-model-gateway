import { createHash } from "node:crypto";
import type { ProviderToolCall, UnifiedRequest, ProviderResult, ChatMessage } from "../types";

/** Protocol failures contain evidence hashes, never model arguments or credentials. */
export class ToolContractError extends Error {
  readonly code = "provider_tool_contract_invalid";
  readonly evidenceSha256: string;
  constructor(readonly issue: string, evidence: unknown) {
    super(`Provider tool contract rejected: ${issue}.`);
    this.name = "ToolContractError";
    this.evidenceSha256 = createHash("sha256").update(JSON.stringify(evidence) ?? "undefined").digest("hex");
  }
}

export function strictToolArguments(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text !== "string" || Buffer.byteLength(text) > 262144) throw new ToolContractError("arguments_missing_or_oversized", value);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ToolContractError("arguments_invalid_json", value); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ToolContractError("arguments_not_object", value);
  // Preserve the exact JSON string and keys. Repairs must be a new model proposal.
  return text;
}

export function strictToolCalls(value: unknown): ProviderToolCall[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new ToolContractError("calls_not_bounded_array", value);
  const ids = new Set<string>();
  return value.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ToolContractError("call_not_object", entry);
    const fn = entry.function && typeof entry.function === "object" ? entry.function : entry;
    if (typeof entry.id !== "string" || !entry.id.trim() || entry.id.length > 512) throw new ToolContractError("call_id_missing", entry);
    if (ids.has(entry.id)) throw new ToolContractError("call_id_duplicate", entry);
    ids.add(entry.id);
    if (typeof fn.name !== "string" || !fn.name || fn.name !== fn.name.trim() || fn.name.length > 256) throw new ToolContractError("call_name_invalid", entry);
    return { id: entry.id, name: fn.name, arguments: strictToolArguments(fn.arguments) };
  });
}

export function requireOfferedTool(call: ProviderToolCall, names: ReadonlySet<string>): void {
  if (!names.has(call.name)) throw new ToolContractError("tool_not_offered", call);
}

/** Read-only compatibility: import a legacy marker only beside explicit result messages.
 * Stored history is never rewritten, so rollback retains the original transcript. */
export function migrateToolHistory(messages: ChatMessage[]): ChatMessage[] {
  const migrated = messages.map((message,index) => {
    if (message.role !== "assistant" || message.toolCalls !== undefined) return {...message};
    const marker = "TOOL_CALLS:\n", at = message.content.indexOf(marker);
    if (at < 0 || (at > 0 && !message.content.slice(0,at).endsWith("\n\n"))) return {...message};
    // Ordinary examples without explicit tool-result continuation remain ordinary text.
    if (messages[index+1]?.role !== "tool") return {...message};
    let raw: unknown;
    try { raw = JSON.parse(message.content.slice(at+marker.length)); }
    catch { throw new ToolContractError("history_invalid_json",message.content); }
    const calls = strictToolCalls(raw);
    return {...message,content:message.content.slice(0,at).replace(/\n\n$/, ""),toolCalls:calls};
  });
  const out: ChatMessage[] = [];
  for (const message of migrated) {
    const previous = out.at(-1);
    if (message.role === "assistant" && message.toolCalls?.length && !message.content && previous?.role === "assistant" && previous.toolCalls?.length && message.reasoningContent === undefined) {
      previous.toolCalls = [...previous.toolCalls,...message.toolCalls];
    } else out.push(message);
  }
  return out;
}

export function validateToolHistory(messages: UnifiedRequest["messages"]): void {
  const pending = new Set<string>(), seen = new Set<string>();
  for (const message of migrateToolHistory(messages)) {
    if (message.role === "tool") {
      if (!message.tool_call_id || !pending.delete(message.tool_call_id)) throw new ToolContractError("orphan_or_duplicate_result", message.tool_call_id);
      continue;
    }
    const calls = message.role === "assistant" ? strictToolCalls(message.toolCalls) : [];
    if (pending.size && (!calls.length || message.content)) throw new ToolContractError("tool_results_missing", [...pending]);
    for (const call of calls) {
      if (seen.has(call.id)) throw new ToolContractError("history_reused_call_id", call.id);
      seen.add(call.id); pending.add(call.id);
    }
  }
  if (pending.size) throw new ToolContractError("tool_results_missing", [...pending]);
}

export function validateToolResult(result: ProviderResult, request: UnifiedRequest): ProviderResult {
  const calls = strictToolCalls(result.toolCalls), names = new Set(request.tools.map(t => t.function.name));
  for (const call of calls) requireOfferedTool(call, names);
  if ((calls.length > 0) !== (result.finishReason === "tool_calls")) throw new ToolContractError("finish_reason_mismatch", result.finishReason);
  return result;
}
