import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { parseAssistantPayloadText } from "../utils/assistant-output";
import { normalizeToolAlias, normalizeToolName } from "../utils/tools";
import { resolveReasoningEffort } from "../utils/reasoning";

interface GatewayMessage {
  role?: unknown;
  content?: unknown;
  name?: unknown;
  tool_call_id?: unknown;
}

interface GatewayRequest {
  prompt?: unknown;
  messages?: unknown;
  tools?: unknown;
  reasoningEffort?: unknown;
  metadata?: unknown;
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

interface AcpSession {
  sessionId: string;
  configOptions: AcpConfigOption[];
}

interface AcpConfigOptionChoice {
  value?: unknown;
  name?: unknown;
}

interface AcpConfigOption {
  id?: unknown;
  name?: unknown;
  category?: unknown;
  currentValue?: unknown;
  options?: unknown;
}

interface AcpConfigState {
  configOptions: AcpConfigOption[];
}

type FinishReason = "stop" | "tool_calls" | "length" | "error";

interface JsonContract {
  output_text: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  finish_reason: FinishReason;
}

class JsonRpcStdioClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      method: string;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly queue: unknown[] = [];
  private readonly waiters: Array<(value: unknown | null) => void> = [];
  private readonly child: ReturnType<typeof spawn>;
  private buffer = "";
  private ended = false;

  constructor(child: ReturnType<typeof spawn>) {
    this.child = child;

    if (!child.stdout || !child.stdin) {
      throw new Error("Kimi ACP stdio streams are unavailable.");
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.buffer += data;
      this.drainBuffer();
    });

    child.on("error", (error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      this.rejectAll(err);
    });

    child.on("close", () => {
      this.ended = true;
      this.rejectAll(new Error("Kimi ACP process closed."));
    });
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
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
      throw new Error("Kimi ACP stdin is unavailable.");
    }

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
          const detail =
            typeof maybeResponse.error.data === "undefined"
              ? ""
              : ` data=${normalizeValue(maybeResponse.error.data)}`;
          pending.reject(new Error(`ACP ${pending.method} failed: ${message}${detail}`));
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

function parseRequest(input: string): GatewayRequest {
  return JSON.parse(input) as GatewayRequest;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function extractAllowedToolNames(request: GatewayRequest): Map<string, string> {
  const out = new Map<string, string>();
  const tools = Array.isArray(request.tools) ? request.tools : [];
  for (const item of tools) {
    if (!isRecord(item)) {
      continue;
    }
    const fn = isRecord(item.function) ? item.function : null;
    const name = fn && typeof fn.name === "string" ? fn.name.trim() : "";
    if (name) {
      out.set(normalizeToolName(name), name);
    }
  }
  return out;
}

function resolveAllowedToolName(rawName: string, allowedToolNames: Map<string, string>): string {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return "";
  }

  if (allowedToolNames.size === 0) {
    return trimmed;
  }

  const direct = allowedToolNames.get(normalizeToolName(trimmed));
  if (direct) {
    return direct;
  }

  const alias = normalizeToolAlias(trimmed);
  for (const allowedName of allowedToolNames.values()) {
    if (normalizeToolAlias(allowedName) === alias) {
      return allowedName;
    }
  }

  if (allowedToolNames.size === 1) {
    return allowedToolNames.values().next().value ?? trimmed;
  }

  return trimmed;
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

export function buildPrompt(request: GatewayRequest): string {
  const promptText =
    typeof request.prompt === "string" && request.prompt.trim()
      ? request.prompt.trim()
      : "";

  const rawMessages = Array.isArray(request.messages) ? request.messages : [];
  const messages = rawMessages as GatewayMessage[];
  const messageText =
    promptText ||
    messages
      .map((msg) => {
        const role =
          typeof msg.role === "string" && msg.role.trim() ? msg.role : "user";
        const name =
          typeof msg.name === "string" && msg.name.trim() ? ` (${msg.name})` : "";
        const toolCallId =
          typeof msg.tool_call_id === "string" && msg.tool_call_id.trim()
            ? ` [tool_call_id=${msg.tool_call_id}]`
            : "";
        return `${String(role).toUpperCase()}${name}${toolCallId}:\n${normalizeValue(msg.content)}`;
      })
      .join("\n\n");

  const tools = Array.isArray(request.tools) ? request.tools : [];
  if (tools.length === 0) {
    return messageText;
  }

  const metadata = isRecord(request.metadata) ? request.metadata : {};
  const toolChoice = isRecord(metadata.tool_choice) ? metadata.tool_choice : null;
  const toolChoiceFn = toolChoice && isRecord(toolChoice.function) ? toolChoice.function : null;
  const forcedToolName =
    toolChoice?.type === "function" && typeof toolChoiceFn?.name === "string"
      ? toolChoiceFn.name.trim()
      : "";

  const toolJson = JSON.stringify(tools, null, 2);
  const toolNames = [...extractAllowedToolNames(request).values()].join(", ");
  const instruction = [
    "You are connected through an OpenAI-compatible gateway.",
    "The tools listed in AVAILABLE_TOOLS_JSON are the only tools you can use in this turn.",
    "Do not claim that tools are unavailable when AVAILABLE_TOOLS_JSON is non-empty.",
    "Do not use any internal ACP tools, shell commands, filesystem access, web browsing, or MCP tools.",
    "Do not request local permissions. Local permission requests are rejected by the gateway.",
    "TOOL: messages are outputs from previous tool calls.",
    "When TOOL: messages are present and no more tools are needed, synthesize the final answer for the user in output_text.",
    "Do not copy placeholder or example text into output_text.",
    forcedToolName
      ? `tool_choice is set. You MUST call exactly this function name: ${forcedToolName}.`
      : "Use tools only when they are actually needed for external actions or data.",
    "When calling a tool, the tool name MUST exactly match one value from AVAILABLE_TOOL_NAMES.",
    "Return raw JSON only. Do not wrap JSON in markdown or code fences.",
    "If a tool is needed, respond ONLY with JSON:",
    '{"output_text":"","tool_calls":[{"id":"call_1","name":"tool_name","arguments":{"arg":"value"}}],"finish_reason":"tool_calls"}',
    'If no tool is needed, respond ONLY with valid JSON containing a real user-facing answer in output_text and "finish_reason":"stop".',
  ].join("\n");

  return [
    messageText,
    "",
    "AVAILABLE_TOOLS_JSON:",
    toolJson,
    "",
    "AVAILABLE_TOOL_NAMES:",
    toolNames || "(none)",
    "",
    instruction,
  ].join("\n");
}

function isFinishReason(value: unknown): value is FinishReason {
  return (
    value === "stop" ||
    value === "tool_calls" ||
    value === "length" ||
    value === "error"
  );
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

function asToolCallArguments(value: unknown): string {
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
    return JSON.stringify(sanitizeValue(value ?? {}));
  } catch {
    return "{}";
  }
}

export function normalizeToolCallsFromContract(raw: unknown): NonNullable<JsonContract["tool_calls"]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }

  const calls: NonNullable<JsonContract["tool_calls"]> = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }

    const fn = isRecord(entry.function) ? entry.function : undefined;
    const functionCall = isRecord(entry.functionCall)
      ? entry.functionCall
      : isRecord(entry.function_call)
        ? entry.function_call
        : undefined;
    const merged = functionCall ?? fn;
    const name = firstNonEmptyString(
      entry.name,
      entry.tool_name,
      entry.toolName,
      merged?.name,
    );
    if (!name) {
      continue;
    }

    const id =
      firstNonEmptyString(entry.id, entry.call_id, entry.tool_id, entry.toolId) ??
      `call_${calls.length + 1}`;
    const argsRaw = firstDefined(
      entry.arguments,
      entry.args,
      entry.parameters,
      entry.input,
      merged?.arguments,
      merged?.args,
      merged?.parameters,
      merged?.input,
    );

    calls.push({
      id,
      name,
      arguments: asToolCallArguments(argsRaw),
    });
  }

  return calls;
}

export function parseJsonContractFromText(raw: string): JsonContract | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  let best: JsonContract | null = null;
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
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      finish_reason: finishReason,
    };
  };
  const assistantPayloadToContract = (value: string): JsonContract | null => {
    const parsed = parseAssistantPayloadText(value);
    if (!parsed.recognized) {
      return null;
    }

    const toolCalls = parsed.toolCalls.map((call, index) => ({
      id: call.id || `call_${index + 1}`,
      name: call.name,
      arguments: asToolCallArguments(call.arguments),
    }));
    const finishReason: FinishReason =
      toolCalls.length > 0
        ? "tool_calls"
        : isFinishReason(parsed.finishReason)
          ? parsed.finishReason
          : "stop";

    return {
      output_text: parsed.outputText.trim(),
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      finish_reason: finishReason,
    };
  };

  const assistantPayloadContract = assistantPayloadToContract(trimmed);
  if (assistantPayloadContract?.tool_calls && assistantPayloadContract.tool_calls.length > 0) {
    return assistantPayloadContract;
  }
  if (assistantPayloadContract) {
    best = assistantPayloadContract;
  }
  push(trimmed);
  pushDerived(trimmed);

  for (let i = 0; i < queue.length && i < 80; i += 1) {
    const current = queue[i];
    if (typeof current !== "string") {
      continue;
    }
    pushDerived(current);

    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
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

    const fallbackContract = assistantPayloadToContract(current);
    if (fallbackContract) {
      if (!best) {
        best = fallbackContract;
      }
      if (fallbackContract.tool_calls && fallbackContract.tool_calls.length > 0) {
        return fallbackContract;
      }
    }

    if (typeof parsed.response === "string") {
      push(parsed.response);
      pushDerived(parsed.response);
    }
    const maybeMessage = parsed.message;
    if (isRecord(maybeMessage)) {
      push(normalizeValue(maybeMessage.content));
      pushDerived(normalizeValue(maybeMessage.content));
      push(normalizeValue(maybeMessage));
      pushDerived(normalizeValue(maybeMessage));
    }

    for (const entry of Object.values(parsed)) {
      if (typeof entry === "string") {
        push(entry);
        pushDerived(entry);
      } else if (isRecord(entry)) {
        const serialized = normalizeValue(entry);
        push(serialized);
        pushDerived(serialized);
      }
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

  throw new Error("Missing model argument for kimi-acp-bridge.");
}

function parseTimeoutMs(): number {
  const raw =
    typeof process.env.KIMI_ACP_TIMEOUT_MS === "string"
      ? Number(process.env.KIMI_ACP_TIMEOUT_MS)
      : NaN;
  if (Number.isFinite(raw) && raw > 0) {
    return Math.trunc(raw);
  }
  return 240_000;
}

function parseInitializeTimeoutMs(totalTimeoutMs: number): number {
  const raw =
    typeof process.env.KIMI_ACP_INITIALIZE_TIMEOUT_MS === "string"
      ? Number(process.env.KIMI_ACP_INITIALIZE_TIMEOUT_MS)
      : NaN;
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.trunc(raw), totalTimeoutMs);
  }
  return Math.min(60_000, totalTimeoutMs);
}

function parseRequestTimeoutMs(totalTimeoutMs: number): number {
  const raw =
    typeof process.env.KIMI_ACP_REQUEST_TIMEOUT_MS === "string"
      ? Number(process.env.KIMI_ACP_REQUEST_TIMEOUT_MS)
      : NaN;
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.trunc(raw), totalTimeoutMs);
  }
  return Math.min(120_000, totalTimeoutMs);
}

function getWorkingDirectory(): string {
  if (
    typeof process.env.KIMI_ACP_CWD === "string" &&
    process.env.KIMI_ACP_CWD.trim()
  ) {
    return process.env.KIMI_ACP_CWD.trim();
  }
  return process.cwd();
}

function candidateCommands(): Array<{ args: string[] }> {
  return [{ args: ["acp"] }];
}

function formatSpawnError(args: string[], stderr: string): string {
  const suffix = stderr.trim() ? `\nstderr: ${stderr.trim()}` : "";
  return `Failed to start Kimi ACP command: kimi ${args.join(" ")}${suffix}`;
}

function extractSessionId(result: unknown): string {
  if (!isRecord(result)) {
    throw new Error("Kimi ACP session/new did not return an object result.");
  }

  if (typeof result.sessionId === "string" && result.sessionId) {
    return result.sessionId;
  }

  if (isRecord(result.session) && typeof result.session.id === "string" && result.session.id) {
    return result.session.id;
  }

  throw new Error("Kimi ACP session/new did not return session id.");
}

function extractConfigOptions(result: unknown): AcpConfigOption[] {
  if (!isRecord(result)) {
    return [];
  }

  const fromRoot = Array.isArray(result.configOptions) ? result.configOptions : [];
  if (fromRoot.length > 0) {
    return fromRoot as AcpConfigOption[];
  }

  const session = isRecord(result.session) ? result.session : null;
  const fromSession = session && Array.isArray(session.configOptions) ? session.configOptions : [];
  return fromSession as AcpConfigOption[];
}

function optionString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptionCandidates(option: AcpConfigOption): Array<{
  value: string;
  normalizedValue: string;
  normalizedName: string;
}> {
  const out: Array<{ value: string; normalizedValue: string; normalizedName: string }> = [];
  const choices = Array.isArray(option.options) ? option.options : [];
  for (const entry of choices) {
    if (!isRecord(entry)) {
      continue;
    }
    const value = optionString(entry.value);
    if (!value) {
      continue;
    }
    const name = optionString(entry.name);
    out.push({
      value,
      normalizedValue: normalizeToolName(value),
      normalizedName: normalizeToolName(name || value),
    });
  }
  return out;
}

function findOptionByCategory(
  configOptions: AcpConfigOption[],
  category: string,
): AcpConfigOption | undefined {
  return configOptions.find((option) => option.category === category);
}

export function findSafeModeValue(configOptions: AcpConfigOption[]): { id: string; value: string } | null {
  const option = findOptionByCategory(configOptions, "mode");
  if (!option || typeof option.id !== "string" || !option.id) {
    return null;
  }

  const candidates = normalizeOptionCandidates(option);
  const preferred = ["chat", "ask", "architect", "plan", "read_only", "readonly"];
  for (const name of preferred) {
    const match = candidates.find(
      (candidate) =>
        candidate.normalizedValue === normalizeToolName(name) ||
        candidate.normalizedName === normalizeToolName(name),
    );
    if (match) {
      return { id: option.id, value: match.value };
    }
  }

  return null;
}

function findModelValue(
  configOptions: AcpConfigOption[],
  requestedModel: string,
): { id: string; value: string } | null {
  const option = findOptionByCategory(configOptions, "model");
  if (!option || typeof option.id !== "string" || !option.id) {
    return null;
  }

  const desired = normalizeToolName(requestedModel);
  const candidates = normalizeOptionCandidates(option);
  const direct = candidates.find(
    (candidate) =>
      candidate.normalizedValue === desired || candidate.normalizedName === desired,
  );
  if (direct) {
    return { id: option.id, value: direct.value };
  }

  return null;
}

function findThoughtLevelValue(
  configOptions: AcpConfigOption[],
  reasoningEffort: string | undefined,
): { id: string; value: string } | null {
  if (!reasoningEffort) {
    return null;
  }

  const option = findOptionByCategory(configOptions, "thought_level");
  if (!option || typeof option.id !== "string" || !option.id) {
    return null;
  }

  const candidates = normalizeOptionCandidates(option);
  if (candidates.length === 0) {
    return null;
  }

  const rankList =
    reasoningEffort === "none" || reasoningEffort === "minimal" || reasoningEffort === "low"
      ? ["off", "none", "minimal", "low"]
      : reasoningEffort === "medium"
        ? ["medium", "normal", "balanced", "auto"]
        : ["high", "deep", "max", "maximum", "extended"];

  for (const name of rankList) {
    const match = candidates.find(
      (candidate) =>
        candidate.normalizedValue === normalizeToolName(name) ||
        candidate.normalizedName === normalizeToolName(name),
    );
    if (match) {
      return { id: option.id, value: match.value };
    }
  }

  if (reasoningEffort === "high" || reasoningEffort === "xhigh") {
    return { id: option.id, value: candidates[candidates.length - 1]!.value };
  }
  if (
    reasoningEffort === "none" ||
    reasoningEffort === "minimal" ||
    reasoningEffort === "low"
  ) {
    return { id: option.id, value: candidates[0]!.value };
  }

  return { id: option.id, value: candidates[Math.floor(candidates.length / 2)]!.value };
}

async function applyConfigOption(
  rpc: JsonRpcStdioClient,
  sessionId: string,
  timeoutMs: number,
  state: AcpConfigState,
  next: { id: string; value: string } | null,
): Promise<void> {
  if (!next) {
    return;
  }

  const current = state.configOptions.find((option) => option.id === next.id);
  if (current && optionString(current.currentValue) === next.value) {
    return;
  }

  const result = await rpc.request(
    "session/set_config_option",
    {
      sessionId,
      configId: next.id,
      value: next.value,
    },
    timeoutMs,
  );
  state.configOptions = extractConfigOptions(result);
}

function looksLikeToolPayload(value: Record<string, unknown>): boolean {
  return (
    "tool_calls" in value ||
    "finish_reason" in value ||
    "function" in value ||
    "function_call" in value ||
    "functionCall" in value ||
    ("type" in value &&
      (value.type === "function" ||
        value.type === "function_call" ||
        value.type === "custom_tool_call")) ||
    (typeof value.name === "string" &&
      ("arguments" in value || "args" in value || "parameters" in value || "input" in value))
  );
}

function collectAgentText(update: Record<string, unknown>): string {
  const candidates: string[] = [];
  const push = (value: unknown): void => {
    const text = typeof value === "string" ? value : "";
    if (!text) {
      return;
    }
    if (!candidates.includes(text)) {
      candidates.push(text);
    }
  };

  const rawContent = update.content;
  if (typeof rawContent === "string") {
    push(rawContent);
  }

  const content = isRecord(rawContent) ? rawContent : null;
  if (content) {
    push(content.text);
    push(content.markdown);
    push(content.content);
    if (looksLikeToolPayload(content)) {
      push(normalizeValue(content));
    }
  }

  if (looksLikeToolPayload(update)) {
    push(normalizeValue(update));
  }

  return candidates.join("\n");
}

export function extractKimiAgentTextChunk(update: unknown): string {
  if (!isRecord(update) || update.sessionUpdate !== "agent_message_chunk") {
    return "";
  }
  return collectAgentText(update);
}

export function mergeKimiAgentTextChunks(chunks: string[]): string {
  return chunks.join("").trim();
}

function startKimiAcpProcess(
  args: string[],
): {
  child: ReturnType<typeof spawn>;
  rpc: JsonRpcStdioClient;
  childStderrRef: { value: string };
} {
  const child = spawn("kimi", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  const childStderrRef = { value: "" };
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      childStderrRef.value += chunk;
    });
  }

  const rpc = new JsonRpcStdioClient(child);
  return { child, rpc, childStderrRef };
}

function shutdownChild(child: ReturnType<typeof spawn>): void {
  try {
    child.stdin?.end();
  } catch {
    // no-op
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // no-op
  }
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // no-op
    }
  }, 1500).unref();
}

async function initializeKimiAcp(
  initializeTimeoutMs: number,
): Promise<{
  child: ReturnType<typeof spawn>;
  rpc: JsonRpcStdioClient;
  childStderrRef: { value: string };
}> {
  let lastError: Error | null = null;

  for (const candidate of candidateCommands()) {
    const { child, rpc, childStderrRef } = startKimiAcpProcess(candidate.args);

    try {
      const initialized = (await rpc.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: {
            name: "n8n-openai-cli-gateway",
            title: "n8n OpenAI CLI Gateway",
            version: "0.1.0",
          },
        },
        initializeTimeoutMs,
      )) as Record<string, unknown>;

      if (isRecord(initialized) && typeof initialized.protocolVersion === "number") {
        if (initialized.protocolVersion !== 1) {
          throw new Error(
            `Kimi ACP negotiated unsupported protocol version ${String(initialized.protocolVersion)}.`,
          );
        }
      }

      return { child, rpc, childStderrRef };
    } catch (error) {
      shutdownChild(child);
      const suffix =
        error instanceof Error ? `\n${error.message}` : `\n${String(error)}`;
      lastError = new Error(formatSpawnError(candidate.args, childStderrRef.value) + suffix);
    }
  }

  throw lastError ?? new Error("Unable to start Kimi ACP.");
}

function selectRejectOptionId(params: Record<string, unknown>): string | null {
  const options = Array.isArray(params.options) ? params.options : [];
  for (const entry of options) {
    if (!isRecord(entry)) {
      continue;
    }
    if (entry.kind === "reject_once" && typeof entry.optionId === "string" && entry.optionId) {
      return entry.optionId;
    }
  }
  for (const entry of options) {
    if (!isRecord(entry)) {
      continue;
    }
    if (entry.kind === "reject_always" && typeof entry.optionId === "string" && entry.optionId) {
      return entry.optionId;
    }
  }
  return null;
}

async function run(): Promise<void> {
  const model = parseModelArg(process.argv.slice(2));
  const timeoutMs = parseTimeoutMs();
  const initializeTimeoutMs = parseInitializeTimeoutMs(timeoutMs);
  const requestTimeoutMs = parseRequestTimeoutMs(timeoutMs);
  const startedAt = Date.now();

  const requestJson = await readStdin();
  if (!requestJson.trim()) {
    const empty: JsonContract = { output_text: "", finish_reason: "stop" };
    process.stdout.write(JSON.stringify(empty));
    return;
  }

  const request = parseRequest(requestJson);
  const allowedToolNames = extractAllowedToolNames(request);
  const prompt = buildPrompt(request);
  const reasoningEffort = resolveReasoningEffort(request);

  const { child, rpc, childStderrRef } = await initializeKimiAcp(initializeTimeoutMs);

  try {
    const sessionResult = await rpc.request(
      "session/new",
      {
        cwd: getWorkingDirectory(),
        mcpServers: [],
      },
      requestTimeoutMs,
    );

    const sessionId = extractSessionId(sessionResult);
    const state: AcpConfigState = {
      configOptions: extractConfigOptions(sessionResult),
    };

    await applyConfigOption(
      rpc,
      sessionId,
      requestTimeoutMs,
      state,
      findSafeModeValue(state.configOptions),
    );
    await applyConfigOption(
      rpc,
      sessionId,
      requestTimeoutMs,
      state,
      findModelValue(state.configOptions, model),
    );
    await applyConfigOption(
      rpc,
      sessionId,
      requestTimeoutMs,
      state,
      findThoughtLevelValue(state.configOptions, reasoningEffort),
    );

    let promptDone = false;
    let promptError: Error | null = null;
    const promptPromise = rpc
      .request(
        "session/prompt",
        {
          sessionId,
          prompt: [
            {
              type: "text",
              text: prompt,
            },
          ],
        },
        timeoutMs,
      )
      .then(() => {
        promptDone = true;
      })
      .catch((error) => {
        promptDone = true;
        promptError = error instanceof Error ? error : new Error(String(error));
      });

    const textParts: string[] = [];
    let deniedPermission = false;
    while (Date.now() - startedAt < timeoutMs) {
      const incoming = await rpc.nextMessage(1000);
      if (!incoming || !isRecord(incoming)) {
        if (promptDone) {
          break;
        }
        continue;
      }

      const message = incoming as JsonRpcRequest;
      const method = typeof message.method === "string" ? message.method : "";
      const params = isRecord(message.params) ? message.params : undefined;

      if (method === "session/request_permission" && params) {
        deniedPermission = true;
        if (Object.prototype.hasOwnProperty.call(message, "id")) {
          const rejectOptionId = selectRejectOptionId(params);
          if (rejectOptionId) {
            rpc.respond(message.id, {
              outcome: {
                outcome: "selected",
                optionId: rejectOptionId,
              },
            });
          } else {
            rpc.respond(message.id, {
              outcome: {
                outcome: "cancelled",
              },
            });
          }
        }
        continue;
      }

      if (method === "session/update" && params) {
        const incomingSessionId =
          typeof params.sessionId === "string" ? params.sessionId : "";
        if (incomingSessionId && incomingSessionId !== sessionId) {
          continue;
        }

        const update = isRecord(params.update) ? params.update : null;
        if (!update) {
          continue;
        }

        if (update.sessionUpdate === "agent_message_chunk") {
          const chunk = extractKimiAgentTextChunk(update);
          if (chunk) {
            textParts.push(chunk);
          }
          continue;
        }

        if (update.sessionUpdate === "config_option_update") {
          state.configOptions = Array.isArray(update.configOptions)
            ? (update.configOptions as AcpConfigOption[])
            : state.configOptions;
          continue;
        }
      }
    }

    await promptPromise;
    if (promptError) {
      throw promptError;
    }

    let outputText = mergeKimiAgentTextChunks(textParts);
    let finishReason: FinishReason = "stop";

    const parsedContract = parseJsonContractFromText(outputText);
    if (parsedContract) {
      outputText = parsedContract.output_text || outputText;
      finishReason = parsedContract.finish_reason;

      if (Array.isArray(parsedContract.tool_calls) && parsedContract.tool_calls.length > 0) {
        const toolCalls = parsedContract.tool_calls
          .map((call) => {
            return {
              id: call.id || `call_${randomUUID()}`,
              name: resolveAllowedToolName(call.name, allowedToolNames),
              arguments: asToolCallArguments(call.arguments),
            };
          })
          .filter((value) => typeof value.name === "string" && value.name.trim().length > 0);

        if (toolCalls.length > 0) {
          process.stdout.write(
            JSON.stringify({
              output_text: outputText,
              tool_calls: toolCalls,
              finish_reason: "tool_calls",
            } satisfies JsonContract),
          );
          return;
        }
      }

      if (finishReason === "tool_calls") {
        throw new Error(
          "Kimi ACP returned finish_reason tool_calls without a usable tool_calls payload.",
        );
      }
    }

    if (!outputText && deniedPermission) {
      throw new Error(
        "Kimi ACP requested local tool permission instead of returning a gateway JSON response.",
      );
    }

    process.stdout.write(
      JSON.stringify({
        output_text: outputText,
        finish_reason: finishReason,
      } satisfies JsonContract),
    );
  } finally {
    shutdownChild(child);

    const trimmedErr = childStderrRef.value.trim();
    if (trimmedErr) {
      process.stderr.write(`${trimmedErr}\n`);
    }
  }
}

if (require.main === module) {
  void run().catch((error) => {
    const message =
      error instanceof Error ? error.message : `Unexpected error: ${String(error)}`;
    if (message) {
      process.stderr.write(`${message}\n`);
    }
    process.exit(1);
  });
}
