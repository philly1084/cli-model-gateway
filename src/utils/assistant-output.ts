import type { ProviderResult, ProviderToolCall } from "../types";
import { extractTextContent } from "./prompt";
import { strictToolCalls, strictToolArguments } from "./tool-contract.js";

type AssistantFinishReason = ProviderResult["finishReason"];

type ParsedAssistantPayload = {
  outputText: string;
  toolCalls: ProviderToolCall[];
  finishReason?: AssistantFinishReason;
  recognized: boolean;
  synthetic: boolean;
};

const PLACEHOLDER_OUTPUTS = [
  "<assistant reply>",
  "[assistant reply]",
  "assistant reply",
  "reply to the user directly.",
  "__example_final_answer__",
  "provide your actual helpful response here.",
] as const;

const LEGACY_INVALID_ASSISTANT_SUBSTRINGS = [
  "completed the request, but the final answer could not be synthesized from the model response",
  "i completed the request, but the final answer could not be synthesized from the model response",
  "final answer could not be synthesized from the model response",
  "could not be synthesized from the model response",
] as const;

const WRAPPER_KEYS = new Set([
  "arguments",
  "args",
  "call_id",
  "content",
  "finish_reason",
  "function",
  "id",
  "input",
  "message",
  "name",
  "output_text",
  "parameters",
  "response",
  "role",
  "text",
  "toolId",
  "tool_calls",
  "tool_id",
  "type",
]);

export function normalizeAssistantResult(result: ProviderResult): ProviderResult {
  const parsed = parseAssistantPayloadText(result.outputText);
  const toolCalls = dedupeToolCalls([...result.toolCalls, ...parsed.toolCalls]);

  return {
    ...result,
    outputText: parsed.outputText,
    toolCalls,
    finishReason:
      parsed.finishReason ?? (toolCalls.length > 0 ? "tool_calls" : result.finishReason),
  };
}

export function parseAssistantPayloadText(text: string): ParsedAssistantPayload {
  const trimmed = text.trim();
  if (!trimmed) {
    return emptyParsedAssistantPayload();
  }

  if (isAssistantPlaceholder(trimmed)) {
    return {
      outputText: "",
      toolCalls: [],
      recognized: true,
      synthetic: true,
    };
  }

  for (const candidate of extractJsonTextCandidates(trimmed)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    const normalized = normalizeAssistantPayloadValue(parsed, 0);
    if (normalized.recognized) {
      return normalized;
    }
  }

  return {
    outputText: trimmed,
    toolCalls: [],
    recognized: false,
    synthetic: false,
  };
}

export function isSyntheticAssistantOutputText(text: string): boolean {
  const parsed = parseAssistantPayloadText(text);
  if (parsed.synthetic) {
    return true;
  }

  const normalizedOutput = normalizeWhitespace(parsed.outputText);
  return LEGACY_INVALID_ASSISTANT_SUBSTRINGS.some((fragment) =>
    normalizedOutput.includes(fragment),
  );
}

function normalizeAssistantPayloadValue(value: unknown, depth: number): ParsedAssistantPayload {
  if (depth > 6) {
    return emptyParsedAssistantPayload();
  }

  if (typeof value === "string") {
    return parseAssistantPayloadText(value);
  }

  if (Array.isArray(value)) {
    const textParts: string[] = [];
    const toolCalls: ProviderToolCall[] = [];
    let finishReason: AssistantFinishReason | undefined;
    let recognized = false;
    let synthetic = false;

    for (const item of value) {
      const parsed = normalizeAssistantPayloadValue(item, depth + 1);
      if (!parsed.recognized) {
        continue;
      }
      recognized = true;
      synthetic ||= parsed.synthetic;
      finishReason = parsed.finishReason ?? finishReason;
      if (parsed.outputText) {
        textParts.push(parsed.outputText);
      }
      toolCalls.push(...parsed.toolCalls);
    }

    return {
      outputText: textParts.join("\n\n").trim(),
      toolCalls: dedupeToolCalls(toolCalls),
      finishReason,
      recognized,
      synthetic,
    };
  }

  if (!value || typeof value !== "object") {
    return emptyParsedAssistantPayload();
  }

  const record = value as Record<string, unknown>;
  const directToolCall = normalizeDirectToolCall(record);
  const nestedToolCalls = normalizeToolCallArray(record.tool_calls);
  const hasContentKeys =
    "output_text" in record ||
    "text" in record ||
    "content" in record ||
    "message" in record ||
    "response" in record;
  const looksLikeWrapper =
    directToolCall !== null ||
    nestedToolCalls.length > 0 ||
    "finish_reason" in record ||
    ("type" in record && typeof record.type === "string" && isToolLikeType(record.type)) ||
    (hasContentKeys && Object.keys(record).every((key) => WRAPPER_KEYS.has(key)));

  if (!looksLikeWrapper) {
    return emptyParsedAssistantPayload();
  }

  const textParts: string[] = [];
  const toolCalls: ProviderToolCall[] = [];
  let synthetic = false;

  if (directToolCall) {
    toolCalls.push(directToolCall);
  }
  toolCalls.push(...nestedToolCalls);

  for (const candidate of [
    record.output_text,
    record.text,
    normalizeContentCandidate(record.content),
    record.response,
    record.message,
  ]) {
    const parsed = normalizeNestedTextCandidate(candidate, depth + 1);
    synthetic ||= parsed.synthetic;
    if (parsed.outputText) {
      textParts.push(parsed.outputText);
    }
    toolCalls.push(...parsed.toolCalls);
  }

  return {
    outputText: textParts.join("\n\n").trim(),
    toolCalls: dedupeToolCalls(toolCalls),
    finishReason: normalizeFinishReason(record.finish_reason),
    recognized: true,
    synthetic,
  };
}

function normalizeNestedTextCandidate(
  value: unknown,
  depth: number,
): Omit<ParsedAssistantPayload, "recognized" | "finishReason"> {
  if (depth > 6 || value === null || value === undefined) {
    return { outputText: "", toolCalls: [], synthetic: false };
  }

  if (typeof value === "string") {
    const parsed = parseAssistantPayloadText(value);
    return {
      outputText: parsed.outputText,
      toolCalls: parsed.toolCalls,
      synthetic: parsed.synthetic,
    };
  }

  if (Array.isArray(value) || typeof value === "object") {
    const parsed = normalizeAssistantPayloadValue(value, depth);
    if (parsed.recognized) {
      return {
        outputText: parsed.outputText,
        toolCalls: parsed.toolCalls,
        synthetic: parsed.synthetic,
      };
    }

    const extracted = extractTextContent(value).trim();
    if (!extracted) {
      return { outputText: "", toolCalls: [], synthetic: false };
    }

    const fallback = parseAssistantPayloadText(extracted);
    return {
      outputText: fallback.outputText,
      toolCalls: fallback.toolCalls,
      synthetic: fallback.synthetic,
    };
  }

  return { outputText: "", toolCalls: [], synthetic: false };
}

function normalizeContentCandidate(value: unknown): unknown {
  if (typeof value === "string") {
    return value;
  }
  const extracted = extractTextContent(value).trim();
  return extracted || value;
}

function normalizeDirectToolCall(record: Record<string, unknown>): ProviderToolCall | null {
  const fn =
    record.function && typeof record.function === "object"
      ? (record.function as Record<string, unknown>)
      : undefined;
  const name = firstNonEmptyString(record.name, fn?.name);
  const type = typeof record.type === "string" ? record.type : "";

  if (!name) {
    return null;
  }

  const hasToolShape =
    isToolLikeType(type) ||
    "arguments" in record ||
    "parameters" in record ||
    "input" in record ||
    fn !== undefined;
  if (!hasToolShape) {
    return null;
  }

  return {
    id:
      firstNonEmptyString(record.id, record.call_id, record.tool_id, record.toolId) ??
      "",
    name,
    arguments: normalizeToolArguments(
      firstDefined(
        record.arguments,
        record.args,
        record.parameters,
        record.input,
        fn?.arguments,
        fn?.args,
        fn?.parameters,
      ),
    ),
  };
}

function normalizeToolCallArray(value: unknown): ProviderToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: ProviderToolCall[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const normalized = normalizeDirectToolCall(item as Record<string, unknown>);
    if (!normalized) {
      continue;
    }
    out.push({
      ...normalized,
      id: normalized.id,
    });
  }

  return strictToolCalls(out);
}

function normalizeToolArguments(value: unknown): string {
  return strictToolArguments(value);
}

function dedupeToolCalls(toolCalls: ProviderToolCall[]): ProviderToolCall[] {
  const out: ProviderToolCall[] = [];
  const seen = new Set<string>();

  for (const call of toolCalls) {
    const name = typeof call.name === "string" ? call.name.trim() : "";
    if (!name) {
      continue;
    }
    const id = typeof call.id === "string" && call.id.trim() ? call.id.trim() : "";
    const args = typeof call.arguments === "string" ? call.arguments : "{}";
    const key = `${id}|${name}|${args}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      id,
      name,
      arguments: args,
    });
  }

  return strictToolCalls(out);
}

function extractJsonTextCandidates(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    out.push(trimmed);
  };

  push(input);

  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(input)) !== null) {
    push(match[1] ?? "");
  }

  const firstBrace = input.indexOf("{");
  const lastBrace = input.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    push(input.slice(firstBrace, lastBrace + 1));
  }

  return out;
}

function isToolLikeType(value: string): boolean {
  return value === "function" || value === "function_call" || value === "custom_tool_call";
}

function normalizeFinishReason(value: unknown): AssistantFinishReason | undefined {
  return value === "stop" ||
    value === "tool_calls" ||
    value === "length" ||
    value === "error"
    ? value
    : undefined;
}

function isAssistantPlaceholder(value: string): boolean {
  return PLACEHOLDER_OUTPUTS.includes(normalizeWhitespace(value) as (typeof PLACEHOLDER_OUTPUTS)[number]);
}

function normalizeWhitespace(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function firstNonEmptyString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function firstDefined(...candidates: unknown[]): unknown {
  for (const candidate of candidates) {
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

function emptyParsedAssistantPayload(): ParsedAssistantPayload {
  return {
    outputText: "",
    toolCalls: [],
    recognized: false,
    synthetic: false,
  };
}
