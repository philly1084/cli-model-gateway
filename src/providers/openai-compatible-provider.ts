import type { JobManager } from "../jobs/job-manager";
import type {
  AuthStatusResult,
  LoginJobSummary,
  OpenAiCompatibleProviderConfig,
  ProviderModelConfig,
  ProviderRateLimits,
  ProviderResult,
  ProviderToolCall,
  UnifiedRequest,
} from "../types";
import { normalizeAssistantResult } from "../utils/assistant-output";
import { extractTextContent } from "../utils/prompt";
import type { Provider } from "./provider";
import { normalizeProviderUsage } from "../utils/usage";

const DEFAULT_TIMEOUT_MS = 240000;
const DEFAULT_DISCOVERY_EXCLUDES = [
  "*whisper*",
  "*transcribe*",
  "*transcription*",
  "*speech*",
  "*tts*",
  "*guard*",
];
const REMOTE_SESSION_METADATA_KEYS = [
  "session_id",
  "sessionId",
  "conversation_id",
  "conversationId",
  "thread_id",
  "threadId",
  "previous_response_id",
  "previousResponseId",
  "response_id",
  "responseId",
] as const;
const REMOTE_STRING_METADATA_KEYS = [
  ...REMOTE_SESSION_METADATA_KEYS,
  "clientSurface",
  "taskType",
  "stickyRemote",
  "lastRemoteObjective",
] as const;
const REMOTE_BOOLEAN_METADATA_KEYS = [
  "remoteBuildAutonomyApproved",
  "frontendRemoteBuildAutonomyApproved",
] as const;

type ApiMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  reasoning_content?: unknown;
  tool_calls?: Array<{
    id?: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

type ProviderRequestInit = {
  method: string;
  body?: string;
  headers?: Record<string, string>;
};

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

export class OpenAiCompatibleProvider implements Provider {
  readonly id: string;
  readonly description?: string;
  readonly config: OpenAiCompatibleProviderConfig;
  readonly models: ProviderModelConfig[];

  private constructor(config: OpenAiCompatibleProviderConfig, models: ProviderModelConfig[]) {
    this.id = config.id;
    this.description = config.description;
    this.config = config;
    this.models = models;
  }

  static async create(
    config: OpenAiCompatibleProviderConfig,
  ): Promise<OpenAiCompatibleProvider> {
    const models = await resolveProviderModels(config);
    if (models.length === 0) {
      throw new Error(`Provider ${config.id} resolved zero models.`);
    }
    return new OpenAiCompatibleProvider(config, models);
  }

  async run(request: UnifiedRequest): Promise<ProviderResult> {
    const modelConfig = this.models.find((model) => model.id === request.model);
    if (!modelConfig) {
      throw new Error(`Provider ${this.id} does not expose model ${request.model}.`);
    }

    const providerModel = modelConfig.providerModel || request.providerModel;
    if (request.requestKind === "images_generations") {
      return await this.runImageGeneration(providerModel, request);
    }
    if (isKimiCodeApiBaseUrl(this.config.baseUrl)) {
      return await this.runKimiCodeAnthropicMessages(providerModel, request);
    }

    const suppressGroqLocalToolCalling = shouldSuppressGroqLocalToolCalling(
      this.config.baseUrl,
      providerModel,
    );
    if (shouldRejectGroqToolTurn(this.config.baseUrl, providerModel, request)) {
      throw new Error(
        `Model ${providerModel} does not reliably support gateway-managed tool calling. Retry with a fallback model.`,
      );
    }
    if (shouldRejectDeepSeekThinkingToolTurn(this.config.baseUrl, providerModel, request)) {
      throw new Error(
        `Model ${providerModel} requires reasoning_content round-tripping for thinking-mode tool calls. Retry with a fallback model.`,
      );
    }
    const body: Record<string, unknown> = {
      model: providerModel,
      messages: buildApiMessages(request.messages, {
        suppressLocalToolCalling: suppressGroqLocalToolCalling,
        preserveReasoningContent: isKimiK2ProviderModel(this.config.baseUrl, providerModel),
      }),
      stream: false,
    };

    const metadata = request.metadata;
    if (isKimiK2ProviderModel(this.config.baseUrl, providerModel)) {
      copyKimiK2Metadata(body, metadata, providerModel);
    } else {
      copyNumberMetadata(body, metadata, "temperature");
      copyNumberMetadata(body, metadata, "top_p");
      copyNumberMetadata(body, metadata, "presence_penalty");
      copyNumberMetadata(body, metadata, "frequency_penalty");
      copyIntegerMetadata(body, metadata, "max_tokens");
    }
    copyStringMetadata(body, metadata, "user");
    copyProviderReasoningMetadata(body, metadata, this.config.baseUrl, providerModel);

    if (shouldForwardRemoteMetadata(this.config.baseUrl)) {
      copyStringMetadataKeys(body, metadata, REMOTE_STRING_METADATA_KEYS);
      const forwardedMetadata = extractForwardedMetadata(metadata);
      if (forwardedMetadata) {
        body.metadata = forwardedMetadata;
      }
    }

    const groqReasoningEffort = normalizeGroqReasoningEffort(
      this.config.baseUrl,
      providerModel,
      request.reasoningEffort,
    );
    if (groqReasoningEffort) {
      body.reasoning_effort = groqReasoningEffort;
    }

    const toolChoice = metadata && "tool_choice" in metadata ? metadata.tool_choice : undefined;
    if (request.tools.length > 0 && !suppressGroqLocalToolCalling) {
      body.tools = request.tools;
      const providerToolChoice = normalizeToolChoiceForProvider(
        toolChoice,
        this.config.baseUrl,
        providerModel,
      );
      if (providerToolChoice !== undefined) {
        body.tool_choice = providerToolChoice;
      }
    }

    const response = await this.requestJson(
      "/chat/completions",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      readPositiveIntegerMetadata(metadata, "gateway_benchmark_timeout_ms"),
    );

    return parseChatCompletionResponse(response);
  }

  private async runKimiCodeAnthropicMessages(
    providerModel: string,
    request: UnifiedRequest,
  ): Promise<ProviderResult> {
    const { system, messages } = buildAnthropicMessages(request.messages);
    const body: Record<string, unknown> = {
      model: providerModel,
      max_tokens: readKimiCodeMaxTokens(request.metadata),
      messages,
    };
    if (system) {
      body.system = system;
    }
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters || { type: "object" },
      }));
      const toolChoice = normalizeAnthropicToolChoice(
        request.metadata && "tool_choice" in request.metadata
          ? request.metadata.tool_choice
          : undefined,
      );
      if (toolChoice) {
        body.tool_choice = toolChoice;
      }
    }

    const response = await this.requestJson(
      "/messages",
      {
        method: "POST",
        headers: {
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      },
      readPositiveIntegerMetadata(request.metadata, "gateway_benchmark_timeout_ms"),
    );

    return parseAnthropicMessagesResponse(response);
  }

  private async runImageGeneration(
    providerModel: string,
    request: UnifiedRequest,
  ): Promise<ProviderResult> {
    const prompt = buildImageGenerationPrompt(request);
    if (!prompt) {
      throw new Error("Image generation prompt is required.");
    }

    const body: Record<string, unknown> = {
      model: providerModel,
      prompt,
    };

    copyIntegerMetadata(body, request.metadata, "n");
    copyStringMetadata(body, request.metadata, "size");
    copyStringMetadata(body, request.metadata, "quality");
    copyStringMetadata(body, request.metadata, "style");
    copyStringMetadata(body, request.metadata, "background");
    copyStringMetadata(body, request.metadata, "output_format");
    copyStringMetadata(body, request.metadata, "response_format");
    copyStringMetadata(body, request.metadata, "user");

    const response = await this.requestJson(
      "/images/generations",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      readPositiveIntegerMetadata(request.metadata, "gateway_benchmark_timeout_ms"),
    );

    return {
      outputText: "",
      toolCalls: [],
      finishReason: "stop",
      raw: response,
    };
  }

  async startLoginJob(_jobManager: JobManager): Promise<LoginJobSummary> {
    throw new Error(
      `Provider ${this.id} uses API keys and does not support login jobs. Set ${this.config.apiKeyEnv} in the environment.`,
    );
  }

  async checkAuthStatus(): Promise<AuthStatusResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: `${this.config.apiKeyEnv} is not set`,
      };
    }

    try {
      await this.requestJson("/models", { method: "GET" });
      return {
        ok: true,
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      };
    } catch (error) {
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async checkRateLimits(): Promise<ProviderRateLimits> {
    return {
      providerId: this.id,
      providerDescription: this.description,
      status: "unknown",
      limits: [],
      lastCheckedAt: new Date().toISOString(),
    };
  }

  private getApiKey(): string {
    return process.env[this.config.apiKeyEnv]?.trim() || "";
  }

  private async requestJson(
    pathname: string,
    init: ProviderRequestInit,
    timeoutMsOverride?: number,
  ): Promise<unknown> {
    return await requestProviderJson(this.config, pathname, init, timeoutMsOverride);
  }
}

async function resolveProviderModels(
  config: OpenAiCompatibleProviderConfig,
): Promise<ProviderModelConfig[]> {
  const configuredModels = config.models ?? [];
  const shouldDiscover = config.discovery?.enabled ?? configuredModels.length === 0;
  if (!shouldDiscover) {
    return configuredModels;
  }

  try {
    const discoveredModels = await fetchDiscoveredModelIds(config);
    return mergeConfiguredAndDiscoveredModels(configuredModels, discoveredModels);
  } catch (error) {
    if (configuredModels.length > 0) {
      return configuredModels;
    }
    throw new Error(
      `Provider ${config.id} model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function fetchDiscoveredModelIds(
  config: OpenAiCompatibleProviderConfig,
): Promise<string[]> {
  const payload = await requestProviderJson(config, "/models", { method: "GET" });
  const data = extractModelList(payload);
  const includePatterns = config.discovery?.include ?? [];
  const excludePatterns =
    config.discovery?.exclude && config.discovery.exclude.length > 0
      ? config.discovery.exclude
      : DEFAULT_DISCOVERY_EXCLUDES;

  const discovered: string[] = [];
  for (const item of data) {
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) {
      continue;
    }

    if (item.active === false) {
      continue;
    }

    if (includePatterns.length > 0 && !includePatterns.some((pattern) => matchesPattern(id, pattern))) {
      continue;
    }

    if (excludePatterns.some((pattern) => matchesPattern(id, pattern))) {
      continue;
    }

    if (!discovered.includes(id)) {
      discovered.push(id);
    }
  }

  return discovered;
}

function mergeConfiguredAndDiscoveredModels(
  configuredModels: ProviderModelConfig[],
  discoveredModelIds: string[],
): ProviderModelConfig[] {
  const configuredByProviderModel = new Map<string, ProviderModelConfig>();
  const configuredById = new Map<string, ProviderModelConfig>();

  for (const model of configuredModels) {
    configuredByProviderModel.set(model.providerModel || model.id, model);
    configuredById.set(model.id, model);
  }

  const merged: ProviderModelConfig[] = [];
  const usedConfigured = new Set<ProviderModelConfig>();

  for (const discoveredId of discoveredModelIds) {
    const configured =
      configuredByProviderModel.get(discoveredId) ?? configuredById.get(discoveredId);
    if (configured) {
      merged.push(configured);
      usedConfigured.add(configured);
      continue;
    }

    merged.push({
      id: discoveredId,
      providerModel: discoveredId,
    });
  }

  for (const model of configuredModels) {
    if (!usedConfigured.has(model)) {
      merged.push(model);
    }
  }

  return merged;
}

function extractModelList(payload: unknown): Array<{ id?: unknown; active?: unknown }> {
  if (!payload || typeof payload !== "object") {
    throw new Error("Provider /models response must be an object.");
  }

  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error("Provider /models response is missing a data array.");
  }

  return data
    .filter((item): item is { id?: unknown; active?: unknown } => Boolean(item && typeof item === "object"));
}

function buildApiMessages(
  messages: UnifiedRequest["messages"],
  options?: { preserveReasoningContent?: boolean; suppressLocalToolCalling?: boolean },
): ApiMessage[] {
  const preserveReasoningContent = Boolean(options?.preserveReasoningContent);
  const suppressLocalToolCalling = Boolean(options?.suppressLocalToolCalling);
  return messages.flatMap((message) => {
    if (message.role === "assistant") {
      const parsed = splitAssistantToolContext(message.content);
      if (!suppressLocalToolCalling && parsed.toolCalls.length > 0) {
        const apiMessage: ApiMessage = {
          role: "assistant",
          content: parsed.content || null,
          tool_calls: parsed.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: call.arguments,
            },
          })),
        };
        if (preserveReasoningContent && message.reasoningContent !== undefined) {
          apiMessage.reasoning_content = message.reasoningContent;
        }
        return apiMessage;
      }

      const apiMessage: ApiMessage = {
        role: "assistant",
        content: parsed.content || message.content || null,
      };
      if (preserveReasoningContent && message.reasoningContent !== undefined) {
        apiMessage.reasoning_content = message.reasoningContent;
      }
      return apiMessage;
    }

    if (message.role === "tool") {
      if (suppressLocalToolCalling) {
        const toolResult = message.content.trim();
        if (!toolResult) {
          return [];
        }
        return {
          role: "user",
          content: `Context from a previous tool result:\n${toolResult}`,
        };
      }

      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.tool_call_id,
      };
    }

    return {
      role: message.role,
      content: message.content,
    };
  });
}

function splitAssistantToolContext(content: string): {
  content: string;
  toolCalls: ProviderToolCall[];
} {
  const marker = "\n\nTOOL_CALLS:\n";
  const markerIndex = content.indexOf(marker);
  const fallbackMarker = "TOOL_CALLS:\n";
  const splitIndex = markerIndex >= 0 ? markerIndex : content.indexOf(fallbackMarker);
  if (splitIndex < 0) {
    return { content, toolCalls: [] };
  }

  const toolCallsRaw = content
    .slice(splitIndex + (markerIndex >= 0 ? marker.length : fallbackMarker.length))
    .trim();
  const baseContent = content.slice(0, splitIndex).trim();
  const parsed = tryParseJson(toolCallsRaw);
  if (!Array.isArray(parsed)) {
    return { content, toolCalls: [] };
  }

  const toolCalls: ProviderToolCall[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) {
      continue;
    }

    const id = typeof record.id === "string" ? record.id : undefined;
    const argumentsValue = normalizeToolArguments(record.arguments);
    toolCalls.push({
      id: id || `call_${toolCalls.length + 1}`,
      name,
      arguments: argumentsValue,
    });
  }

  return {
    content: baseContent,
    toolCalls,
  };
}

function parseChatCompletionResponse(payload: unknown): ProviderResult {
  if (!payload || typeof payload !== "object") {
    throw new Error("Provider API returned a non-object response.");
  }

  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("Provider API returned no choices.");
  }

  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") {
    throw new Error("Provider API choice is invalid.");
  }

  const choice = firstChoice as Record<string, unknown>;
  const message = choice.message && typeof choice.message === "object"
    ? (choice.message as Record<string, unknown>)
    : undefined;

  const toolCalls = normalizeApiToolCalls(message?.tool_calls);
  const finishReason = normalizeFinishReason(choice.finish_reason, toolCalls.length > 0);
  const reasoningContent = extractResponseReasoningContent(payload, choice, message);

  return normalizeAssistantResult({
    outputText: extractMessageText(payload, choice, message),
    reasoningText: extractReasoningText(reasoningContent),
    reasoningContent,
    toolCalls,
    finishReason,
    usage: normalizeProviderUsage((payload as Record<string, unknown>).usage, "provider"),
    resolvedModel: extractResponseModel(payload),
    raw: payload,
  });
}

function shouldSuppressGroqLocalToolCalling(baseUrl: string, providerModel: string): boolean {
  if (!isGroqBaseUrl(baseUrl)) {
    return false;
  }

  return /^groq\/compound(?:-mini)?$/i.test(providerModel.trim());
}

function shouldRejectGroqToolTurn(
  baseUrl: string,
  providerModel: string,
  request: UnifiedRequest,
): boolean {
  if (!isGroqBaseUrl(baseUrl)) {
    return false;
  }

  // Compound systems use Groq-hosted tools. Keep gateway-managed local tool
  // orchestration on ordinary chat models or let the registry pick a fallback.
  return request.tools.length > 0 && shouldSuppressGroqLocalToolCalling(baseUrl, providerModel);
}

function isGroqBaseUrl(baseUrl: string): boolean {
  return /api\.groq\.com/i.test(baseUrl);
}

function isDeepSeekBaseUrl(baseUrl: string): boolean {
  return /api\.deepseek\.com/i.test(baseUrl);
}

function isDeepSeekThinkingModel(providerModel: string): boolean {
  const normalized = providerModel.trim();
  return /^deepseek-(?:reasoner|r\d)/i.test(normalized) || /^deepseek-v\d.*-pro$/i.test(normalized);
}

function shouldRejectDeepSeekThinkingToolTurn(
  baseUrl: string,
  providerModel: string,
  request: UnifiedRequest,
): boolean {
  return (
    request.tools.length > 0 &&
    isDeepSeekBaseUrl(baseUrl) &&
    isDeepSeekThinkingModel(providerModel)
  );
}

function isKimiBaseUrl(baseUrl: string): boolean {
  return /(?:api\.)?(?:moonshot|kimi)\.(?:ai|cn|com)/i.test(baseUrl);
}

function isKimiCodeApiBaseUrl(baseUrl: string): boolean {
  return /api\.kimi\.com\/coding\/v1\/?$/i.test(baseUrl.trim());
}

function isKimiK2Model(providerModel: string): boolean {
  return /^kimi-k2(?:[.-]|$)/i.test(providerModel.trim());
}

function isKimiK27CodeModel(providerModel: string): boolean {
  return /^kimi-k2\.7-code(?:-highspeed)?$/i.test(providerModel.trim());
}

function isKimiK2ProviderModel(baseUrl: string, providerModel: string): boolean {
  return isKimiBaseUrl(baseUrl) && isKimiK2Model(providerModel);
}

function normalizeApiToolCalls(raw: unknown): ProviderToolCall[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const toolCalls: ProviderToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const fn = record.function && typeof record.function === "object"
      ? (record.function as Record<string, unknown>)
      : undefined;
    const name = typeof fn?.name === "string" ? fn.name.trim() : "";
    if (!name) {
      continue;
    }

    toolCalls.push({
      id: typeof record.id === "string" && record.id ? record.id : `call_${toolCalls.length + 1}`,
      name,
      arguments: normalizeToolArguments(fn?.arguments),
    });
  }

  return toolCalls;
}

function buildAnthropicMessages(
  messages: UnifiedRequest["messages"],
): { system?: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content.trim()) {
        systemParts.push(message.content.trim());
      }
      continue;
    }

    if (message.role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id || "call_1",
            content: message.content,
          },
        ],
      });
      continue;
    }

    if (message.role === "assistant") {
      const parsed = splitAssistantToolContext(message.content);
      const content: Array<Record<string, unknown>> = [];
      if (parsed.content) {
        content.push({ type: "text", text: parsed.content });
      }
      for (const call of parsed.toolCalls) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: tryParseJson(call.arguments) ?? {},
        });
      }
      out.push({
        role: "assistant",
        content: content.length > 0 ? content : message.content,
      });
      continue;
    }

    out.push({
      role: "user",
      content: message.content,
    });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: out.length > 0 ? out : [{ role: "user", content: "" }],
  };
}

function parseAnthropicMessagesResponse(payload: unknown): ProviderResult {
  if (!payload || typeof payload !== "object") {
    throw new Error("Provider API returned a non-object response.");
  }

  const record = payload as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  const textParts: string[] = [];
  const toolCalls: ProviderToolCall[] = [];
  const reasoningParts: string[] = [];

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const part = item as Record<string, unknown>;
    const type = typeof part.type === "string" ? part.type : "";
    if (type === "text" && typeof part.text === "string") {
      textParts.push(part.text);
      continue;
    }
    if (type === "tool_use" && typeof part.name === "string") {
      toolCalls.push({
        id: typeof part.id === "string" && part.id ? part.id : `call_${toolCalls.length + 1}`,
        name: part.name,
        arguments: normalizeToolArguments(part.input),
      });
      continue;
    }
    if ((type.includes("thinking") || type.includes("reasoning")) && typeof part.text === "string") {
      reasoningParts.push(part.text);
    }
  }

  return normalizeAssistantResult({
    outputText: textParts.join("\n\n").trim(),
    reasoningText: reasoningParts.join("\n\n").trim() || undefined,
    toolCalls,
    finishReason: normalizeAnthropicStopReason(record.stop_reason, toolCalls.length > 0),
    usage: normalizeProviderUsage(record.usage, "provider"),
    resolvedModel: typeof record.model === "string" ? record.model : undefined,
    raw: payload,
  });
}

function normalizeAnthropicStopReason(
  value: unknown,
  hasToolCalls: boolean,
): ProviderResult["finishReason"] {
  if (value === "tool_use") {
    return "tool_calls";
  }
  if (value === "max_tokens") {
    return "length";
  }
  if (value === "end_turn" || value === "stop_sequence") {
    return hasToolCalls ? "tool_calls" : "stop";
  }
  return hasToolCalls ? "tool_calls" : "stop";
}

function normalizeAnthropicToolChoice(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "auto" || normalized === "none") {
      return { type: normalized };
    }
  }
  return undefined;
}

function readKimiCodeMaxTokens(metadata: UnifiedRequest["metadata"]): number {
  for (const key of ["max_completion_tokens", "max_tokens"]) {
    const value = readMetadataValue(metadata, key);
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
  }
  return 32768;
}

function extractMessageText(
  payload: unknown,
  choice: Record<string, unknown>,
  message?: Record<string, unknown>,
): string {
  const directCandidates = [
    message?.content,
    message?.text,
    message?.output_text,
    message?.refusal,
    choice.text,
    choice.output_text,
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).output_text
      : undefined,
  ];

  for (const candidate of directCandidates) {
    const extracted = extractTextCandidate(candidate);
    if (extracted) {
      return extracted;
    }
  }

  return "";
}

function extractTextCandidate(content: unknown): string {
  return extractTextCandidateRecursive(content, 0);
}

function extractReasoningText(content: unknown): string | undefined {
  const extracted = extractTextCandidate(content).trim();
  return extracted || undefined;
}

function extractResponseReasoningText(
  payload: unknown,
  choice: Record<string, unknown>,
  message?: Record<string, unknown>,
): string | undefined {
  return extractReasoningText(extractResponseReasoningContent(payload, choice, message));
}

function extractResponseReasoningContent(
  payload: unknown,
  choice: Record<string, unknown>,
  message?: Record<string, unknown>,
): unknown {
  for (const candidate of [
    ...extractReasoningCandidates(message),
    ...extractReasoningCandidates(choice),
    ...(payload && typeof payload === "object"
      ? extractReasoningCandidates(payload as Record<string, unknown>)
      : []),
  ]) {
    const extracted = extractReasoningText(candidate);
    if (extracted) {
      return candidate;
    }
  }

  return extractReasoningTextFromContentParts(message?.content);
}

function extractReasoningCandidates(record?: Record<string, unknown>): unknown[] {
  if (!record) {
    return [];
  }

  return [
    record.reasoning,
    record.reasoning_content,
    record.reasoningContent,
    record.reasoning_text,
    record.reasoningText,
    record.summary,
    record.summary_text,
    record.summaryText,
  ];
}

function extractReasoningTextFromContentParts(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts = content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }

      const record = item as Record<string, unknown>;
      const partType = typeof record.type === "string" ? record.type.toLowerCase() : "";
      if (
        !partType.includes("reason") &&
        !partType.includes("summary") &&
        !partType.includes("thinking")
      ) {
        return "";
      }

      return extractTextCandidate(item);
    })
    .filter(Boolean);

  const joined = parts.join("\n\n").trim();
  return joined || undefined;
}

function extractTextCandidateRecursive(content: unknown, depth: number): string {
  if (depth > 8 || content === null || content === undefined) {
    return "";
  }

  if (typeof content === "string") {
    return content.trim();
  }

  const directText = extractTextContent(content).trim();
  if (directText) {
    return directText;
  }

  if (Array.isArray(content)) {
    const parts = content
      .map((item) => extractTextCandidateRecursive(item, depth + 1))
      .filter(Boolean);
    return parts.join("\n\n").trim();
  }

  if (!content || typeof content !== "object") {
    return "";
  }

  const record = content as Record<string, unknown>;
  if (typeof record.refusal === "string" && record.refusal.trim()) {
    return record.refusal.trim();
  }

  for (const candidate of [record.message, record.response]) {
    const extracted = extractTextCandidateRecursive(candidate, depth + 1);
    if (extracted) {
      return extracted;
    }
  }

  return "";
}

function normalizeFinishReason(
  value: unknown,
  hasToolCalls: boolean,
): ProviderResult["finishReason"] {
  if (
    value === "stop" ||
    value === "tool_calls" ||
    value === "length" ||
    value === "error"
  ) {
    return value;
  }

  return hasToolCalls ? "tool_calls" : "stop";
}

function extractResponseModel(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const model = (payload as Record<string, unknown>).model;
  return typeof model === "string" && model.trim() ? model.trim() : undefined;
}

function normalizeToolArguments(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
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

async function requestProviderJson(
  config: OpenAiCompatibleProviderConfig,
  pathname: string,
  init: ProviderRequestInit,
  timeoutMsOverride?: number,
): Promise<unknown> {
  const apiKey = process.env[config.apiKeyEnv]?.trim();
  if (!apiKey) {
    throw new Error(`${config.apiKeyEnv} is not set.`);
  }

  const controller = new AbortController();
  const timeoutMs = timeoutMsOverride ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(buildProviderUrl(config.baseUrl, pathname), {
      ...init,
      headers: buildRequestHeaders(apiKey, init.headers),
      signal: controller.signal,
    });

    const text = await response.text();
    const payload = tryParseJson(text);

    if (!response.ok) {
      const message =
        extractApiErrorMessage(payload) ||
        text.trim() ||
        `${response.status} ${response.statusText}`;
      throw new Error(`Provider API request failed (${response.status}): ${message}`);
    }

    if (payload === null) {
      throw new Error("Provider API returned invalid JSON.");
    }

    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Provider API request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function buildProviderUrl(baseUrl: string, pathname: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${normalizedBaseUrl}${normalizedPath}`;
}

function buildRequestHeaders(
  apiKey: string,
  headers?: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  for (const [key, value] of Object.entries(headers ?? {})) {
    merged[key] = value;
  }

  return merged;
}

function copyNumberMetadata(
  target: Record<string, unknown>,
  metadata: UnifiedRequest["metadata"],
  key: string,
): void {
  const value = readMetadataValue(metadata, key);
  if (typeof value === "number") {
    target[key] = value;
  }
}

function copyIntegerMetadata(
  target: Record<string, unknown>,
  metadata: UnifiedRequest["metadata"],
  key: string,
): void {
  const value = readMetadataValue(metadata, key);
  if (typeof value === "number" && Number.isInteger(value)) {
    target[key] = value;
  }
}

function copyKimiK2Metadata(
  target: Record<string, unknown>,
  metadata: UnifiedRequest["metadata"],
  providerModel: string,
): void {
  const maxCompletionTokens = readMetadataValue(metadata, "max_completion_tokens");
  if (typeof maxCompletionTokens === "number" && Number.isInteger(maxCompletionTokens)) {
    target.max_completion_tokens = maxCompletionTokens;
  } else {
    copyIntegerMetadata(target, metadata, "max_tokens");
  }

  if (isKimiK27CodeModel(providerModel)) {
    return;
  }

  const thinking = normalizeKimiThinkingMetadata(
    firstDefined(
      readMetadataValue(metadata, "thinking"),
      readMetadataValue(metadata, "kimi_thinking"),
      readMetadataValue(metadata, "moonshot_thinking"),
    ),
  );
  if (thinking) {
    target.thinking = thinking;
  }
}

function normalizeKimiThinkingMetadata(value: unknown): { type: "enabled" | "disabled" } | undefined {
  if (typeof value === "boolean") {
    return { type: value ? "enabled" : "disabled" };
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "enabled" || normalized === "disabled") {
      return { type: normalized };
    }
    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const type = (value as Record<string, unknown>).type;
  if (typeof type !== "string") {
    return undefined;
  }

  const normalized = type.trim().toLowerCase();
  if (normalized === "enabled" || normalized === "disabled") {
    return { type: normalized };
  }

  return undefined;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function normalizeToolChoiceForProvider(
  toolChoice: unknown,
  baseUrl: string,
  providerModel: string,
): unknown {
  if (toolChoice === undefined) {
    return undefined;
  }

  if (!isKimiK2ProviderModel(baseUrl, providerModel)) {
    return toolChoice;
  }

  if (typeof toolChoice === "string") {
    const normalized = toolChoice.trim().toLowerCase();
    if (normalized === "auto" || normalized === "none") {
      return normalized;
    }
  }

  // Kimi K2 thinking mode rejects forced tool choices; preserve tool use by
  // letting the provider choose rather than failing the whole request.
  return "auto";
}

function copyStringMetadata(
  target: Record<string, unknown>,
  metadata: UnifiedRequest["metadata"],
  key: string,
): void {
  const value = readMetadataValue(metadata, key);
  if (typeof value === "string" && value.trim()) {
    target[key] = value;
  }
}

function copyBooleanMetadata(
  target: Record<string, unknown>,
  metadata: UnifiedRequest["metadata"],
  key: string,
): void {
  const value = readMetadataValue(metadata, key);
  if (typeof value === "boolean") {
    target[key] = value;
  }
}

function copyProviderReasoningMetadata(
  target: Record<string, unknown>,
  metadata: UnifiedRequest["metadata"],
  baseUrl: string,
  providerModel: string,
): void {
  if (isDeepSeekBaseUrl(baseUrl) || isKimiK2ProviderModel(baseUrl, providerModel)) {
    return;
  }

  const includeReasoning = readMetadataValue(metadata, "include_reasoning");
  const reasoningFormat = readMetadataValue(metadata, "reasoning_format");

  if (isGroqBaseUrl(baseUrl) && isGroqGptOssModel(providerModel)) {
    if (typeof includeReasoning === "boolean") {
      target.include_reasoning = includeReasoning;
    }
    return;
  }

  if (typeof reasoningFormat === "string" && reasoningFormat.trim()) {
    target.reasoning_format = reasoningFormat.trim();
    return;
  }

  if (typeof includeReasoning === "boolean") {
    target.include_reasoning = includeReasoning;
  }
}

function copyStringMetadataKeys(
  target: Record<string, unknown>,
  metadata: UnifiedRequest["metadata"],
  keys: readonly string[],
): void {
  for (const key of keys) {
    copyStringMetadata(target, metadata, key);
  }
}

function extractForwardedMetadata(
  metadata: UnifiedRequest["metadata"],
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};

  for (const key of REMOTE_STRING_METADATA_KEYS) {
    const value = readMetadataValue(metadata, key);
    if (typeof value === "string" && value.trim()) {
      out[key] = value.trim();
    }
  }

  for (const key of REMOTE_BOOLEAN_METADATA_KEYS) {
    const value = readMetadataValue(metadata, key);
    if (typeof value === "boolean") {
      out[key] = value;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function shouldForwardRemoteMetadata(baseUrl: string): boolean {
  return !isGroqBaseUrl(baseUrl) && !isDeepSeekBaseUrl(baseUrl);
}

function buildImageGenerationPrompt(request: UnifiedRequest): string {
  const promptFromMetadata = extractTextContent(readMetadataValue(request.metadata, "prompt")).trim();
  if (promptFromMetadata) {
    return promptFromMetadata;
  }

  return request.messages
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function readMetadataValue(
  metadata: UnifiedRequest["metadata"],
  key: string,
): unknown {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  if (key in metadata) {
    return metadata[key];
  }

  const nestedMetadata = getNestedMetadata(metadata);
  if (nestedMetadata && key in nestedMetadata) {
    return nestedMetadata[key];
  }

  return undefined;
}

function getNestedMetadata(
  metadata: UnifiedRequest["metadata"],
): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  const nested = metadata.metadata;
  if (!nested || typeof nested !== "object") {
    return undefined;
  }

  return nested as Record<string, unknown>;
}

function normalizeGroqReasoningEffort(
  baseUrl: string,
  providerModel: string,
  reasoningEffort: UnifiedRequest["reasoningEffort"],
): "none" | "default" | "low" | "medium" | "high" | undefined {
  if (!reasoningEffort) {
    return undefined;
  }

  if (!isGroqBaseUrl(baseUrl)) {
    return undefined;
  }

  if (isGroqQwen3Model(providerModel)) {
    return reasoningEffort === "none" ||
      reasoningEffort === "minimal" ||
      reasoningEffort === "low"
      ? "none"
      : "default";
  }

  if (!isGroqGptOssModel(providerModel)) {
    return undefined;
  }

  if (reasoningEffort === "none" || reasoningEffort === "minimal") {
    return "low";
  }

  if (reasoningEffort === "xhigh") {
    return "high";
  }

  return reasoningEffort === "low" || reasoningEffort === "medium" || reasoningEffort === "high"
    ? reasoningEffort
    : undefined;
}

function isGroqGptOssModel(providerModel: string): boolean {
  return /^openai\/gpt-oss-(20b|120b)$/i.test(providerModel.trim());
}

function isGroqQwen3Model(providerModel: string): boolean {
  return /(^|\/)qwen3[-/]/i.test(providerModel.trim()) ||
    /(^|\/)qwen\/qwen3[-/]/i.test(providerModel.trim());
}

function extractApiErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") {
    return "";
  }

  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message.trim() : "";
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function matchesPattern(value: string, pattern: string): boolean {
  const escaped = escapeRegExp(pattern).replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
