import type { ProviderStreamEvent, ProviderToolCall, ProviderResult } from "../types";
import { normalizeProviderUsage } from "./usage";

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid provider stream object");
  return value as Record<string, unknown>;
};

// Pull-based, bounded SSE decoding. Tools are released only after a complete valid turn.
export async function* parseOpenAiStream(response: Response, signal: AbortSignal, onToolSignature?: (call: ProviderToolCall, signature: string) => void): AsyncGenerator<ProviderStreamEvent> {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw Error("Provider did not return an SSE stream");
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "", data: string[] = [], bytes = 0, text = "", reasoning = "", model = "";
  let finish: ProviderResult["finishReason"] | undefined, done = false, usage: ProviderResult["usage"];
  const calls: ProviderToolCall[] = [];
  const signatures = new Map<number, string>();
  function* event(payload: string): Generator<ProviderStreamEvent> {
    if (done) throw Error("Data after provider completion");
    if (payload === "[DONE]") { if (!finish) throw Error("Provider stream missing finish reason"); done = true; return; }
    const chunk = object(JSON.parse(payload));
    if (chunk.error) throw Error("Provider stream reported an error");
    if (typeof chunk.model === "string") { if (model && model !== chunk.model) throw Error("Provider model changed mid-stream"); model = chunk.model; }
    if (chunk.usage) usage = normalizeProviderUsage(chunk.usage, "provider");
    if (!Array.isArray(chunk.choices)) throw Error("Invalid provider choices");
    if (chunk.choices.length === 0 && chunk.usage) return;
    if (finish || chunk.choices.length !== 1) throw Error("Unexpected provider choice or data after finish");
    const choice = object(chunk.choices[0]);
    if (choice.index !== undefined && choice.index !== 0) throw Error("Multiple provider choices unsupported");
    const delta = object(choice.delta ?? {});
    if (delta.content != null) {
      if (typeof delta.content !== "string" || text.length + delta.content.length > 262144) throw Error("Invalid or oversized provider text");
      text += delta.content; if (delta.content) yield { type: "output_text_delta", delta: delta.content };
    }
    const thought = delta.reasoning_content ?? delta.reasoning;
    if (thought != null) {
      if (typeof thought !== "string" || reasoning.length + thought.length > 262144) throw Error("Invalid or oversized provider reasoning");
      reasoning += thought; if (thought) yield { type: "reasoning_delta", delta: thought };
    }
    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls)) throw Error("Invalid provider tool calls");
      for (const item of delta.tool_calls) {
        const part = object(item); let index = part.index;
        // Gemini's OpenAI endpoint emits complete calls without an index. Only a
        // self-contained, uniquely identified call is safe to normalize this way.
        if (index === undefined) {
          const fn = object(part.function);
          if (typeof part.id !== "string" || !part.id || calls.some(c => c.id === part.id)
            || typeof fn.name !== "string" || !fn.name || typeof fn.arguments !== "string") throw Error("Unindexed provider tool fragment is ambiguous");
          object(JSON.parse(fn.arguments)); index = calls.length;
        }
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > calls.length || index >= 32) throw Error("Invalid provider tool index");
        if (part.type !== undefined && part.type !== "function") throw Error("Unsupported provider tool type");
        const call = calls[index] ??= { id: "", name: "", arguments: "" };
        if (part.id !== undefined) {
          if (typeof part.id !== "string" || (call.id && call.id !== part.id)) throw Error("Provider tool identity changed");
          call.id = part.id;
        }
        if (part.function !== undefined) {
          const fn = object(part.function);
          for (const key of ["name", "arguments"] as const) if (fn[key] !== undefined) {
            if (typeof fn[key] !== "string") throw Error("Invalid provider tool fragment");
            call[key] += fn[key];
          }
        }
        if (part.extra_content !== undefined) {
          const extra = object(part.extra_content);
          if (extra.google !== undefined) {
            const google = object(extra.google);
            if (google.thought_signature !== undefined) {
              const signature = google.thought_signature;
              if (typeof signature !== "string" || !signature || signature.length > 65536
                || (signatures.has(index) && signatures.get(index) !== signature)) throw Error("Invalid provider tool signature");
              signatures.set(index, signature);
            }
          }
        }
        if (call.id.length > 128 || call.name.length > 128 || call.arguments.length > 65536) throw Error("Provider tool exceeds limit");
      }
    }
    if (choice.finish_reason != null) {
      if (!["stop", "tool_calls", "length"].includes(String(choice.finish_reason))) throw Error("Provider stream failed");
      finish = choice.finish_reason === "stop" && calls.length ? "tool_calls" : choice.finish_reason as ProviderResult["finishReason"];
      if (calls.length && finish !== "tool_calls") throw Error("Incomplete provider tool call");
      if (!calls.length && finish === "tool_calls") throw Error("Missing provider tool call");
    }
  }
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read(); signal.throwIfAborted();
      if (chunk.done) { pending += decoder.decode(); break; }
      bytes += chunk.value.byteLength; if (bytes > 2097152) throw Error("Provider stream exceeds limit");
      pending += decoder.decode(chunk.value, { stream: true });
      let at: number;
      while ((at = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, at).replace(/\r$/, ""); pending = pending.slice(at + 1);
        if (!line) { if (data.length) { yield* event(data.join("\n")); data = []; } }
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (pending.length > 262144) throw Error("Provider SSE line exceeds limit");
      if (done) break;
    }
    if (!done || !finish) throw Error("Incomplete provider stream");
    const ids = new Set<string>();
    for (const call of calls) {
      if (!call.id || !call.name || ids.has(call.id)) throw Error("Invalid provider tool identity");
      object(JSON.parse(call.arguments)); ids.add(call.id);
    }
    signal.throwIfAborted();
    for (const [index, call] of calls.entries()) {
      const signature = signatures.get(index); if (signature) onToolSignature?.(call, signature);
      yield { type: "tool_call", toolCall: call };
    }
    yield { type: "done", finishReason: finish, outputText: text, reasoningText: reasoning || undefined, usage };
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}