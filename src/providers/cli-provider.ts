import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JobManager } from "../jobs/job-manager";
import type {
  AuthStatusResult,
  CliProviderConfig,
  LoginJobSummary,
  ProviderRateLimits,
  ProviderResult,
  ProviderStreamEvent,
  ProviderToolCall,
  RateLimitInfo,
  UnifiedRequest,
  UnifiedToolDefinition,
} from "../types";
import { runCommand, runCommandStream, resolveCommand } from "../utils/command";
import { buildPrompt } from "../utils/prompt";
import { withRuntimeTemplateVars } from "../utils/runtime-template-vars";
import { normalizeToolName, normalizeToolAlias, normalizeArgumentKey } from "../utils/tools";
import { normalizeAssistantResult } from "../utils/assistant-output";
import { normalizeProviderUsage } from "../utils/usage";
import type { Provider } from "./provider";

interface JsonContract {
  output_text?: string;
  text?: string;
  content?: string;
  reasoning?: unknown;
  tool_calls?: unknown[];
  finish_reason?: "stop" | "tool_calls" | "length" | "error";
  usage?: unknown;
}

type JsonStreamContract =
  | {
    type: "reasoning_delta";
    delta?: unknown;
  }
  | {
    type: "output_text_delta";
    delta?: unknown;
  }
  | {
    type: "tool_call";
    tool_call?: unknown;
  }
  | {
    type: "done";
    finish_reason?: unknown;
    output_text?: unknown;
    reasoning?: unknown;
    usage?: unknown;
  };

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export class CliProvider implements Provider {
  readonly id: string;
  readonly description?: string;
  readonly config: CliProviderConfig;
  readonly models: CliProviderConfig["models"];

  constructor(config: CliProviderConfig) {
    this.id = config.id;
    this.description = config.description;
    this.config = config;
    this.models = config.models;
  }

  supportsStreaming(): boolean {
    return this.usesCodexAppServerBridge();
  }

  prefersImageGeneration(): boolean {
    return this.usesCodexAppServerBridge();
  }

  async run(request: UnifiedRequest): Promise<ProviderResult> {
    const prepared = await this.prepareCommandExecution(request);
    try {
      const output = await runCommand(prepared.resolved, prepared.stdinPayload);
      if (isTruthyEnv(process.env.CODEX_APPSERVER_DEBUG_RPC) && output.stderr.trim()) {
        process.stderr.write(output.stderr);
      }
      if (output.timedOut) {
        throw new Error(`Provider command timed out after ${prepared.resolved.timeoutMs}ms.`);
      }

      if (output.exitCode !== 0) {
        throw new Error(
          [
            `Provider command exited with code ${output.exitCode}.`,
            output.stderr ? `stderr: ${output.stderr.trim()}` : "",
            output.stdout ? `stdout: ${output.stdout.trim()}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
      const parsed = this.parseOutput(output.stdout);
      return normalizeResultToolCalls(parsed, request.tools);
    } finally {
      await rm(prepared.tmpDir, { recursive: true, force: true });
    }
  }

  async *runStream(request: UnifiedRequest): AsyncIterable<ProviderStreamEvent> {
    if (!this.supportsStreaming()) {
      throw new Error(`Provider ${this.id} does not support live streaming.`);
    }
    if (this.config.responseCommand.output !== "json_contract") {
      throw new Error(`Provider ${this.id} does not support streaming for output mode ${this.config.responseCommand.output}.`);
    }

    const allowedTools = extractAllowedTools(request.tools);
    const prepared = await this.prepareCommandExecution({
      ...request,
      stream: true,
    });

    try {
      let pendingStdout = "";
      for await (const event of runCommandStream(prepared.resolved, prepared.stdinPayload)) {
        if (event.stream !== "stdout") {
          if (isTruthyEnv(process.env.CODEX_APPSERVER_DEBUG_RPC) && event.chunk) {
            process.stderr.write(event.chunk);
          }
          continue;
        }

        pendingStdout += event.chunk;
        let newlineIndex = pendingStdout.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = pendingStdout.slice(0, newlineIndex).trim();
          pendingStdout = pendingStdout.slice(newlineIndex + 1);
          const parsedEvent = parseJsonStreamEvent(line);
          if (parsedEvent) {
            yield normalizeStreamToolEvent(parsedEvent, allowedTools);
          }
          newlineIndex = pendingStdout.indexOf("\n");
        }
      }

      const trailingEvent = parseJsonStreamEvent(pendingStdout.trim());
      if (trailingEvent) {
        yield normalizeStreamToolEvent(trailingEvent, allowedTools);
      }
    } finally {
      await rm(prepared.tmpDir, { recursive: true, force: true });
    }
  }

  private async prepareCommandExecution(request: UnifiedRequest): Promise<{
    tmpDir: string;
    resolved: ReturnType<typeof resolveCommand>;
    stdinPayload: string;
  }> {
    const modelConfig = this.models.find((model) => model.id === request.model);
    if (!modelConfig) {
      throw new Error(`Provider ${this.id} does not expose model ${request.model}.`);
    }

    const basePrompt = buildPrompt(request.messages);
    const prompt =
      this.config.responseCommand.input === "prompt_stdin"
        ? buildPromptWithTools(basePrompt, request.tools)
        : basePrompt;
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "n8n-openai-gateway-"));
    const promptFile = path.join(tmpDir, "prompt.txt");
    const requestFile = path.join(tmpDir, "request.json");

    const requestPayload = {
      ...request,
      prompt,
    };

    await writeFile(promptFile, prompt, "utf8");
    await writeFile(requestFile, JSON.stringify(requestPayload, null, 2), "utf8");

    const vars = withRuntimeTemplateVars({
      request_id: request.requestId,
      provider_id: this.id,
      model: request.model,
      provider_model: modelConfig.providerModel || request.providerModel,
      reasoning_effort: request.reasoningEffort || "",
      reasoningEffort: request.reasoningEffort || "",
      prompt,
      prompt_file: promptFile,
      request_file: requestFile,
    });

    const MAX_ARG_PROMPT_BYTES = 100_000;
    const argsUsePrompt = this.config.responseCommand.args.some(
      (arg) => arg.includes("{{prompt}}"),
    );

    let commandSpec = this.config.responseCommand;
    if (argsUsePrompt && Buffer.byteLength(prompt, "utf8") > MAX_ARG_PROMPT_BYTES) {
      const isShellCommand =
        this.config.responseCommand.executable === "sh" ||
        this.config.responseCommand.executable === "bash" ||
        this.config.responseCommand.executable === "zsh";
      const rewrittenArgs = this.config.responseCommand.args.map((arg) => {
        if (!arg.includes("{{prompt}}")) {
          return arg;
        }
        if (isShellCommand) {
          return arg.replace(/\{\{\s*prompt\s*\}\}/g, "$(cat '{{prompt_file}}')");
        }
        return arg.replace(/\{\{\s*prompt\s*\}\}/g, "{{prompt_file}}");
      });
      commandSpec = { ...this.config.responseCommand, args: rewrittenArgs };
    }

    const timeoutMsOverride = readPositiveIntegerMetadata(
      request.metadata,
      "gateway_benchmark_timeout_ms",
    );
    const imageRequestTimeoutMs =
      request.requestKind === "images_generations"
        ? parsePositiveIntegerEnv("CODEX_APPSERVER_IMAGE_NO_PROGRESS_TIMEOUT_MS", 90_000) +
          parsePositiveIntegerEnv("CODEX_APPSERVER_IMAGE_COMMAND_GRACE_MS", 15_000)
        : undefined;
    const effectiveTimeoutMsOverride = minDefinedPositiveInteger(timeoutMsOverride, imageRequestTimeoutMs);
    if (effectiveTimeoutMsOverride !== undefined) {
      commandSpec = {
        ...commandSpec,
        timeoutMs: Math.min(commandSpec.timeoutMs, effectiveTimeoutMsOverride),
      };
    }

    return {
      tmpDir,
      resolved: resolveCommand(commandSpec, vars),
      stdinPayload:
        this.config.responseCommand.input === "request_json_stdin"
          ? JSON.stringify(requestPayload)
          : prompt,
    };
  }

  private usesCodexAppServerBridge(): boolean {
    return this.config.responseCommand.args.some((arg) =>
      arg.includes("codex-appserver-bridge.js"),
    );
  }

  async startLoginJob(jobManager: JobManager): Promise<LoginJobSummary> {
    const command = this.config.auth?.loginCommand;
    if (!command) {
      throw new Error(`Provider ${this.id} does not define auth.loginCommand.`);
    }

    return await jobManager.startCommand(this.id, command, {
      provider_id: this.id,
    });
  }

  async checkAuthStatus(): Promise<AuthStatusResult> {
    const command = this.config.auth?.statusCommand;
    if (!command) {
      return {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "auth.statusCommand not configured",
      };
    }

    const resolved = resolveCommand(command, withRuntimeTemplateVars({
      provider_id: this.id,
    }));
    const output = await runCommand(resolved);
    return {
      ok: output.exitCode === 0 && !output.timedOut,
      exitCode: output.exitCode,
      stdout: output.stdout,
      stderr: output.stderr,
    };
  }

  async checkRateLimits(): Promise<ProviderRateLimits> {
    const command = this.config.auth?.rateLimitCommand;
    const now = new Date().toISOString();

    // If no rate limit command configured, return unknown status
    if (!command) {
      return {
        providerId: this.id,
        providerDescription: this.description,
        status: "unknown",
        limits: [],
        lastCheckedAt: now,
      };
    }

    try {
      const resolved = resolveCommand(command, withRuntimeTemplateVars({
        provider_id: this.id,
      }));
      const output = await runCommand(resolved);

      if (output.timedOut) {
        return {
          providerId: this.id,
          providerDescription: this.description,
          status: "unknown",
          limits: [{
            providerId: this.id,
            limitType: "unknown",
            checkedAt: now,
            ok: false,
            error: `Rate limit check timed out after ${resolved.timeoutMs}ms`,
          }],
          lastCheckedAt: now,
        };
      }

      if (output.exitCode !== 0) {
        return {
          providerId: this.id,
          providerDescription: this.description,
          status: "auth_error",
          limits: [{
            providerId: this.id,
            limitType: "unknown",
            checkedAt: now,
            ok: false,
            error: `Rate limit check failed with exit code ${output.exitCode}: ${output.stderr}`,
          }],
          lastCheckedAt: now,
        };
      }

      // Try to parse the output as rate limit info
      const limits = this.parseRateLimitOutput(output.stdout, now);
      const hasLimited = limits.some(l => l.remaining !== undefined && l.remaining <= 0);
      const hasErrors = limits.some(l => !l.ok);

      let status: ProviderRateLimits["status"] = "healthy";
      if (hasErrors) {
        status = "unknown";
      } else if (hasLimited) {
        status = "rate_limited";
      } else if (limits.some(l => l.remaining !== undefined && l.remaining < 100)) {
        status = "degraded";
      }

      return {
        providerId: this.id,
        providerDescription: this.description,
        status,
        limits,
        lastCheckedAt: now,
      };
    } catch (error) {
      return {
        providerId: this.id,
        providerDescription: this.description,
        status: "unknown",
        limits: [{
          providerId: this.id,
          limitType: "unknown",
          checkedAt: now,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }],
        lastCheckedAt: now,
      };
    }
  }

  private parseRateLimitOutput(stdout: string, checkedAt: string): RateLimitInfo[] {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return [{
        providerId: this.id,
        limitType: "unknown",
        checkedAt,
        ok: true,
        raw: { stdout: "" },
      }];
    }

    // Try to parse as JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Not JSON, treat as plain text
      return [{
        providerId: this.id,
        limitType: "unknown",
        checkedAt,
        ok: true,
        raw: { stdout: trimmed },
      }];
    }

    // Handle array of limits
    if (Array.isArray(parsed)) {
      return parsed.map(item => this.normalizeRateLimitItem(item, checkedAt));
    }

    // Handle single limit object
    if (parsed && typeof parsed === "object") {
      // Check if it has a "limits" array property
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.limits)) {
        return obj.limits.map(item => this.normalizeRateLimitItem(item, checkedAt));
      }
      return [this.normalizeRateLimitItem(parsed, checkedAt)];
    }

    return [{
      providerId: this.id,
      limitType: "unknown",
      checkedAt,
      ok: true,
      raw: parsed,
    }];
  }

  private normalizeRateLimitItem(item: unknown, checkedAt: string): RateLimitInfo {
    if (!item || typeof item !== "object") {
      return {
        providerId: this.id,
        limitType: "unknown",
        checkedAt,
        ok: true,
        raw: item,
      };
    }

    const obj = item as Record<string, unknown>;

    // Determine limit type
    let limitType: RateLimitInfo["limitType"] = "unknown";
    const typeStr = typeof obj.limitType === "string" ? obj.limitType.toLowerCase() : "";
    if (typeStr.includes("request")) {
      limitType = "requests";
    } else if (typeStr.includes("token")) {
      limitType = "tokens";
    } else if (typeStr.includes("credit") || typeStr.includes("billing")) {
      limitType = "credits";
    }

    return {
      providerId: this.id,
      modelId: typeof obj.modelId === "string" ? obj.modelId : undefined,
      limitType,
      currentUsage: typeof obj.currentUsage === "number" ? obj.currentUsage : undefined,
      maxAllowed: typeof obj.maxAllowed === "number" ? obj.maxAllowed : undefined,
      remaining: typeof obj.remaining === "number" ? obj.remaining : undefined,
      resetAt: typeof obj.resetAt === "string" ? obj.resetAt : undefined,
      checkedAt,
      ok: obj.ok !== false, // default to true if not specified
      error: typeof obj.error === "string" ? obj.error : undefined,
      raw: item,
    };
  }

  private parseOutput(stdout: string): ProviderResult {
    const mode = this.config.responseCommand.output;
    if (mode === "text_plain") {
      return normalizeAssistantResult({
        outputText: stdout.trim(),
        toolCalls: [],
        finishReason: "stop",
      });
    }

    if (mode === "text_contract_final_line") {
      let contract = tryParseJsonContractFromFinalLine(stdout);
      if (!contract) {
        // Fallback for models (like Gemini) that disobey instructions and wrap JSON in markdown blocks
        contract = tryParseJsonContractFromText(stdout);
      }
      if (contract && (contract.output_text || contract.text || contract.content || contract.tool_calls?.length)) {
        const toolCalls = normalizeToolCalls(contract.tool_calls);
        return normalizeAssistantResult({
          outputText: (contract.output_text ?? contract.text ?? contract.content ?? "").trim(),
          reasoningText: normalizeReasoningText(contract.reasoning),
          toolCalls,
          finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
          usage: normalizeProviderUsage(contract.usage, "cli-contract"),
          raw: contract,
        });
      }

      return normalizeAssistantResult({
        outputText: stdout.trim(),
        toolCalls: [],
        finishReason: "stop",
      });
    }

    if (mode === "text") {
      // Allow text-mode providers to opt into tool calling by emitting the JSON contract.
      const contract = tryParseJsonContractFromText(stdout);
      if (contract && (contract.output_text || contract.text || contract.content || contract.tool_calls?.length)) {
        const toolCalls = normalizeToolCalls(contract.tool_calls);
        return normalizeAssistantResult({
          outputText: (contract.output_text ?? contract.text ?? contract.content ?? "").trim(),
          reasoningText: normalizeReasoningText(contract.reasoning),
          toolCalls,
          finishReason:
            contract.finish_reason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
          usage: normalizeProviderUsage(contract.usage, "cli-contract"),
          raw: contract,
        });
      }

      return normalizeAssistantResult({
        outputText: stdout.trim(),
        toolCalls: [],
        finishReason: "stop",
      });
    }

    const json = tryParseJsonContract(stdout);
    const toolCalls = normalizeToolCalls(json.tool_calls);
    const reasoningText = normalizeReasoningText(json.reasoning);

    const outputText = (json.output_text ?? json.text ?? json.content ?? "").trim();
    const finishReason =
      json.finish_reason ??
      (toolCalls.length > 0 ? "tool_calls" : "stop");

    // Some provider wrappers return a valid outer contract whose output_text is itself
    // another contract string. Promote the nested contract so callers receive clean text.
    const nestedContract = tryParseJsonContractFromText(outputText);
    if (nestedContract) {
      const nestedToolCalls = normalizeToolCalls(nestedContract.tool_calls);
      const promotedToolCalls =
        nestedToolCalls.length > 0 ? nestedToolCalls : toolCalls;
      const promotedOutputText = (
        nestedContract.output_text ??
        nestedContract.text ??
        nestedContract.content ??
        outputText
      ).trim();
      const promotedFinishReason =
        nestedContract.finish_reason ??
        (promotedToolCalls.length > 0 ? "tool_calls" : finishReason);
      const promotedReasoningText =
        normalizeReasoningText(nestedContract.reasoning) ?? reasoningText;

      return normalizeAssistantResult({
        outputText: promotedOutputText,
        reasoningText: promotedReasoningText,
        toolCalls: promotedToolCalls,
        finishReason: promotedFinishReason,
        usage: normalizeProviderUsage(nestedContract.usage, "cli-contract") ?? normalizeProviderUsage(json.usage, "cli-contract"),
        raw: json,
      });
    }

    return normalizeAssistantResult({
      outputText,
      reasoningText,
      toolCalls,
      finishReason,
      usage: normalizeProviderUsage(json.usage, "cli-contract"),
      raw: json,
    });
  }
}

function readPositiveIntegerMetadata(
  metadata: UnifiedRequest["metadata"],
  key: string,
): number | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const value = metadata[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parsePositiveIntegerEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (typeof raw !== "string" || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function minDefinedPositiveInteger(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter(
    (value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0,
  );
  return defined.length > 0 ? Math.min(...defined) : undefined;
}

function parseJsonStreamEvent(line: string): ProviderStreamEvent | null {
  if (!line) {
    return null;
  }

  let parsed: JsonStreamContract;
  try {
    parsed = JSON.parse(line) as JsonStreamContract;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.type !== "string") {
    return null;
  }

  if (parsed.type === "reasoning_delta" || parsed.type === "output_text_delta") {
    return typeof parsed.delta === "string" && parsed.delta
      ? {
        type: parsed.type,
        delta: parsed.delta,
      }
      : null;
  }

  if (parsed.type === "tool_call") {
    const toolCall = normalizeSingleToolCall(parsed.tool_call);
    return toolCall
      ? {
        type: "tool_call",
        toolCall,
      }
      : null;
  }

  if (parsed.type === "done") {
    const parsedRecord = parsed as Record<string, unknown>;
    return {
      type: "done",
      finishReason: normalizeFinishReasonValue(parsed.finish_reason),
      outputText:
        typeof parsed.output_text === "string" && parsed.output_text
          ? parsed.output_text
          : undefined,
      reasoningText: normalizeReasoningText(extractReasoningValue(parsedRecord)),
      usage: normalizeProviderUsage(parsedRecord.usage, "cli-stream"),
    };
  }

  return null;
}

function normalizeResultToolCalls(
  result: ProviderResult,
  tools: UnifiedToolDefinition[],
): ProviderResult {
  const allowedTools = extractAllowedTools(tools);
  if (result.toolCalls.length === 0) {
    return result;
  }

  // When no tool definitions were provided by the caller, pass through
  // whatever tool calls the provider returned. Previously this branch
  // silently dropped ALL tool calls and rewrote finish_reason to "stop",
  // which caused agents to lose tool-calling ability on subsequent turns
  // when n8n didn't re-send the tools array.
  if (allowedTools.size === 0) {
    return result;
  }

  const mappedToolCalls: ProviderToolCall[] = [];
  for (const call of result.toolCalls) {
    const toolMeta = resolveAllowedToolMeta(call.name, allowedTools);
    if (!toolMeta) {
      continue;
    }
    mappedToolCalls.push({
      ...call,
      name: toolMeta.name,
      arguments: canonicalizeArgumentsForTool(call.arguments, toolMeta.argumentKeyMap),
    });
  }

  return {
    ...result,
    toolCalls: mappedToolCalls,
    finishReason:
      mappedToolCalls.length > 0
        ? result.finishReason
        : result.finishReason === "tool_calls"
          ? "stop"
          : result.finishReason,
  };
}

function normalizeStreamToolEvent(
  event: ProviderStreamEvent,
  allowedTools: Map<string, AllowedToolMeta>,
): ProviderStreamEvent {
  if (event.type !== "tool_call") {
    return event;
  }

  if (allowedTools.size === 0) {
    return event;
  }

  const toolMeta = resolveAllowedToolMeta(event.toolCall.name, allowedTools);
  if (!toolMeta) {
    return event;
  }

  return {
    type: "tool_call",
    toolCall: {
      ...event.toolCall,
      name: toolMeta.name,
      arguments: canonicalizeArgumentsForTool(event.toolCall.arguments, toolMeta.argumentKeyMap),
    },
  };
}

type AllowedToolMeta = {
  name: string;
  argumentKeyMap: Map<string, string>;
};



function resolveAllowedToolMeta(
  rawName: string,
  allowedTools: Map<string, AllowedToolMeta>,
): AllowedToolMeta | null {
  const direct = allowedTools.get(normalizeToolName(rawName));
  if (direct) {
    return direct;
  }

  const alias = allowedTools.get(normalizeToolAlias(rawName));
  if (alias) {
    return alias;
  }

  if (allowedTools.size === 1) {
    const only = allowedTools.values().next().value;
    return only ?? null;
  }

  return null;
}

function extractAllowedTools(tools: UnifiedToolDefinition[]): Map<string, AllowedToolMeta> {
  const out = new Map<string, AllowedToolMeta>();
  for (const item of tools) {
    if (!item || item.type !== "function") {
      continue;
    }
    const name = typeof item.function.name === "string" ? item.function.name.trim() : "";
    if (!name) {
      continue;
    }
    out.set(normalizeToolName(name), {
      name,
      argumentKeyMap: buildArgumentKeyMap(item.function.parameters),
    });
  }
  return out;
}



function buildArgumentKeyMap(parameters: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!parameters || typeof parameters !== "object") {
    return out;
  }
  const props = (parameters as Record<string, unknown>).properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    return out;
  }
  for (const key of Object.keys(props as Record<string, unknown>)) {
    if (!key) {
      continue;
    }
    out.set(normalizeArgumentKey(key), key);
  }
  return out;
}

function canonicalizeArgumentsForTool(
  rawArgs: string,
  argumentKeyMap: Map<string, string>,
): string {
  if (argumentKeyMap.size === 0) {
    return rawArgs;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    return rawArgs;
  }

  const sanitized = sanitizeArgumentKeys(parsed);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    try {
      return JSON.stringify(sanitized ?? {});
    } catch {
      return rawArgs;
    }
  }

  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(sanitized as Record<string, unknown>)) {
    const trimmedKey = String(rawKey ?? "").trim();
    const canonicalKey =
      argumentKeyMap.get(normalizeArgumentKey(trimmedKey)) ?? trimmedKey;
    out[canonicalKey] = value;
  }

  try {
    return JSON.stringify(out);
  } catch {
    return rawArgs;
  }
}

function buildPromptWithTools(prompt: string, tools: UnifiedToolDefinition[]): string {
  if (!tools.length) {
    return prompt;
  }

  const toolSpec = JSON.stringify(tools, null, 2);
  return [
    prompt,
    "",
    "AVAILABLE_TOOLS_JSON:",
    toolSpec,
    "",
    "TOOL: messages are outputs from previous tool calls.",
    "When TOOL: messages are present and no more tools are needed, answer the user in output_text.",
    "Do not copy placeholder or example text into output_text.",
    "When possible, include a concise public reasoning summary in the optional reasoning field.",
    "Do not reveal private chain-of-thought; use reasoning only for a short high-level summary.",
    "",
    "If a tool is needed, respond ONLY with valid JSON in this exact shape:",
    '{"output_text":"","reasoning":"brief public reasoning summary","tool_calls":[{"id":"call_1","name":"tool_name","arguments":"{\\"key\\":\\"value\\"}"}],"finish_reason":"tool_calls"}',
    "",
    'If no tool is needed, respond ONLY with valid JSON containing a real user-facing answer in output_text, optional reasoning, and "finish_reason":"stop".',
  ].join("\n");
}

function tryParseJsonContract(stdout: string): JsonContract {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("Provider returned empty output while json_contract mode is enabled.");
  }

  try {
    return normalizeContract(JSON.parse(trimmed));
  } catch {
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      const candidate = line.trim();
      if (!candidate) {
        continue;
      }
      try {
        return normalizeContract(JSON.parse(candidate));
      } catch {
        continue;
      }
    }
  }

  throw new Error("Unable to parse provider JSON output. Check responseCommand.output mode.");
}

function tryParseJsonContractSoft(stdout: string): JsonContract | null {
  try {
    return tryParseJsonContract(stdout);
  } catch {
    return null;
  }
}

function tryParseJsonContractFromText(value: string): JsonContract | null {
  if (!value.trim()) {
    return null;
  }

  for (const candidate of extractJsonTextCandidates(value)) {
    const contract = tryParseJsonContractSoft(candidate);
    if (!contract) {
      continue;
    }
    if (
      contract.output_text !== undefined ||
      contract.text !== undefined ||
      contract.content !== undefined ||
      contract.finish_reason !== undefined ||
      contract.tool_calls !== undefined
    ) {
      return contract;
    }
  }

  return null;
}

function extractFinalNonEmptyLine(input: string): string | null {
  const lines = input.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (line) {
      return line;
    }
  }
  return null;
}

function tryParseJsonContractFromFinalLine(value: string): JsonContract | null {
  const finalLine = extractFinalNonEmptyLine(value);
  if (!finalLine) {
    return null;
  }
  return tryParseJsonContractSoft(finalLine);
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
  let match: RegExpExecArray | null = null;
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

function normalizeContract(value: unknown): JsonContract {
  if (!value || typeof value !== "object") {
    throw new Error("Provider JSON output must be an object.");
  }

  const source = value as Record<string, unknown>;
  return {
    output_text:
      typeof source.output_text === "string" ? source.output_text : undefined,
    text: typeof source.text === "string" ? source.text : undefined,
    content: typeof source.content === "string" ? source.content : undefined,
    reasoning: extractReasoningValue(source),
    tool_calls: Array.isArray(source.tool_calls) ? source.tool_calls : undefined,
    finish_reason:
      source.finish_reason === "stop" ||
        source.finish_reason === "tool_calls" ||
        source.finish_reason === "length" ||
        source.finish_reason === "error"
        ? source.finish_reason
        : undefined,
    usage: source.usage,
  };
}

function normalizeToolCalls(rawToolCalls: unknown[] | undefined): ProviderToolCall[] {
  if (!rawToolCalls || rawToolCalls.length === 0) {
    return [];
  }

  const calls: ProviderToolCall[] = [];
  for (const entry of rawToolCalls) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const obj = entry as Record<string, unknown>;
    const functionObj =
      obj.function && typeof obj.function === "object"
        ? (obj.function as Record<string, unknown>)
        : undefined;

    const idCandidate =
      (typeof obj.id === "string" && obj.id) ||
      (typeof obj.call_id === "string" && obj.call_id) ||
      (typeof obj.tool_id === "string" && obj.tool_id) ||
      (typeof obj.toolId === "string" && obj.toolId) ||
      undefined;
    const nameCandidate =
      (typeof obj.name === "string" && obj.name) ||
      (typeof obj.tool_name === "string" && obj.tool_name) ||
      (typeof obj.toolName === "string" && obj.toolName) ||
      (functionObj && typeof functionObj.name === "string" ? functionObj.name : undefined);
    const argsRaw =
      obj.arguments ??
      obj.args ??
      obj.parameters ??
      (functionObj ? functionObj.arguments : undefined) ??
      (functionObj ? functionObj.args : undefined) ??
      "{}";

    const nested = extractNestedToolCall(argsRaw);
    if (nested) {
      calls.push({
        id: idCandidate ?? nested.id ?? `call_${calls.length + 1}`,
        name: nested.name || nameCandidate || "tool",
        arguments: nested.arguments,
      });
      continue;
    }

    if (!nameCandidate) {
      continue;
    }

    const args = asToolCallArguments(argsRaw);
    if (args === null) {
      continue; // Skip invalid tool call arguments
    }

    calls.push({
      id: idCandidate ?? `call_${calls.length + 1}`,
      name: nameCandidate,
      arguments: args,
    });
  }

  return calls;
}

function normalizeSingleToolCall(value: unknown): ProviderToolCall | null {
  const normalized = normalizeToolCalls(Array.isArray(value) ? value : value ? [value] : undefined);
  return normalized[0] ?? null;
}

function normalizeFinishReasonValue(value: unknown): ProviderResult["finishReason"] {
  return value === "tool_calls" || value === "length" || value === "error" ? value : "stop";
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

function normalizeReasoningText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  if (Array.isArray(value)) {
    const joined = value
      .map((entry) => normalizeReasoningText(entry))
      .filter((entry): entry is string => Boolean(entry))
      .join("\n\n")
      .trim();
    return joined || undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const candidates = [
    record.reasoning,
    record.reasoning_content,
    record.reasoningContent,
    record.reasoning_text,
    record.reasoningText,
    record.summary,
    record.summary_text,
    record.summaryText,
    record.text,
    record.content,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeReasoningText(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

function sanitizeArgumentKeys(value: unknown, depth = 0): unknown {
  if (depth > 20) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeArgumentKeys(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [rawKey, rawVal] of Object.entries(value as Record<string, unknown>)) {
      const trimmedKey = String(rawKey ?? "").trim();
      const key = trimmedKey || String(rawKey ?? "");
      out[key] = sanitizeArgumentKeys(rawVal, depth + 1);
    }
    return out;
  }
  return value;
}

function asToolCallArguments(value: unknown): string {
  if (value === null || value === undefined) {
    return "{}";
  }

  if (typeof value === "string") {
    let trimmed = value.trim();
    if (!trimmed) {
      return "{}";
    }

    // Sometimes LLMs return markdown-wrapped JSON for arguments
    if (trimmed.startsWith("```json")) {
      trimmed = trimmed.replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
    } else if (trimmed.startsWith("```")) {
      trimmed = trimmed.replace(/^```\s*/, "").replace(/\s*```$/, "").trim();
    }

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.stringify(sanitizeArgumentKeys(JSON.parse(trimmed)));
      } catch {
        // Attempt lightweight JSON repair
        try {
          let repaired = trimmed;
          // 1. Remove trailing commas before closing braces/brackets
          repaired = repaired.replace(/,\s*([}\]])/g, "$1");
          // 2. Escape literal newlines within the string (JSON requires \n)
          // Note: This is rudimentary. A full JSON parser would be better, but 
          // this catches the most common formatting errors from text-based LLMs.
          repaired = repaired.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");

          return JSON.stringify(sanitizeArgumentKeys(JSON.parse(repaired)));
        } catch {
          // If we still can't parse it, it's malformed beyond simple repair.
          // We MUST return the raw string so n8n can catch the JSON parse error
          // and feed it back to the LLM. If we drop the tool call entirely,
          // the agent loop silently exits!
          return trimmed;
        }
      }
    }

    // If it's a string, didn't start with { or [ and couldn't be parsed, it's invalid.
    return trimmed;
  }

  try {
    return JSON.stringify(sanitizeArgumentKeys(value));
  } catch {
    return "{}";
  }
}

function extractNestedToolCall(
  value: unknown,
): { id?: string; name: string; arguments: string } | null {
  const queue: unknown[] = [value];
  const seen = new Set<string>();

  for (let i = 0; i < queue.length && i < 80; i += 1) {
    const current = queue[i];
    if (!current) {
      continue;
    }

    if (typeof current === "string") {
      const text = current.trim();
      if (!text || seen.has(text)) {
        continue;
      }
      seen.add(text);

      for (const candidate of jsonCandidates(text)) {
        if (seen.has(candidate)) {
          continue;
        }
        seen.add(candidate);
        let parsed: unknown;
        try {
          parsed = JSON.parse(candidate);
        } catch {
          continue;
        }
        queue.push(parsed);
      }
      continue;
    }

    if (typeof current !== "object") {
      continue;
    }

    const obj = current as Record<string, unknown>;
    const toolCalls = normalizeToolCallsShallow(
      Array.isArray(obj.tool_calls) ? obj.tool_calls : undefined,
    );
    if (toolCalls.length > 0) {
      const first = toolCalls[0];
      if (first) {
        return first;
      }
    }

    if (typeof obj.response === "string") {
      queue.push(obj.response);
    }
    if (
      obj.message &&
      typeof obj.message === "object" &&
      typeof (obj.message as Record<string, unknown>).content === "string"
    ) {
      queue.push((obj.message as Record<string, unknown>).content);
    }
    if (typeof obj.output_text === "string") {
      queue.push(obj.output_text);
    }
    if (typeof obj.text === "string") {
      queue.push(obj.text);
    }
    if (typeof obj.content === "string") {
      queue.push(obj.content);
    }

    for (const v of Object.values(obj)) {
      if (typeof v === "string") {
        queue.push(v);
      }
    }
  }

  return null;
}

function jsonCandidates(input: string): string[] {
  const out: string[] = [];
  const trimmed = input.trim();
  if (trimmed) {
    out.push(trimmed);
  }

  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(input)) !== null) {
    const candidate = match[1]?.trim();
    if (candidate) {
      out.push(candidate);
    }
  }

  const start = input.indexOf("{");
  const end = input.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const body = input.slice(start, end + 1).trim();
    if (body) {
      out.push(body);
    }
  }

  return out;
}

function normalizeToolCallsShallow(
  rawToolCalls: unknown[] | undefined,
): Array<{ id?: string; name: string; arguments: string }> {
  if (!rawToolCalls || rawToolCalls.length === 0) {
    return [];
  }

  const out: Array<{ id?: string; name: string; arguments: string }> = [];
  for (const entry of rawToolCalls) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const obj = entry as Record<string, unknown>;
    const fn =
      obj.function && typeof obj.function === "object"
        ? (obj.function as Record<string, unknown>)
        : undefined;
    const name =
      (typeof obj.name === "string" && obj.name) ||
      (typeof obj.tool_name === "string" && obj.tool_name) ||
      (typeof obj.toolName === "string" && obj.toolName) ||
      (fn && typeof fn.name === "string" ? fn.name : "");
    if (!name) {
      continue;
    }
    const argsRaw =
      obj.arguments ??
      obj.args ??
      obj.parameters ??
      (fn ? fn.arguments : undefined) ??
      (fn ? fn.args : undefined) ??
      {};

    const normalizedArgs = asToolCallArguments(argsRaw);

    out.push({
      id:
        (typeof obj.id === "string" && obj.id) ||
        (typeof obj.call_id === "string" && obj.call_id) ||
        (typeof obj.tool_id === "string" && obj.tool_id) ||
        (typeof obj.toolId === "string" && obj.toolId) ||
        undefined,
      name,
      arguments: normalizedArgs,
    });
  }

  return out;
}
