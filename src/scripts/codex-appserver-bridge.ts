import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeToolName } from "../utils/tools";
import { resolveReasoningEffort } from "../utils/reasoning";
import { getCodexExecutableCandidates } from "../utils/runtime-template-vars";

interface GatewayMessage {
  role?: unknown;
  content?: unknown;
}

interface GatewayRequest {
  prompt?: unknown;
  messages?: unknown;
  tools?: unknown;
  stream?: unknown;
  requestKind?: unknown;
  reasoningEffort?: unknown;
  metadata?: unknown;
}

interface DynamicToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    data?: unknown;
  };
}

interface JsonRpcRequest {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

type FinishReason = "stop" | "tool_calls" | "length" | "error";

interface JsonContract {
  output_text: string;
  reasoning?: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  finish_reason: FinishReason;
}

interface ImageGenerationItem {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

class JsonRpcStdioClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly queue: unknown[] = [];
  private readonly waiters: Array<(value: unknown | null) => void> = [];
  private readonly child: ReturnType<typeof spawn>;
  private readonly decorateError: (error: Error) => Error;
  private buffer = "";
  private ended = false;

  constructor(child: ReturnType<typeof spawn>, decorateError?: (error: Error) => Error) {
    this.child = child;
    this.decorateError = decorateError ?? ((error) => error);

    if (!child.stdout || !child.stdin) {
      throw new Error("codex app-server stdio streams are unavailable.");
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.buffer += data;
      this.drainBuffer();
    });

    child.on("error", (error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      this.rejectAll(this.decorateError(err));
    });

    child.on("close", () => {
      this.ended = true;
      this.rejectAll(this.decorateError(new Error("codex app-server process closed.")));
    });
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    const payload =
      params === undefined
        ? { jsonrpc: "2.0", method }
        : { jsonrpc: "2.0", method, params };
    this.send(payload);
  }

  respond(id: unknown, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  async nextMessage(timeoutMs: number): Promise<unknown | null> {
    if (this.queue.length > 0) {
      return this.queue.shift() ?? null;
    }
    if (this.ended) {
      return null;
    }

    return await new Promise<unknown | null>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(resolve);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        resolve(null);
      }, timeoutMs);
      this.waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  private send(payload: unknown): void {
    if (!this.child.stdin) {
      throw new Error("codex app-server stdin is unavailable.");
    }

    // codex app-server stdio transport expects one JSON-RPC message per line.
    const line = `${JSON.stringify(payload)}\n`;
    this.child.stdin.write(line, "utf8");
  }

  private drainBuffer(): void {
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const rawLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const line = rawLine.replace(/\r$/, "").trim();
      if (!line) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const maybeResponse = parsed as JsonRpcResponse;
      if (
        typeof maybeResponse.id === "number" &&
        (Object.prototype.hasOwnProperty.call(maybeResponse, "result") ||
          Object.prototype.hasOwnProperty.call(maybeResponse, "error"))
      ) {
        const pending = this.pending.get(maybeResponse.id);
        if (!pending) {
          continue;
        }
        this.pending.delete(maybeResponse.id);
        clearTimeout(pending.timer);
        if (maybeResponse.error) {
          const message =
            typeof maybeResponse.error.message === "string"
              ? maybeResponse.error.message
              : "Unknown JSON-RPC error.";
          pending.reject(new Error(message));
        } else {
          pending.resolve(maybeResponse.result);
        }
        continue;
      }

      this.pushQueue(parsed);
    }
  }

  private pushQueue(value: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(value);
      return;
    }
    this.queue.push(value);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.(null);
    }
  }
}

function normalizeValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function writeDebugLog(label: string, payload?: Record<string, unknown>): void {
  const suffix = payload ? ` ${JSON.stringify(payload)}` : "";
  process.stderr.write(`[codex-appserver-bridge] ${label}${suffix}\n`);
}

function summarizeRpcParams(params?: Record<string, unknown>): Record<string, unknown> {
  if (!params) {
    return {};
  }

  const summary: Record<string, unknown> = {
    keys: Object.keys(params).slice(0, 12),
  };
  if (typeof params.threadId === "string") {
    summary.threadId = params.threadId;
  }
  if (typeof params.turnId === "string") {
    summary.turnId = params.turnId;
  }
  if (typeof params.callId === "string") {
    summary.callId = params.callId;
  }
  if (typeof params.tool === "string") {
    summary.tool = params.tool;
  }
  if (typeof params.willRetry === "boolean") {
    summary.willRetry = params.willRetry;
  }

  const item = isObjectRecord(params.item) ? params.item : undefined;
  if (item) {
    if (typeof item.type === "string") {
      summary.itemType = item.type;
    }
    if (typeof item.kind === "string") {
      summary.itemKind = item.kind;
    }
    if (typeof item.role === "string") {
      summary.itemRole = item.role;
    }
    if (Array.isArray(item.content)) {
      summary.contentTypes = item.content
        .filter((entry): entry is Record<string, unknown> => isObjectRecord(entry))
        .map((entry) => (typeof entry.type === "string" ? entry.type : ""))
        .filter(Boolean)
        .slice(0, 12);
    }
  }

  const turn = isObjectRecord(params.turn) ? params.turn : undefined;
  if (turn) {
    if (typeof turn.id === "string") {
      summary.turnObjectId = turn.id;
    }
    if (typeof turn.status === "string") {
      summary.turnStatus = turn.status;
    }
  }

  return summary;
}

function computeMonotonicDelta(previousText: string, nextText: string): string {
  if (!nextText) {
    return "";
  }
  if (!previousText) {
    return nextText;
  }
  if (!nextText.startsWith(previousText)) {
    return "";
  }
  return nextText.slice(previousText.length);
}

function parseRequest(input: string): GatewayRequest {
  return JSON.parse(input) as GatewayRequest;
}

function buildMessageText(request: GatewayRequest): string {
  const promptText =
    typeof request.prompt === "string" && request.prompt.trim()
      ? request.prompt.trim()
      : "";

  const rawMessages = Array.isArray(request.messages) ? request.messages : [];
  const messages = rawMessages as GatewayMessage[];
  return (
    promptText ||
    messages
      .map((msg) => {
        const role =
          typeof msg.role === "string" && msg.role.trim() ? msg.role : "user";
        return `${role.toUpperCase()}:\n${normalizeValue(msg.content)}`;
      })
      .join("\n\n")
  );
}

function getRequestMetadata(request: GatewayRequest): Record<string, unknown> | undefined {
  return isObjectRecord(request.metadata)
    ? (request.metadata as Record<string, unknown>)
    : undefined;
}

function findRequestMetadataValue(
  request: GatewayRequest,
  keys: string[],
): unknown {
  const metadata = getRequestMetadata(request);
  if (!metadata) {
    return undefined;
  }

  for (const key of keys) {
    if (metadata[key] !== undefined) {
      return metadata[key];
    }
  }

  const nestedMetadata = isObjectRecord(metadata.metadata)
    ? (metadata.metadata as Record<string, unknown>)
    : undefined;
  if (!nestedMetadata) {
    return undefined;
  }

  for (const key of keys) {
    if (nestedMetadata[key] !== undefined) {
      return nestedMetadata[key];
    }
  }

  return undefined;
}

function formatImageOptionValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => formatImageOptionValue(entry))
      .filter(Boolean)
      .join(", ");
  }
  if (!isObjectRecord(value)) {
    return "";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function collectImageOptionLines(request: GatewayRequest): string[] {
  const optionDefs: Array<{ label: string; keys: string[] }> = [
    { label: "Image count", keys: ["n"] },
    { label: "Size", keys: ["size"] },
    { label: "Quality", keys: ["quality"] },
    { label: "Style", keys: ["style"] },
    { label: "Background", keys: ["background"] },
    { label: "Response format", keys: ["response_format", "responseFormat"] },
    { label: "Output format", keys: ["output_format", "outputFormat"] },
  ];

  const lines: string[] = [];
  for (const optionDef of optionDefs) {
    const value = formatImageOptionValue(findRequestMetadataValue(request, optionDef.keys));
    if (value) {
      lines.push(`- ${optionDef.label}: ${value}`);
    }
  }
  return lines;
}

function parseRequestedImageCount(request: GatewayRequest): number {
  const value = findRequestMetadataValue(request, ["n", "count", "image_count", "imageCount"]);
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(Math.max(Math.floor(value), 1), 10);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.min(Math.max(parsed, 1), 10);
    }
  }
  return 1;
}

export function buildImageGenerationPrompt(request: GatewayRequest): string {
  const messageText = buildMessageText(request).trim();
  const optionLines = collectImageOptionLines(request);
  const imagegenInvocation = messageText.toLowerCase().includes("$imagegen")
    ? ""
    : "$imagegen";

  return [
    imagegenInvocation,
    "Use Codex CLI's built-in image generation or editing workflow for this request.",
    "Generate or edit the image directly instead of explaining how to do it.",
    optionLines.length > 0 ? "Requested image options:" : "",
    ...optionLines,
    "",
    "User request:",
    messageText || "Generate the requested image.",
    "",
    "You are connected through an OpenAI-compatible gateway images endpoint.",
    "Respond with raw JSON only in one of these shapes:",
    '{"data":[{"b64_json":"<base64>","revised_prompt":"optional"}]}',
    '{"data":[{"url":"<actual generated image URL returned by the image tool>","revised_prompt":"optional"}]}',
    "Never return placeholder URLs, sample domains, documentation examples, or a URL you invented.",
    "Only include a url after an image tool or provider actually returned that URL.",
    "Do not wrap the JSON in markdown.",
    "Do not return explanatory prose before or after the JSON.",
  ]
    .filter(Boolean)
    .join("\n");
}

function extractAllowedToolNames(request: GatewayRequest): Map<string, string> {
  const out = new Map<string, string>();
  const tools = Array.isArray(request.tools) ? request.tools : [];
  for (const item of tools) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const fn =
      record.function && typeof record.function === "object"
        ? (record.function as Record<string, unknown>)
        : null;
    const name = fn && typeof fn.name === "string" ? fn.name.trim() : "";
    if (name) {
      out.set(normalizeToolName(name), name);
    }
  }
  return out;
}

function extractDynamicTools(request: GatewayRequest): DynamicToolSpec[] {
  const out: DynamicToolSpec[] = [];
  const tools = Array.isArray(request.tools) ? request.tools : [];

  for (const item of tools) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const fn =
      record.function && typeof record.function === "object"
        ? (record.function as Record<string, unknown>)
        : null;
    if (!fn) {
      continue;
    }

    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!name) {
      continue;
    }

    const description =
      typeof fn.description === "string" && fn.description.trim()
        ? fn.description.trim()
        : "Tool exposed by AVAILABLE_TOOLS_JSON.";
    const inputSchema =
      Object.prototype.hasOwnProperty.call(fn, "parameters") &&
      fn.parameters !== undefined
        ? fn.parameters
        : {
            type: "object",
            additionalProperties: true,
          };

    out.push({
      name,
      description,
      inputSchema,
    });
  }

  return out;
}

export function buildPrompt(request: GatewayRequest): string {
  const messageText = buildMessageText(request);
  if (request.requestKind === "images_generations") {
    return buildImageGenerationPrompt(request);
  }

  const tools = Array.isArray(request.tools) ? request.tools : [];
  if (tools.length === 0) {
    if (request.stream === true) {
      return messageText;
    }

    return [
      messageText,
      "",
      "You are connected through an OpenAI-compatible gateway.",
      "Return raw JSON only with keys output_text, optional reasoning, and finish_reason.",
      "When possible, include a concise public reasoning summary in reasoning.",
      "Do not reveal private chain-of-thought; use reasoning only for a short high-level summary.",
      'If no tool is needed, return raw JSON only in this shape: {"output_text":"user-facing answer","reasoning":"brief public reasoning summary","finish_reason":"stop"}',
      "Do not wrap the JSON in markdown or explanatory prose.",
    ].join("\n");
  }

  const metadata =
    request.metadata && typeof request.metadata === "object"
      ? (request.metadata as Record<string, unknown>)
      : {};
  const toolChoice = metadata.tool_choice;
  const forcedToolName =
    toolChoice &&
    typeof toolChoice === "object" &&
    (toolChoice as Record<string, unknown>).type === "function" &&
    (toolChoice as Record<string, unknown>).function &&
    typeof (toolChoice as Record<string, unknown>).function === "object" &&
    typeof ((toolChoice as Record<string, unknown>).function as Record<string, unknown>)
      .name === "string"
      ? String(
          ((toolChoice as Record<string, unknown>).function as Record<string, unknown>)
            .name,
        )
      : undefined;

  const toolJson = JSON.stringify(tools, null, 2);
  const instruction = [
    "You are connected through an OpenAI-compatible gateway.",
    "The tools listed in AVAILABLE_TOOLS_JSON are the only tools you can use in this turn.",
    "Do not claim that tools are unavailable when AVAILABLE_TOOLS_JSON is non-empty.",
    "Do not use any internal tools, shell commands, filesystem access, web browsing, or MCP tools.",
    "TOOL: messages are outputs from previous tool calls.",
    "When TOOL: messages are present and no more tools are needed, synthesize the final answer for the user in output_text.",
    "Do not copy placeholder or example text into output_text.",
    "When possible, include a concise public reasoning summary in reasoning.",
    "Do not reveal private chain-of-thought; use reasoning only for a short high-level summary.",
    forcedToolName
      ? `tool_choice is set. You MUST call exactly this function name: ${forcedToolName}.`
      : "If the user asks to use/call a tool and AVAILABLE_TOOLS_JSON is non-empty, you MUST return a tool_calls response.",
    "If a tool is needed, return raw JSON only:",
    '{"output_text":"","reasoning":"brief public reasoning summary","tool_calls":[{"id":"call_1","name":"tool_name","arguments":{"arg":"value"}}],"finish_reason":"tool_calls"}',
    'If no tool is needed, return raw JSON only with a real user-facing answer in "output_text", optional reasoning, and "finish_reason":"stop".',
  ].join("\n");

  return [messageText, "", "AVAILABLE_TOOLS_JSON:", toolJson, "", instruction].join(
    "\n",
  );
}

function extractReasoningValue(record: Record<string, unknown>): unknown {
  const candidates = [
    record.reasoning,
    record.reasoning_content,
    record.reasoningContent,
    record.reasoning_text,
    record.reasoningText,
    record.summary,
    record.summary_text,
    record.summaryText,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

function asToolCallArguments(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function parseToolCallFromRawItem(item: unknown):
  | {
      id: string;
      name: string;
      arguments: string;
    }
  | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  const record = item as Record<string, unknown>;
  if (
    record.type !== "function_call" &&
    record.type !== "custom_tool_call"
  ) {
    return null;
  }

  const name =
    typeof record.name === "string" && record.name ? record.name : undefined;
  if (!name) {
    return null;
  }

  const id =
    typeof record.call_id === "string" && record.call_id
      ? record.call_id
      : `call_${randomUUID()}`;

  const argsRaw = record.type === "custom_tool_call" ? record.input : record.arguments;
  return {
    id,
    name,
    arguments: asToolCallArguments(argsRaw),
  };
}

function collectAssistantContentFromRawItem(item: unknown): {
  outputText: string;
  reasoningText: string;
} {
  if (!item || typeof item !== "object") {
    return { outputText: "", reasoningText: "" };
  }
  const record = item as Record<string, unknown>;
  if (record.type !== "message" || record.role !== "assistant") {
    return { outputText: "", reasoningText: "" };
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const outputParts: string[] = [];
  const reasoningParts: string[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const part = entry as Record<string, unknown>;
    const partType = typeof part.type === "string" ? part.type.toLowerCase() : "";
    const reasoningCandidate = collectReasoningText(part);
    const isReasoningPart =
      partType.includes("reason") ||
      partType.includes("summary") ||
      partType.includes("thinking");
    if (reasoningCandidate && isReasoningPart) {
      reasoningParts.push(reasoningCandidate);
      continue;
    }
    if (typeof part.text === "string" && part.text) {
      outputParts.push(part.text);
      continue;
    }
    if (typeof part.output_text === "string" && part.output_text) {
      outputParts.push(part.output_text);
      continue;
    }
    if (reasoningCandidate) {
      reasoningParts.push(reasoningCandidate);
    }
  }
  return {
    outputText: outputParts.join("\n").trim(),
    reasoningText: reasoningParts.join("\n").trim(),
  };
}

function collectAssistantContentFromThreadItem(item: unknown): {
  outputText: string;
  reasoningText: string;
} {
  if (!item || typeof item !== "object") {
    return { outputText: "", reasoningText: "" };
  }
  const record = item as Record<string, unknown>;
  if (record.type !== "agentMessage") {
    return { outputText: "", reasoningText: "" };
  }
  const partType = typeof record.kind === "string"
    ? record.kind.toLowerCase()
    : typeof record.subtype === "string"
      ? record.subtype.toLowerCase()
      : "";
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (partType.includes("reason") || partType.includes("summary") || partType.includes("thinking")) {
    return {
      outputText: "",
      reasoningText: text,
    };
  }
  return {
    outputText: text,
    reasoningText: collectReasoningText(record),
  };
}

export function collectImageGenerationItems(value: unknown): ImageGenerationItem[] {
  const out: ImageGenerationItem[] = [];
  const seenObjects = new WeakSet<object>();
  const seenImages = new Set<string>();

  const push = (item: ImageGenerationItem | null): void => {
    if (!item || (!item.url && !item.b64_json)) {
      return;
    }
    const key = item.url ? `url:${item.url}` : `b64:${item.b64_json}`;
    if (!key || seenImages.has(key)) {
      return;
    }
    seenImages.add(key);
    out.push(item);
  };

  const visit = (current: unknown, depth: number): void => {
    if (depth > 8 || current === null || current === undefined) {
      return;
    }

    if (typeof current === "string") {
      push(normalizeImageGenerationString(current));
      return;
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        visit(item, depth + 1);
      }
      return;
    }

    if (!isObjectRecord(current)) {
      return;
    }

    if (seenObjects.has(current)) {
      return;
    }
    seenObjects.add(current);

    push(normalizeImageGenerationRecord(current));

    for (const key of [
      "result",
      "image",
      "inline_data",
      "inlineData",
      "image_url",
      "imageUrl",
      "url",
      "data",
      "content",
      "contentItems",
      "candidates",
      "parts",
      "output",
      "outputs",
      "items",
      "attachments",
      "artifact",
      "artifacts",
      "file",
      "files",
    ]) {
      if (Object.prototype.hasOwnProperty.call(current, key)) {
        visit(current[key], depth + 1);
      }
    }
  };

  visit(value, 0);
  return out;
}

function normalizeImageGenerationRecord(record: Record<string, unknown>): ImageGenerationItem | null {
  const imageReference =
    record.url ??
      record.image_url ??
      record.imageUrl ??
      record.output_url ??
      record.outputUrl ??
      record.download_url ??
      record.downloadUrl ??
      record.uri;
  const url = normalizeImageGenerationUrl(imageReference);
  const localImage = normalizeLocalImageGenerationReference(imageReference);
  const directB64 = firstNonEmptyString(
    record.b64_json,
    record.b64_data,
    record.base64,
    record.base64_data,
    record.b64,
    record.image_base64,
    record.imageBase64,
  );
  const nestedResult =
    typeof record.result === "string"
      ? normalizeImageGenerationString(record.result)
      : null;
  const directB64Image = directB64 ? normalizeImageGenerationString(directB64) : null;
  const imageData =
    typeof record.data === "string" && isLikelyImageRecord(record)
      ? normalizeImageGenerationString(record.data)
      : null;
  const inlineImage = normalizeInlineImageGenerationValue(record.inline_data ?? record.inlineData);
  const b64 =
    localImage?.b64_json ??
    directB64Image?.b64_json ??
    normalizeBase64ImageData(directB64 ?? "") ??
    nestedResult?.b64_json ??
    imageData?.b64_json ??
    inlineImage?.b64_json;
  const revisedPrompt = firstNonEmptyString(record.revised_prompt, record.revisedPrompt);

  if (
    !url &&
    !b64 &&
    !directB64Image?.url &&
    !nestedResult?.url &&
    !imageData?.url &&
    !inlineImage?.url
  ) {
    return null;
  }

  const item: ImageGenerationItem = {};
  const finalUrl =
    url || directB64Image?.url || nestedResult?.url || imageData?.url || inlineImage?.url || "";
  if (finalUrl) {
    item.url = finalUrl;
  }
  if (b64) {
    item.b64_json = b64;
  }
  if (revisedPrompt) {
    item.revised_prompt = revisedPrompt;
  }
  return item;
}

function normalizeImageGenerationString(value: string): ImageGenerationItem | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const dataUrlMatch = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/i.exec(trimmed);
  if (dataUrlMatch && dataUrlMatch[1]) {
    return { b64_json: dataUrlMatch[1].replace(/\s/g, "") };
  }

  const localImage = normalizeLocalImageGenerationFileUrl(trimmed);
  if (localImage) {
    return localImage;
  }

  const markdownImageMatch = /!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/i.exec(trimmed);
  if (markdownImageMatch && markdownImageMatch[1]) {
    const url = normalizeImageGenerationUrl(markdownImageMatch[1]);
    if (url) {
      return { url };
    }
  }

  const url = normalizeImageGenerationUrl(trimmed);
  if (url) {
    return { url };
  }

  const b64 = normalizeBase64ImageData(trimmed);
  if (b64) {
    return { b64_json: b64 };
  }

  return null;
}

function normalizeImageGenerationUrl(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^https?:\/\//i.test(trimmed) || /[<>]/.test(trimmed)) {
      return "";
    }
    return isPlaceholderImageGenerationUrl(trimmed) ? "" : trimmed;
  }

  if (isObjectRecord(value)) {
    return normalizeImageGenerationUrl(value.url ?? value.image_url ?? value.imageUrl ?? value.uri);
  }

  return "";
}

function isPlaceholderImageGenerationUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
      hostname === "example.com" ||
      hostname === "www.example.com" ||
      hostname === "example.net" ||
      hostname === "www.example.net" ||
      hostname === "example.org" ||
      hostname === "www.example.org" ||
      hostname.endsWith(".example")
    );
  } catch {
    return true;
  }
}

function normalizeLocalImageGenerationReference(value: unknown): ImageGenerationItem | null {
  if (typeof value === "string") {
    return normalizeLocalImageGenerationFileUrl(value);
  }

  if (isObjectRecord(value)) {
    return normalizeLocalImageGenerationReference(value.url ?? value.image_url ?? value.imageUrl ?? value.uri);
  }

  return null;
}

function normalizeLocalImageGenerationFileUrl(value: string): ImageGenerationItem | null {
  if (!/^file:\/\//i.test(value.trim())) {
    return null;
  }

  try {
    return normalizeLocalImageGenerationFilePath(fileURLToPath(value));
  } catch {
    return null;
  }
}

function normalizeLocalImageGenerationFilePath(filePath: string): ImageGenerationItem | null {
  if (!isAllowedLocalImageGenerationPath(filePath)) {
    return null;
  }

  try {
    const bytes = readFileSync(filePath);
    if (bytes.length === 0 || bytes.length > 25 * 1024 * 1024 || !isSupportedImageBytes(bytes)) {
      return null;
    }
    return { b64_json: bytes.toString("base64") };
  } catch {
    return null;
  }
}

function isAllowedLocalImageGenerationPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/.codex/generated_images/") ||
    normalized.includes("/.codex/artifacts/")
  );
}

function collectRecentCodexGeneratedImageItems(startedAt: number): ImageGenerationItem[] {
  const root = getCodexGeneratedImagesRoot();
  if (!root || !existsSync(root)) {
    return [];
  }

  const candidates: Array<{ filePath: string; mtimeMs: number }> = [];
  collectRecentImageFileCandidates(root, startedAt, candidates, 0);
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const items: ImageGenerationItem[] = [];
  for (const candidate of candidates) {
    const item = normalizeLocalImageGenerationFilePath(candidate.filePath);
    if (item) {
      items.push(item);
    }
  }
  return items;
}

function getCodexGeneratedImagesRoot(): string {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return home ? join(home, ".codex", "generated_images") : "";
}

function collectRecentImageFileCandidates(
  directory: string,
  earliestMtimeMs: number,
  out: Array<{ filePath: string; mtimeMs: number }>,
  depth: number,
): void {
  if (depth > 4) {
    return;
  }

  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectRecentImageFileCandidates(filePath, earliestMtimeMs, out, depth + 1);
      continue;
    }
    if (!entry.isFile() || !/\.(?:png|jpe?g|webp|gif|svg)$/i.test(entry.name)) {
      continue;
    }
    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs >= earliestMtimeMs) {
        out.push({ filePath, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // Ignore files that disappear while scanning.
    }
  }
}

function isSupportedImageBytes(bytes: Buffer): boolean {
  return (
    bufferStartsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) ||
    bufferStartsWith(bytes, [0xff, 0xd8, 0xff]) ||
    bufferStartsWith(bytes, [0x47, 0x49, 0x46, 0x38]) ||
    (bufferStartsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP") ||
    bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase().startsWith("<svg")
  );
}

function bufferStartsWith(bytes: Buffer, prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function normalizeInlineImageGenerationValue(value: unknown): ImageGenerationItem | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return normalizeImageGenerationString(value);
  }

  if (!isObjectRecord(value)) {
    return null;
  }

  const data = firstNonEmptyString(
    value.data,
    value.b64_json,
    value.b64_data,
    value.base64,
    value.base64_data,
    value.b64,
  );
  if (!data) {
    return normalizeImageGenerationRecord(value);
  }

  return normalizeImageGenerationString(data) ?? { b64_json: data.replace(/\s/g, "") };
}

function normalizeBase64ImageData(value: string): string | null {
  const normalized = value.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]{100,}={0,2}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function isLikelyImageRecord(record: Record<string, unknown>): boolean {
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const mimeType = firstNonEmptyString(record.mime_type, record.mimeType)?.toLowerCase() ?? "";
  return (
    type.includes("image") ||
    mimeType.startsWith("image/") ||
    "inline_data" in record ||
    "inlineData" in record ||
    "b64_json" in record ||
    "b64_data" in record ||
    "base64" in record ||
    "base64_data" in record ||
    "image_base64" in record ||
    "imageBase64" in record ||
    "image_url" in record ||
    "imageUrl" in record ||
    "image" in record ||
    "result" in record
  );
}

function normalizeTextForComparison(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function collectReasoningText(value: unknown, depth = 0): string {
  if (depth > 6 || value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => collectReasoningText(entry, depth + 1))
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (!isObjectRecord(value)) {
    return "";
  }

  const record = value as Record<string, unknown>;
  const candidates = [
    extractReasoningValue(record),
    record.text,
    record.content,
  ];
  for (const candidate of candidates) {
    const extracted = collectReasoningText(candidate, depth + 1);
    if (extracted) {
      return extracted;
    }
  }

  return "";
}

function appendUniqueTextPart(textParts: string[], candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return false;
  }

  const previous = textParts[textParts.length - 1];
  if (
    typeof previous === "string" &&
    normalizeTextForComparison(previous) === normalizeTextForComparison(trimmed)
  ) {
    return false;
  }

  textParts.push(trimmed);
  return true;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isFinishReason(value: unknown): value is FinishReason {
  return (
    value === "stop" ||
    value === "tool_calls" ||
    value === "length" ||
    value === "error"
  );
}

function normalizeToolCallsFromContract(raw: unknown): NonNullable<JsonContract["tool_calls"]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }

  const calls: NonNullable<JsonContract["tool_calls"]> = [];
  for (const entry of raw) {
    if (!isObjectRecord(entry)) {
      continue;
    }

    const fn = isObjectRecord(entry.function) ? entry.function : undefined;
    const name =
      (typeof entry.name === "string" && entry.name) ||
      (fn && typeof fn.name === "string" ? fn.name : "");
    if (!name) {
      continue;
    }

    const id =
      typeof entry.id === "string" && entry.id
        ? entry.id
        : `call_${calls.length + 1}`;
    const argsRaw = entry.arguments ?? (fn ? fn.arguments : undefined);

    calls.push({
      id,
      name,
      arguments: asToolCallArguments(argsRaw),
    });
  }

  return calls;
}

function parseJsonContractFromText(raw: string): JsonContract | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const seen = new Set<string>();
  const queue: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== "string") {
      return;
    }
    const text = value.trim();
    if (!text || seen.has(text)) {
      return;
    }
    seen.add(text);
    queue.push(text);
  };
  const pushDerived = (value: string): void => {
    const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
    let match: RegExpExecArray | null;
    while ((match = fence.exec(value)) !== null) {
      push(match[1]);
    }

    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start !== -1 && end > start) {
      push(value.slice(start, end + 1));
    }
  };
  const isContractObject = (value: Record<string, unknown>): boolean => {
    return (
      "output_text" in value ||
      "tool_calls" in value ||
      "finish_reason" in value ||
      "text" in value ||
      "content" in value
    );
  };
  const toContract = (value: Record<string, unknown>): JsonContract | null => {
    if (!isContractObject(value)) {
      return null;
    }

    const toolCalls = normalizeToolCallsFromContract(value.tool_calls);
    const outputText =
      typeof value.output_text === "string"
        ? value.output_text
        : typeof value.text === "string"
          ? value.text
          : typeof value.content === "string"
            ? value.content
            : "";
    const finishReason: FinishReason = isFinishReason(value.finish_reason)
      ? value.finish_reason
      : toolCalls.length > 0
        ? "tool_calls"
        : "stop";

    return {
      output_text: outputText.trim(),
      reasoning: collectReasoningText(extractReasoningValue(value)),
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      finish_reason: finishReason,
    };
  };

  push(trimmed);
  pushDerived(trimmed);

  let best: JsonContract | null = null;
  for (let i = 0; i < queue.length && i < 80; i += 1) {
    const current = queue[i];
    if (typeof current !== "string") {
      continue;
    }
    pushDerived(current);

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(current);
    } catch {
      continue;
    }
    if (!isObjectRecord(parsed)) {
      continue;
    }

    const contract = toContract(parsed);
    if (contract) {
      if (!best) {
        best = contract;
      }
      if (contract.output_text) {
        push(contract.output_text);
        pushDerived(contract.output_text);
      }
      if (contract.tool_calls && contract.tool_calls.length > 0) {
        return contract;
      }
    }

    if (typeof parsed.response === "string") {
      push(parsed.response);
      pushDerived(parsed.response);
    }
    const maybeMessage = parsed.message;
    if (isObjectRecord(maybeMessage) && typeof maybeMessage.content === "string") {
      push(maybeMessage.content);
      pushDerived(maybeMessage.content);
    }
  }

  return best;
}

function parseModelArg(argv: string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    const next = argv[i + 1];
    if (argv[i] === "--model" && typeof next === "string") {
      return next;
    }
  }
  const positional = argv.find((arg) => !arg.startsWith("-"));
  if (positional) {
    return positional;
  }
  if (
    typeof process.env.PROVIDER_MODEL === "string" &&
    process.env.PROVIDER_MODEL.trim()
  ) {
    return process.env.PROVIDER_MODEL.trim();
  }
  throw new Error("Missing model argument for codex-appserver-bridge.");
}

function parseTimeoutMs(): number {
  const raw =
    typeof process.env.CODEX_APPSERVER_TIMEOUT_MS === "string"
      ? Number(process.env.CODEX_APPSERVER_TIMEOUT_MS)
      : NaN;
  if (Number.isFinite(raw) && raw > 0) {
    return Math.trunc(raw);
  }
  return 240_000;
}

function parseInitializeTimeoutMs(totalTimeoutMs: number): number {
  const raw =
    typeof process.env.CODEX_APPSERVER_INITIALIZE_TIMEOUT_MS === "string"
      ? Number(process.env.CODEX_APPSERVER_INITIALIZE_TIMEOUT_MS)
      : NaN;
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.trunc(raw), totalTimeoutMs);
  }
  return Math.min(60_000, totalTimeoutMs);
}

function parseStartupRequestTimeoutMs(totalTimeoutMs: number): number {
  const raw =
    typeof process.env.CODEX_APPSERVER_START_TIMEOUT_MS === "string"
      ? Number(process.env.CODEX_APPSERVER_START_TIMEOUT_MS)
      : NaN;
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.trunc(raw), totalTimeoutMs);
  }
  return Math.min(45_000, totalTimeoutMs);
}

function parseImageNoProgressTimeoutMs(totalTimeoutMs: number): number {
  const raw =
    typeof process.env.CODEX_APPSERVER_IMAGE_NO_PROGRESS_TIMEOUT_MS === "string"
      ? Number(process.env.CODEX_APPSERVER_IMAGE_NO_PROGRESS_TIMEOUT_MS)
      : NaN;
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.trunc(raw), totalTimeoutMs);
  }
  return Math.min(90_000, totalTimeoutMs);
}

function parseModelProvider(): string {
  if (
    typeof process.env.CODEX_APPSERVER_MODEL_PROVIDER === "string" &&
    process.env.CODEX_APPSERVER_MODEL_PROVIDER.trim()
  ) {
    return process.env.CODEX_APPSERVER_MODEL_PROVIDER.trim();
  }
  return "openai";
}

function parseChatGptFallbackModel(): string {
  if (
    typeof process.env.CODEX_APPSERVER_CHATGPT_FALLBACK_MODEL === "string" &&
    process.env.CODEX_APPSERVER_CHATGPT_FALLBACK_MODEL.trim()
  ) {
    return process.env.CODEX_APPSERVER_CHATGPT_FALLBACK_MODEL.trim();
  }
  return "gpt-5.5";
}

function decorateCodexExecutableError(
  error: Error,
  executable: string,
  candidates: string[],
): Error {
  const code =
    "code" in error && typeof (error as NodeJS.ErrnoException).code === "string"
      ? (error as NodeJS.ErrnoException).code
      : undefined;
  const attempted = candidates.join(", ");

  if (code === "EACCES") {
    return new Error(
      `Failed to start Codex app-server via '${executable}' (EACCES). ` +
        `On Windows this often means PATH resolves to a packaged WindowsApps binary that is not executable in this context. ` +
        `Set CODEX_EXECUTABLE to a working Codex CLI path or install a CLI shim such as codex.cmd. Tried: ${attempted}.`,
    );
  }

  if (code === "ENOENT") {
    return new Error(
      `Failed to start Codex app-server via '${executable}' (ENOENT). ` +
        `Set CODEX_EXECUTABLE to a working Codex CLI path or ensure the Codex CLI is installed. Tried: ${attempted}.`,
    );
  }

  return error;
}

function shouldTryNextCodexExecutable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("Failed to start Codex app-server via");
}

function isChatGptCodexLatestUnsupportedError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : String(error ?? "");
  const lower = message.toLowerCase();
  return (
    lower.includes("codex-latest") &&
    lower.includes("not supported") &&
    lower.includes("chatgpt account")
  );
}

export function resolveCodexAppServerTurnModel(
  model: string,
  requestKind: GatewayRequest["requestKind"],
  chatGptFallbackModel: string,
): string {
  if (
    requestKind === "images_generations" &&
    model === "codex-latest" &&
    chatGptFallbackModel !== model
  ) {
    return chatGptFallbackModel;
  }
  return model;
}

function readStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function writeStreamEvent(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function run(): Promise<void> {
  const model = parseModelArg(process.argv.slice(2));
  const timeoutMs = parseTimeoutMs();
  const initializeTimeoutMs = parseInitializeTimeoutMs(timeoutMs);
  const startupRequestTimeoutMs = parseStartupRequestTimeoutMs(timeoutMs);
  const imageNoProgressTimeoutMs = parseImageNoProgressTimeoutMs(timeoutMs);
  const modelProvider = parseModelProvider();
  const chatGptFallbackModel = parseChatGptFallbackModel();
  const startedAt = Date.now();

  const requestJson = await readStdin();
  if (!requestJson.trim()) {
    const empty: JsonContract = { output_text: "", finish_reason: "stop" };
    process.stdout.write(JSON.stringify(empty));
    return;
  }

  const request = parseRequest(requestJson);
  const allowedToolNames = extractAllowedToolNames(request);
  const dynamicTools = extractDynamicTools(request);
  const prompt = buildPrompt(request);
  const reasoningEffort = resolveReasoningEffort(request);
  const isImageGenerationRequest = request.requestKind === "images_generations";
  const debugRpc = isTruthyEnv(process.env.CODEX_APPSERVER_DEBUG_RPC);
  const codexExecutableCandidates = getCodexExecutableCandidates();
  const shouldStream =
    request.stream === true &&
    (request.requestKind === "chat_completions" || request.requestKind === "responses");
  let childStderr = "";
  let appServer: ReturnType<typeof spawn> | null = null;
  let rpc: JsonRpcStdioClient | null = null;

  try {
    let initializeError: unknown = null;
    let initialized = false;

    for (const executable of codexExecutableCandidates) {
      childStderr = "";
      appServer = spawnCodexAppServer(executable);

      if (appServer.stderr) {
        appServer.stderr.setEncoding("utf8");
        appServer.stderr.on("data", (chunk: string) => {
          childStderr += chunk;
        });
      }

      rpc = new JsonRpcStdioClient(
        appServer,
        (error) => decorateCodexExecutableError(error, executable, codexExecutableCandidates),
      );

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          await rpc.request(
            "initialize",
            {
              clientInfo: { name: "n8n-openai-cli-gateway", version: "0.1.0" },
              capabilities: { experimentalApi: true },
            },
            initializeTimeoutMs,
          );
          initialized = true;
          break;
        } catch (error) {
          initializeError = error;
          if (attempt < 2) {
            await delay(750);
          }
        }
      }

      if (initialized) {
        break;
      }

      try {
        appServer.stdin?.end();
      } catch {
        // no-op
      }
      try {
        appServer.kill("SIGTERM");
      } catch {
        // no-op
      }

      if (!shouldTryNextCodexExecutable(initializeError)) {
        break;
      }
    }

    if (!initialized) {
      if (initializeError instanceof Error) {
        throw initializeError;
      }
      throw new Error("JSON-RPC request timed out: initialize");
    }

    if (!rpc || !appServer) {
      throw new Error(
        `Unable to start Codex app-server. Set CODEX_EXECUTABLE to a working Codex CLI path. Tried: ${codexExecutableCandidates.join(", ")}.`,
      );
    }
    rpc.notify("initialized");

    let selectedModel = resolveCodexAppServerTurnModel(
      model,
      request.requestKind,
      chatGptFallbackModel,
    );
    if (selectedModel !== model) {
      process.stderr.write(
        `codex-appserver-bridge: image generation model ${model} is not supported for ChatGPT app-server turns; using ${selectedModel}\n`,
      );
    }
    let threadStartResult: Record<string, unknown>;
    try {
      threadStartResult = (await rpc.request(
        "thread/start",
        {
          model: selectedModel,
          modelProvider,
          reasoningEffort,
          approvalPolicy: "never",
          sandbox: "read-only",
          experimentalRawEvents: true,
          persistExtendedHistory: false,
          dynamicTools: dynamicTools.length > 0 ? dynamicTools : undefined,
        },
        startupRequestTimeoutMs,
      )) as Record<string, unknown>;
    } catch (error) {
      if (
        selectedModel === "codex-latest" &&
        chatGptFallbackModel !== selectedModel &&
        isChatGptCodexLatestUnsupportedError(error)
      ) {
        selectedModel = chatGptFallbackModel;
        process.stderr.write(
          `codex-appserver-bridge: model codex-latest rejected for ChatGPT account; retrying with ${selectedModel}\n`,
        );
        threadStartResult = (await rpc.request(
          "thread/start",
          {
            model: selectedModel,
            modelProvider,
            reasoningEffort,
            approvalPolicy: "never",
            sandbox: "read-only",
            experimentalRawEvents: true,
            persistExtendedHistory: false,
            dynamicTools: dynamicTools.length > 0 ? dynamicTools : undefined,
          },
          startupRequestTimeoutMs,
        )) as Record<string, unknown>;
      } else {
        throw error;
      }
    }

    const thread =
      threadStartResult &&
      typeof threadStartResult === "object" &&
      threadStartResult.thread &&
      typeof threadStartResult.thread === "object"
        ? (threadStartResult.thread as Record<string, unknown>)
        : null;
    const threadId = thread && typeof thread.id === "string" ? thread.id : null;
    if (!threadId) {
      throw new Error("codex app-server did not return thread id.");
    }

    const turnStartResult = (await rpc.request(
      "turn/start",
      {
        threadId,
        input: [{ type: "text", text: prompt }],
        model: selectedModel,
        reasoningEffort,
      },
      startupRequestTimeoutMs,
    )) as Record<string, unknown>;

    const turn =
      turnStartResult &&
      typeof turnStartResult === "object" &&
      turnStartResult.turn &&
      typeof turnStartResult.turn === "object"
        ? (turnStartResult.turn as Record<string, unknown>)
        : null;
    const turnId = turn && typeof turn.id === "string" ? turn.id : null;

    const toolCalls: NonNullable<JsonContract["tool_calls"]> = [];
    const toolCallIds = new Set<string>();
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const imageItems: ImageGenerationItem[] = [];
    const imageItemKeys = new Set<string>();
    const requestedImageCount = isImageGenerationRequest ? parseRequestedImageCount(request) : 1;
    let localImageItemsSeenAt = 0;
    let firstImageRequestEventSeenAt = 0;
    let streamedOutputText = "";
    let streamedReasoningText = "";
    let turnCompleted = false;
    let turnFailedMessage = "";
    let toolCallSeenAt = 0;
    const streamAggregateText = (
      eventType: "output_text_delta" | "reasoning_delta",
      nextText: string,
    ): void => {
      if (!shouldStream) {
        if (eventType === "output_text_delta") {
          streamedOutputText = nextText;
        } else {
          streamedReasoningText = nextText;
        }
        return;
      }

      const previousText = eventType === "output_text_delta"
        ? streamedOutputText
        : streamedReasoningText;
      const delta = computeMonotonicDelta(previousText, nextText);
      if (delta) {
        writeStreamEvent({
          type: eventType,
          delta,
        });
      } else if (nextText !== previousText && debugRpc) {
        writeDebugLog("non_monotonic_stream_update", {
          eventType,
          previousLength: previousText.length,
          nextLength: nextText.length,
        });
      }

      if (eventType === "output_text_delta") {
        streamedOutputText = nextText;
      } else {
        streamedReasoningText = nextText;
      }
    };
    const appendImageItems = (items: ImageGenerationItem[]): void => {
      for (const item of items) {
        if (!item.url && !item.b64_json) {
          continue;
        }
        const key = item.url ? `url:${item.url}` : `b64:${item.b64_json}`;
        if (imageItemKeys.has(key)) {
          continue;
        }
        imageItemKeys.add(key);
        imageItems.push(item);
      }
    };

    while (Date.now() - startedAt < timeoutMs) {
      const incoming = await rpc.nextMessage(1000);
      if (!incoming || typeof incoming !== "object") {
        if (turnCompleted) {
          break;
        }
        continue;
      }

      const message = incoming as JsonRpcRequest;
      const method = typeof message.method === "string" ? message.method : "";
      const params =
        message.params && typeof message.params === "object"
          ? (message.params as Record<string, unknown>)
          : undefined;
      let handledMethod = false;
      if (debugRpc && method) {
        writeDebugLog("rpc", {
          method,
          ...summarizeRpcParams(params),
        });
      }
      if (isImageGenerationRequest && params) {
        firstImageRequestEventSeenAt ||= Date.now();
        appendImageItems(collectImageGenerationItems(params));
      }

      if (method === "item/tool/call" && params) {
        handledMethod = true;
        const callId =
          typeof params.callId === "string" && params.callId
            ? params.callId
            : `call_${randomUUID()}`;
        const name =
          typeof params.tool === "string" && params.tool
            ? params.tool
            : "tool";
        const args = asToolCallArguments(params.arguments);
        const normalizedName = normalizeToolName(name);
        const mappedName = allowedToolNames.get(normalizedName);
        const isAllowed = Boolean(mappedName);
        if (isAllowed && !toolCallIds.has(callId)) {
          const toolCall = { id: callId, name: mappedName!, arguments: args };
          toolCallIds.add(callId);
          toolCalls.push(toolCall);
          toolCallSeenAt = Date.now();
          if (shouldStream) {
            writeStreamEvent({
              type: "tool_call",
              tool_call: toolCall,
            });
          }
        }
        if (Object.prototype.hasOwnProperty.call(message, "id")) {
          rpc.respond(message.id, {
            success: false,
            contentItems: [
              {
                type: "inputText",
                text: isAllowed
                  ? "Tool execution is delegated to an external orchestrator."
                  : `Tool '${name}' is not available. Use one from AVAILABLE_TOOLS_JSON.`,
              },
            ],
          });
        }
        continue;
      }

      if (method === "rawResponseItem/completed" && params) {
        handledMethod = true;
        const incomingThreadId =
          typeof params.threadId === "string" ? params.threadId : "";
        if (incomingThreadId && incomingThreadId !== threadId) {
          continue;
        }

        const incomingTurnId =
          typeof params.turnId === "string" ? params.turnId : "";
        if (turnId && incomingTurnId && incomingTurnId !== turnId) {
          continue;
        }

        const call = parseToolCallFromRawItem(params.item);
        const mappedName = call ? allowedToolNames.get(normalizeToolName(call.name)) : undefined;
        if (call && mappedName && !toolCallIds.has(call.id)) {
          const toolCall = { ...call, name: mappedName };
          toolCallIds.add(call.id);
          toolCalls.push(toolCall);
          toolCallSeenAt = Date.now();
          if (shouldStream) {
            writeStreamEvent({
              type: "tool_call",
              tool_call: toolCall,
            });
          }
          continue;
        }

        if (isImageGenerationRequest) {
          appendImageItems(collectImageGenerationItems(params.item));
        }

        const content = collectAssistantContentFromRawItem(params.item);
        if (appendUniqueTextPart(reasoningParts, content.reasoningText)) {
          streamAggregateText("reasoning_delta", reasoningParts.join("\n").trim());
        }
        if (appendUniqueTextPart(textParts, content.outputText)) {
          streamAggregateText("output_text_delta", textParts.join("\n").trim());
        }
        continue;
      }

      if (method === "item/completed" && params) {
        handledMethod = true;
        const incomingThreadId =
          typeof params.threadId === "string" ? params.threadId : "";
        if (incomingThreadId && incomingThreadId !== threadId) {
          continue;
        }
        const incomingTurnId =
          typeof params.turnId === "string" ? params.turnId : "";
        if (turnId && incomingTurnId && incomingTurnId !== turnId) {
          continue;
        }
        if (isImageGenerationRequest) {
          appendImageItems(collectImageGenerationItems(params.item));
        }
        const content = collectAssistantContentFromThreadItem(params.item);
        if (appendUniqueTextPart(reasoningParts, content.reasoningText)) {
          streamAggregateText("reasoning_delta", reasoningParts.join("\n").trim());
        }
        if (appendUniqueTextPart(textParts, content.outputText)) {
          streamAggregateText("output_text_delta", textParts.join("\n").trim());
        }
        continue;
      }

      if (method === "error" && params) {
        handledMethod = true;
        const incomingTurnId =
          typeof params.turnId === "string" ? params.turnId : "";
        if (turnId && incomingTurnId && incomingTurnId !== turnId) {
          continue;
        }
        const errorObj =
          params.error && typeof params.error === "object"
            ? (params.error as Record<string, unknown>)
            : null;
        const msg =
          errorObj && typeof errorObj.message === "string"
            ? errorObj.message
            : "";
        const willRetry = params.willRetry === true;
        if (!willRetry && msg) {
          turnFailedMessage = msg;
        }
        continue;
      }

      if (method === "turn/completed" && params) {
        handledMethod = true;
        const incomingThreadId =
          typeof params.threadId === "string" ? params.threadId : "";
        if (incomingThreadId && incomingThreadId !== threadId) {
          continue;
        }
        const turnObj =
          params.turn && typeof params.turn === "object"
            ? (params.turn as Record<string, unknown>)
            : null;
        if (turnObj && turnId && typeof turnObj.id === "string" && turnObj.id !== turnId) {
          continue;
        }
        const status = turnObj && typeof turnObj.status === "string" ? turnObj.status : "";
        if (status === "failed" && !turnFailedMessage) {
          const errorObj =
            turnObj &&
            turnObj.error &&
            typeof turnObj.error === "object"
              ? (turnObj.error as Record<string, unknown>)
              : null;
          if (errorObj && typeof errorObj.message === "string") {
            turnFailedMessage = errorObj.message;
          }
        }
        turnCompleted = true;
      }

      if (debugRpc && method && !handledMethod) {
        writeDebugLog("unhandled_rpc", {
          method,
          ...summarizeRpcParams(params),
        });
      }

      if (isImageGenerationRequest) {
        const beforeCount = imageItems.length;
        appendImageItems(collectRecentCodexGeneratedImageItems(startedAt));
        if (imageItems.length > beforeCount) {
          localImageItemsSeenAt = Date.now();
        }
        if (
          localImageItemsSeenAt &&
          imageItems.length >= requestedImageCount &&
          Date.now() - localImageItemsSeenAt > 1200
        ) {
          break;
        }
        if (
          firstImageRequestEventSeenAt &&
          imageItems.length === 0 &&
          Date.now() - firstImageRequestEventSeenAt > imageNoProgressTimeoutMs
        ) {
          throw new Error(
            `Codex CLI image generation produced no image artifact within ${imageNoProgressTimeoutMs}ms.`,
          );
        }
        if (
          isImageGenerationRequest &&
          imageItems.length === 0 &&
          Date.now() - startedAt > imageNoProgressTimeoutMs
        ) {
          throw new Error(
            `Codex CLI image generation produced no image artifact within ${imageNoProgressTimeoutMs}ms of request start.`,
          );
        }
      }

      if (toolCallSeenAt && Date.now() - toolCallSeenAt > 1200) {
        break;
      }
      if (turnCompleted) {
        break;
      }
    }

    let outputText = textParts.join("\n").trim();
    let reasoningText = reasoningParts.join("\n").trim();
    let finishReason: FinishReason = "stop";

    if (isImageGenerationRequest && imageItems.length > 0) {
      outputText = JSON.stringify({ data: imageItems });
      streamAggregateText("output_text_delta", outputText);
    }

    if (isImageGenerationRequest && imageItems.length === 0 && !outputText && turnFailedMessage) {
      throw new Error(turnFailedMessage);
    }

    if (isImageGenerationRequest && imageItems.length === 0 && !outputText) {
      throw new Error("Codex CLI image generation completed without producing an image artifact.");
    }

    const parsedContract = parseJsonContractFromText(outputText);
    if (parsedContract) {
      outputText = parsedContract.output_text || outputText;
      streamAggregateText("output_text_delta", outputText);
      if (appendUniqueTextPart(reasoningParts, parsedContract.reasoning ?? "")) {
        reasoningText = reasoningParts.join("\n").trim();
        streamAggregateText("reasoning_delta", reasoningText);
      } else {
        reasoningText = reasoningParts.join("\n").trim();
      }
      finishReason = parsedContract.finish_reason;

      const parsedToolCalls = Array.isArray(parsedContract.tool_calls)
        ? parsedContract.tool_calls
        : [];
      for (const call of parsedToolCalls) {
        const mappedName = allowedToolNames.get(normalizeToolName(call.name));
        if (mappedName && !toolCallIds.has(call.id)) {
          const toolCall = { ...call, name: mappedName };
          toolCallIds.add(call.id);
          toolCalls.push(toolCall);
          if (shouldStream) {
            writeStreamEvent({
              type: "tool_call",
              tool_call: toolCall,
            });
          }
        }
      }
    }

    if (toolCalls.length > 0) {
      if (shouldStream) {
        writeStreamEvent({
          type: "done",
          finish_reason: "tool_calls",
          output_text: outputText,
          reasoning: reasoningText || undefined,
        });
        return;
      }
      const out: JsonContract = {
        output_text: outputText,
        reasoning: reasoningText || undefined,
        tool_calls: toolCalls,
        finish_reason: "tool_calls",
      };
      process.stdout.write(JSON.stringify(out));
      return;
    }

    if (!outputText && turnFailedMessage) {
      throw new Error(turnFailedMessage);
    }

    if (finishReason === "tool_calls") {
      finishReason = "stop";
    }

    if (shouldStream) {
      writeStreamEvent({
        type: "done",
        finish_reason: finishReason,
        output_text: outputText,
        reasoning: reasoningText || undefined,
      });
      return;
    }

    const out: JsonContract = {
      output_text: outputText,
      reasoning: reasoningText || undefined,
      finish_reason: finishReason,
    };
    process.stdout.write(JSON.stringify(out));
  } finally {
    try {
      appServer?.stdin?.end();
    } catch {
      // no-op
    }
    try {
      appServer?.kill("SIGTERM");
    } catch {
      // no-op
    }
    setTimeout(() => {
      try {
        appServer?.kill("SIGKILL");
      } catch {
        // no-op
      }
    }, 1500).unref();

    const trimmedErr = childStderr.trim();
    if (trimmedErr) {
      process.stderr.write(`${trimmedErr}\n`);
    }
  }
}

function spawnCodexAppServer(executable: string): ReturnType<typeof spawn> {
  return spawn(executable, ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    shell: shouldSpawnViaShell(executable),
  });
}

function shouldSpawnViaShell(executable: string): boolean {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable.trim());
}

if (require.main === module) {
  run().catch((error) => {
    const message =
      error instanceof Error ? error.message : `Unexpected error: ${String(error)}`;
    if (message) {
      process.stderr.write(`${message}\n`);
    }
    process.exit(1);
  });
}
