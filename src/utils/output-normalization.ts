import type { ChatMessage, ProviderResult, ProviderTokenUsage } from "../types.js";
import type { ProviderProfile } from "../provider-profiles.js";
import { buildChatUsage, estimateTokensFromText } from "./usage.js";

export const providerFields = new Set(["reasoning", "reasoning_content", "reasoning_details", "provider", "native_finish_reason", "service_tier", "extra_content"]);

export function stripProviderFields(value: Record<string, unknown>, includeReasoning: boolean): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => includeReasoning || !providerFields.has(key)).map(([key, item]) => [key,
    Array.isArray(item) ? item.map(child => child && typeof child === "object" ? stripProviderFields(child, includeReasoning) : child)
      : item && typeof item === "object" ? stripProviderFields(item as Record<string, unknown>, includeReasoning) : item,
  ]));
}

export function normalizeFinishReason(value: unknown, tools = false): ProviderResult["finishReason"] {
  if (tools && value === "stop") return "tool_calls";
  return ["stop", "length", "tool_calls", "content_filter", "error"].includes(String(value)) ? value as ProviderResult["finishReason"] : "stop";
}

export function completeUsage(usage: ProviderTokenUsage | undefined, messages: ChatMessage[], text: string): Record<string, unknown> {
  const prompt = usage?.promptTokens ?? usage?.inputTokens;
  const completion = usage?.completionTokens ?? usage?.outputTokens;
  const estimated = prompt === undefined || completion === undefined;
  const promptTokens = prompt ?? estimateTokensFromText(messages.map(message => message.content).join("\n"));
  const completionTokens = completion ?? estimateTokensFromText(text);
  return buildChatUsage({ ...usage, promptTokens, completionTokens,
    totalTokens: estimated ? promptTokens + completionTokens : usage?.totalTokens ?? promptTokens + completionTokens,
    estimated: estimated || usage?.estimated || undefined });
}

// Retain only a potential delimiter suffix so ordinary text remains incremental.
export class ContentNormalizer {
  private pending = "";
  private thinking = false;
  constructor(private options: ProviderProfile["normalization"] = { strip_think: true, strip_fence: false }) {}
  push(text: string, final = false): string {
    this.pending += text;
    if (this.options.strip_fence && !final) return "";
    let output = "";
    if (!this.options.strip_think) { output = this.pending; this.pending = ""; }
    else {
      for (;;) {
        const marker = this.thinking ? "</think>" : "<think>";
        const at = this.pending.toLowerCase().indexOf(marker);
        if (at >= 0) {
          if (!this.thinking) output += this.pending.slice(0, at);
          this.pending = this.pending.slice(at + marker.length);
          this.thinking = !this.thinking;
          continue;
        }
        let retained = 0;
        if (!final) for (let size = 1; size < marker.length; size++) {
          if (this.pending.toLowerCase().endsWith(marker.slice(0, size))) retained = size;
        }
        if (!this.thinking) output += this.pending.slice(0, this.pending.length - retained);
        this.pending = retained ? this.pending.slice(-retained) : "";
        break;
      }
    }
    if (this.options.strip_fence && final) {
      const fence = /^\s*```(?:[^\r\n`]*\r?\n)?([\s\S]*?)```\s*$/.exec(output);
      if (fence) output = (fence[1] ?? "").replace(/\r?\n$/, "");
    }
    return output;
  }
}

export function normalizeContent(text: string, options?: ProviderProfile["normalization"]): string {
  return new ContentNormalizer(options).push(text, true);
}

export function gatewayError(message: string, type: string, code: string | number): { error: { message: string; type: string; code: string | number; param: null } } {
  return { error: { message, type, code, param: null } };
}
