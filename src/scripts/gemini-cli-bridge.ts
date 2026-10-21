import { spawn } from "node:child_process";
import process from "node:process";
import { parseAssistantPayloadText } from "../utils/assistant-output.js";
import { buildPrompt, extractTextContent } from "../utils/prompt.js";
import { resolveReasoningEffort } from "../utils/reasoning.js";
import { normalizeToolAlias, normalizeToolName } from "../utils/tools.js";

type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error";

interface GatewayMessage {
  role?: unknown;
  content?: unknown;
  name?: unknown;
  tool_call_id?: unknown;
}

interface GatewayToolDefinition {
  type?: unknown;
  function?: {
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
  };
}

interface GatewayRequest {
  prompt?: unknown;
  messages?: unknown;
  tools?: unknown;
  reasoningEffort?: unknown;
  metadata?: unknown;
}

interface JsonContract {
  output_text: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  finish_reason: FinishReason;
}

type AllowedTool = {
  name: string;
  description: string;
  parameters: unknown;
};

type ParsedToolCall = {
  id: string;
  name: string;
  arguments: string;
};

type GeminiBridgeArgs = {
  model: string;
};

export function parseGeminiBridgeArgs(argv: string[]): GeminiBridgeArgs {
  let model = "";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--model") {
      model = argv[i + 1] ?? "";
      i += 1;
    }
  }

  if (!model.trim()) {
    throw new Error("Missing required --model argument.");
  }

  return { model: model.trim() };
}

export function parseGatewayRequest(input: string): GatewayRequest {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }

  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Gemini bridge expected a JSON object on stdin.");
  }

  return parsed as GatewayRequest;
}

export function buildGeminiPrompt(request: GatewayRequest): string {
  const messages = normalizeMessages(request.messages);
  const prompt =
    typeof request.prompt === "string" && request.prompt.trim()
      ? request.prompt.trim()
      : buildPrompt(messages);
  const tools = extractAllowedTools(request.tools);
  const metadata =
    request.metadata && typeof request.metadata === "object" && !Array.isArray(request.metadata)
      ? (request.metadata as Record<string, unknown>)
      : {};
  const rawToolChoice = metadata.tool_choice;
  const forcedToolName = extractForcedToolName(rawToolChoice);
  const toolCatalogJson = JSON.stringify(tools, null, 2);
  const toolNames = tools.map((tool) => tool.name).join(", ");
  const instructions = [
    "You are connected through an OpenAI-compatible gateway.",
    "Return exactly one raw JSON object with keys output_text, optional tool_calls, and finish_reason.",
    "Never wrap the JSON in markdown, commentary, or code fences.",
    tools.length > 0
      ? "The tools listed in AVAILABLE_TOOLS_JSON are the only tools you may call in this turn."
      : "No tools are available in this turn. Respond directly to the user.",
    tools.length > 0
      ? "Do not claim that tools are unavailable when AVAILABLE_TOOLS_JSON is non-empty."
      : "Do not invent tool calls.",
    "TOOL messages are outputs from previous tool calls.",
    "If the existing TOOL outputs are sufficient, synthesize the final answer instead of calling another tool.",
    forcedToolName
      ? `tool_choice is set. You MUST call exactly this function name: ${forcedToolName}.`
      : "Use tools only when they are actually needed for external actions or data.",
    "When calling a tool, the tool name must exactly match one value from AVAILABLE_TOOL_NAMES.",
    "If you need a tool, return JSON in this shape:",
    '{"output_text":"","tool_calls":[{"id":"call_1","name":"tool_name","arguments":{"arg":"value"}}],"finish_reason":"tool_calls"}',
    'If no tool is needed, return JSON in this shape: {"output_text":"user-facing answer","finish_reason":"stop"}',
  ].join("\n");

  return [
    prompt,
    "",
    "AVAILABLE_TOOLS_JSON:",
    toolCatalogJson,
    "",
    "AVAILABLE_TOOL_NAMES:",
    toolNames || "(none)",
    "",
    instructions,
  ].join("\n");
}

export function parseGeminiStreamJsonOutput(
  rawOutput: string,
  toolsInput: unknown,
): JsonContract {
  const tools = extractAllowedTools(toolsInput);
  const toolNameResolver = createAllowedToolNameResolver(tools);
  const textChunks: string[] = [];
  const toolCalls: ParsedToolCall[] = [];
  const finishReasons: FinishReason[] = [];
  const trimmed = rawOutput.trim();

  if (!trimmed) {
    return { output_text: "", finish_reason: "stop" };
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let parsedAnyLine = false;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
      parsedAnyLine = true;
    } catch {
      continue;
    }

    const finishReason = collectFinishReason(parsed);
    if (finishReason) {
      finishReasons.push(finishReason);
    }

    toolCalls.push(...collectToolCalls(parsed, toolNameResolver));
    textChunks.push(...collectTextChunks(parsed));
  }

  const fallbackText = parsedAnyLine ? "" : trimmed;
  const combinedText = dedupeStrings([...textChunks]).join("\n").trim() || fallbackText;
  const parsedPayload = parseAssistantPayloadText(combinedText || trimmed);
  const combinedToolCalls = dedupeToolCalls([
    ...toolCalls,
    ...parsedPayload.toolCalls.map((call) => ({
      id: call.id,
      name: toolNameResolver(call.name),
      arguments: normalizeToolArguments(call.arguments),
    })),
  ]).filter((call) => call.name);

  const finishReason =
    parsedPayload.finishReason ??
    finishReasons[finishReasons.length - 1] ??
    (combinedToolCalls.length > 0 ? "tool_calls" : "stop");
  const outputText =
    combinedToolCalls.length > 0 ? "" : normalizeOutputText(parsedPayload.outputText || combinedText);

  return {
    output_text: outputText,
    tool_calls: combinedToolCalls.length > 0 ? combinedToolCalls : undefined,
    finish_reason: combinedToolCalls.length > 0 ? "tool_calls" : finishReason,
  };
}

async function main(): Promise<void> {
  const args = parseGeminiBridgeArgs(process.argv.slice(2));
  const stdin = await readStdin();
  const request = parseGatewayRequest(stdin);
  const prompt = buildGeminiPrompt(request);
  const rawOutput = await runGeminiCommand(args.model, prompt, request);
  const contract = parseGeminiStreamJsonOutput(rawOutput, request.tools);
  process.stdout.write(JSON.stringify(contract));
}

async function readStdin(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data);
    });
    process.stdin.on("error", reject);
  });
}

async function runGeminiCommand(
  model: string,
  prompt: string,
  request: GatewayRequest,
): Promise<string> {
  const args = ["--model", model, "--output-format", "stream-json", "--prompt", prompt];
  const child = spawn("gemini", args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });

  if (exitCode !== 0) {
    const reasoningEffort = resolveReasoningEffort(request) ?? "unset";
    throw new Error(
      [
        `gemini exited with code ${exitCode}.`,
        `model=${model}`,
        `reasoning_effort=${reasoningEffort}`,
        stderr.trim() ? `stderr: ${stderr.trim()}` : "",
        stdout.trim() ? `stdout: ${stdout.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return stdout;
}

function normalizeMessages(raw: unknown): Array<{
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
}> {
  if (!Array.isArray(raw)) {
    return [];
  }

  const out: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    name?: string;
    tool_call_id?: string;
  }> = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const message = entry as GatewayMessage;
    const role = normalizeMessageRole(message.role);
    if (!role) {
      continue;
    }

    const content = normalizeMessageContent(message.content);
    out.push({
      role,
      content,
      name: typeof message.name === "string" ? message.name : undefined,
      tool_call_id: typeof message.tool_call_id === "string" ? message.tool_call_id : undefined,
    });
  }

  return out;
}

function normalizeMessageRole(
  value: unknown,
): "system" | "user" | "assistant" | "tool" | undefined {
  return value === "system" || value === "user" || value === "assistant" || value === "tool"
    ? value
    : undefined;
}

function normalizeMessageContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  const extracted = extractTextContent(value).trim();
  if (extracted) {
    return extracted;
  }

  if (value === null || value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractAllowedTools(raw: unknown): AllowedTool[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const out: AllowedTool[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const record = entry as GatewayToolDefinition;
    const fn =
      record.function && typeof record.function === "object" ? record.function : undefined;
    const name = typeof fn?.name === "string" ? fn.name.trim() : "";
    if (!name) {
      continue;
    }

    out.push({
      name,
      description:
        typeof fn?.description === "string" && fn.description.trim()
          ? fn.description.trim()
          : "Tool exposed by the OpenAI-compatible gateway.",
      parameters: fn?.parameters ?? { type: "object", additionalProperties: true },
    });
  }

  return out;
}

function extractForcedToolName(rawToolChoice: unknown): string {
  if (!rawToolChoice || typeof rawToolChoice !== "object" || Array.isArray(rawToolChoice)) {
    return "";
  }

  const record = rawToolChoice as Record<string, unknown>;
  if (record.type !== "function") {
    return "";
  }

  const fn =
    record.function && typeof record.function === "object"
      ? (record.function as Record<string, unknown>)
      : null;
  return typeof fn?.name === "string" ? fn.name.trim() : "";
}

function createAllowedToolNameResolver(tools: AllowedTool[]): (rawName: string) => string {
  const direct = new Map<string, string>();
  const aliases = new Map<string, string>();

  for (const tool of tools) {
    const normalized = normalizeToolName(tool.name);
    direct.set(normalized, tool.name);
    aliases.set(normalizeToolAlias(tool.name), tool.name);
  }

  return (rawName: string): string => {
    const trimmed = rawName.trim();
    if (!trimmed) {
      return "";
    }

    if (direct.size === 0) {
      return trimmed;
    }

    const directMatch = direct.get(normalizeToolName(trimmed));
    if (directMatch) {
      return directMatch;
    }

    const aliasMatch = aliases.get(normalizeToolAlias(trimmed));
    if (aliasMatch) {
      return aliasMatch;
    }

    if (tools.length === 1) {
      return tools[0]?.name ?? "";
    }

    return "";
  };
}

function collectFinishReason(value: unknown): FinishReason | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const candidate = record.finish_reason;
  return candidate === "stop" ||
    candidate === "tool_calls" ||
    candidate === "length" ||
    candidate === "error"
    ? candidate
    : undefined;
}

function collectToolCalls(
  value: unknown,
  resolveToolName: (rawName: string) => string,
  seen = new Set<object>(),
  depth = 0,
): ParsedToolCall[] {
  if (depth > 10 || value === null || value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return dedupeToolCalls(
      value.flatMap((item) => collectToolCalls(item, resolveToolName, seen, depth + 1)),
    );
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  const out: ParsedToolCall[] = [];
  const directCall = normalizeToolCallRecord(record, resolveToolName, out.length);
  if (directCall) {
    out.push(directCall);
  }

  const nestedCandidates = [
    record.tool_calls,
    record.toolCalls,
    record.function_calls,
    record.functionCalls,
    record.calls,
    record.tool_call,
    record.toolCall,
    record.function_call,
    record.functionCall,
    record.message,
    record.content,
    record.candidates,
    record.parts,
  ];

  for (const candidate of nestedCandidates) {
    out.push(...collectToolCalls(candidate, resolveToolName, seen, depth + 1));
  }

  return dedupeToolCalls(out);
}

function normalizeToolCallRecord(
  record: Record<string, unknown>,
  resolveToolName: (rawName: string) => string,
  index: number,
): ParsedToolCall | null {
  const nested =
    record.functionCall && typeof record.functionCall === "object"
      ? (record.functionCall as Record<string, unknown>)
      : record.function_call && typeof record.function_call === "object"
        ? (record.function_call as Record<string, unknown>)
        : record.function && typeof record.function === "object"
          ? (record.function as Record<string, unknown>)
          : null;
  const rawName = firstNonEmptyString(
    record.name,
    record.tool_name,
    record.toolName,
    nested?.name,
  );
  if (!rawName) {
    return null;
  }

  const resolvedName = resolveToolName(rawName);
  if (!resolvedName) {
    return null;
  }

  const type = typeof record.type === "string" ? record.type : "";
  const hasToolShape =
    type === "tool_use" ||
    type === "function" ||
    type === "function_call" ||
    type === "custom_tool_call" ||
    "arguments" in record ||
    "args" in record ||
    "parameters" in record ||
    "input" in record ||
    nested !== null;

  if (!hasToolShape) {
    return null;
  }

  return {
    id:
      firstNonEmptyString(record.id, record.call_id, record.tool_id, record.toolId, nested?.id) ??
      `call_${index + 1}`,
    name: resolvedName,
    arguments: normalizeToolArguments(
      firstDefined(
        record.arguments,
        record.args,
        record.parameters,
        record.input,
        nested?.arguments,
        nested?.args,
        nested?.parameters,
        nested?.input,
      ) ?? {},
    ),
  };
}

function normalizeToolArguments(value: unknown): string {
  if (value === null || value === undefined) {
    return "{}";
  }

  if (typeof value === "string") {
    let trimmed = value.trim();
    if (!trimmed) {
      return "{}";
    }

    if (trimmed.startsWith("```json")) {
      trimmed = trimmed.replace(/^```json\s*/i, "").replace(/\s*```$/, "").trim();
    } else if (trimmed.startsWith("```")) {
      trimmed = trimmed.replace(/^```\s*/, "").replace(/\s*```$/, "").trim();
    }

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.stringify(sanitizeValue(JSON.parse(trimmed)));
      } catch {
        try {
          const repaired = trimmed
            .replace(/,\s*([}\]])/g, "$1")
            .replace(/\r/g, "\\r")
            .replace(/\n/g, "\\n")
            .replace(/\t/g, "\\t");
          return JSON.stringify(sanitizeValue(JSON.parse(repaired)));
        } catch {
          return trimmed;
        }
      }
    }

    return trimmed;
  }

  try {
    return JSON.stringify(sanitizeValue(value));
  } catch {
    return "{}";
  }
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 20) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [rawKey, rawVal] of Object.entries(value as Record<string, unknown>)) {
    const trimmedKey = rawKey.trim();
    out[trimmedKey || rawKey] = sanitizeValue(rawVal, depth + 1);
  }
  return out;
}

function collectTextChunks(value: unknown, seen = new Set<object>(), depth = 0): string[] {
  if (depth > 10 || value === null || value === undefined) {
    return [];
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (Array.isArray(value)) {
    return dedupeStrings(
      value.flatMap((item) => collectTextChunks(item, seen, depth + 1)),
    );
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  const out = [
    record.output_text,
    record.text,
    record.response,
    record.content,
    record.message,
  ].flatMap((item) => collectTextChunks(item, seen, depth + 1));

  if (Array.isArray(record.parts)) {
    out.push(...record.parts.flatMap((part) => collectTextChunks(part, seen, depth + 1)));
  }

  if (Array.isArray(record.candidates)) {
    out.push(...record.candidates.flatMap((candidate) => collectTextChunks(candidate, seen, depth + 1)));
  }

  return dedupeStrings(out);
}

function normalizeOutputText(value: string): string {
  return value.trim();
}

function dedupeStrings(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function dedupeToolCalls(toolCalls: ParsedToolCall[]): ParsedToolCall[] {
  const out: ParsedToolCall[] = [];
  const seen = new Set<string>();
  const seenIds = new Set<string>();

  for (const call of toolCalls) {
    const name = call.name.trim();
    if (!name) {
      continue;
    }

    const requestedId = call.id.trim() || `call_${out.length + 1}`;
    const dedupeKey = `${requestedId}\u0000${name}\u0000${call.arguments.trim() || "{}"}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    const id =
      requestedId && !seenIds.has(requestedId) ? requestedId : `call_${out.length + 1}`;
    const normalized: ParsedToolCall = {
      id,
      name,
      arguments: call.arguments.trim() || "{}",
    };
    seen.add(dedupeKey);
    seenIds.add(normalized.id);
    out.push(normalized);
  }

  return out;
}

function firstDefined(...candidates: unknown[]): unknown {
  for (const candidate of candidates) {
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
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

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
