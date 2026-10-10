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
import { strictToolCalls, requireOfferedTool, ToolContractError, validateToolHistory } from "../utils/tool-contract.js";
import { normalizeAssistantResult, normalizeNativeAssistantResult } from "../utils/assistant-output";
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
    request.signal?.throwIfAborted();
    const prepared = await this.prepareCommandExecution(request);
    try {
      request.signal?.throwIfAborted(); request.execution?.dispatch();
      const output = await runCommand(prepared.resolved, prepared.stdinPayload, request.signal, absent => request.execution?.cleanup(absent));
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
      let bytes = 0;
      let terminal: Extract<ProviderStreamEvent, {type:"done"}> | undefined;
      const calls: ProviderToolCall[] = [];
      const accept = (event: ProviderStreamEvent): ProviderStreamEvent | undefined => {
        if (terminal) throw new ToolContractError("data_after_done", event);
        normalizeStreamToolEvent(event, allowedTools);
        if (event.type === "tool_call") { calls.push(event.toolCall); strictToolCalls(calls); return; }
        if (event.type === "done") { terminal = event; return; }
        return event;
      };
      request.signal?.throwIfAborted(); request.execution?.dispatch();
      for await (const event of runCommandStream(prepared.resolved, prepared.stdinPayload, request.signal, absent => request.execution?.cleanup(absent))) {
        if (event.stream !== "stdout") {
          if (isTruthyEnv(process.env.CODEX_APPSERVER_DEBUG_RPC) && event.chunk) {
            process.stderr.write(event.chunk);
          }
          continue;
        }

        bytes += Buffer.byteLength(event.chunk);
        if (bytes > 2097152) throw new ToolContractError("stream_oversized", bytes);
        pendingStdout += event.chunk;
        let newlineIndex = pendingStdout.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = pendingStdout.slice(0, newlineIndex).trim();
          pendingStdout = pendingStdout.slice(newlineIndex + 1);
          const parsedEvent = parseJsonStreamEvent(line);
          if (parsedEvent) {
            const accepted = accept(parsedEvent); if (accepted) yield accepted;
          }
          newlineIndex = pendingStdout.indexOf("\n");
        }
      }

      const trailingEvent = parseJsonStreamEvent(pendingStdout.trim());
      if (trailingEvent) {
        const accepted = accept(trailingEvent); if (accepted) yield accepted;
      }
      request.signal?.throwIfAborted();
      if (!terminal) throw new ToolContractError("stream_missing_done", calls);
      const final = terminal as Extract<ProviderStreamEvent, {type:"done"}>;
      if ((calls.length > 0) !== (final.finishReason === "tool_calls")) throw new ToolContractError("finish_reason_mismatch", final);
      for (const call of calls) yield {type:"tool_call",toolCall:call};
      yield final;
    } finally {
      await rm(prepared.tmpDir, { recursive: true, force: true });
    }
  }

  private async prepareCommandExecution(request: UnifiedRequest): Promise<{
    tmpDir: string;
    resolved: ReturnType<typeof resolveCommand>;
    stdinPayload: string;
  }> {
    validateToolHistory(request.messages);
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

    // Internal execution controls never enter provider JSON or retained prompt files.
    const { execution: _execution, signal: _signal, receipt: _receipt, receivedAt: _receivedAt, ...providerRequest } = request;
    const requestPayload = { ...providerRequest, prompt };

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

    return normalizeNativeAssistantResult({
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
    throw new ToolContractError("stream_invalid_json", line);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.type !== "string") {
    throw new ToolContractError("stream_invalid_event", parsed);
  }

  if (parsed.type === "reasoning_delta" || parsed.type === "output_text_delta") {
    if (typeof parsed.delta !== "string") throw new ToolContractError("stream_invalid_delta", parsed);
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

  throw new ToolContractError("stream_unknown_event", parsed);
}

function normalizeResultToolCalls(result: ProviderResult, tools: UnifiedToolDefinition[]): ProviderResult {
  const names = extractAllowedTools(tools);
  strictToolCalls(result.toolCalls);
  if ((result.toolCalls.length > 0) !== (result.finishReason === "tool_calls")) throw new ToolContractError("finish_reason_mismatch", result.raw);
  for (const call of result.toolCalls) requireOfferedTool(call, names);
  return result;
}

function normalizeStreamToolEvent(event: ProviderStreamEvent, names: Set<string>): ProviderStreamEvent {
  if (event.type === "tool_call") requireOfferedTool(event.toolCall, names);
  return event;
}

function extractAllowedTools(tools: UnifiedToolDefinition[]): Set<string> {
  return new Set(tools.filter(item => item.type === "function").map(item => item.function.name));
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
  if (source.tool_calls !== undefined && !Array.isArray(source.tool_calls)) throw new ToolContractError("calls_not_bounded_array", source.tool_calls);
  if (source.finish_reason !== undefined && !["stop","tool_calls","length","error"].includes(String(source.finish_reason))) throw new ToolContractError("finish_reason_invalid", source.finish_reason);
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
  return strictToolCalls(rawToolCalls);
}

function normalizeSingleToolCall(value: unknown): ProviderToolCall | null {
  const normalized = strictToolCalls([value]);
  return normalized[0] ?? null;
}

function normalizeFinishReasonValue(value: unknown): ProviderResult["finishReason"] {
  if (value !== "stop" && value !== "tool_calls" && value !== "length" && value !== "error") throw new ToolContractError("finish_reason_invalid", value);
  return value;
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
