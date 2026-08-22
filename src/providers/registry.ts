import type {
  AutoRouterBenchmarkMeasurement,
  AutoRouterBenchmarkPromptKind,
  AutoRouterBenchmarkQualitySnapshot,
  AutoRouterBenchmarkSnapshot,
  AutoRouterBenchmarkTaskScores,
  AutoRouterDecisionSnapshot,
  AutoRouterPromptProfile,
  ModelCapability,
  ProviderConfig,
  ProviderModelConfig,
  ProviderResult,
  ProviderStreamEvent,
  ProviderToolCall,
  ReasoningEffort,
  UnifiedToolDefinition,
  UnifiedRequest,
} from "../types";
import type {
  ModelFailureKind,
  ModelStatsModelSnapshot,
  ModelStatsSnapshot,
} from "../stats/model-stats";
import { ModelStatsTracker } from "../stats/model-stats";
import { CliProvider } from "./cli-provider";
import { OpenAiCompatibleProvider } from "./openai-compatible-provider";
import type { Provider } from "./provider";
import { trackProvider, trackFallback } from "../metrics";
import { isSyntheticAssistantOutputText, normalizeAssistantResult } from "../utils/assistant-output";
import { extractTextContent } from "../utils/prompt";
import { estimateTokensFromText } from "../utils/usage";

const AUTO_MODEL_ID = "auto";
const AUTO_PROVIDER_ID = "gateway";
const BENCHMARK_SMALL_PROMPT =
  "Reply with exactly this text and nothing else: ok";
const BENCHMARK_MEDIUM_PROMPT = [
  "Write a concise operational note for an API gateway maintainer.",
  "Use 120 to 160 words. Mention latency, token usage, fallback routing, and provider health.",
  "Do not use markdown headings.",
].join(" ");
const BENCHMARK_REASONING_LOW_PROMPTS = [
  "A gateway has two healthy low-latency providers and one slow but stronger provider. In two sentences, choose the default for a simple status question and explain why.",
  "A user asks for a short JSON transform and no tools. In two sentences, choose speed or depth and explain the tradeoff.",
  "A workflow needs a fast classification before a heavier model step. In two sentences, pick the model lane and explain the risk.",
];
const BENCHMARK_REASONING_HIGH_PROMPTS = [
  "An auto-router sees model A with 900ms latency and 60% recent success, model B with 4s latency and 98% success, and model C with an auth warning. For a multi-step debugging request, choose the best first model and fallback order. Return a compact paragraph.",
  "A provider is fast on short prompts but slow on synthesis, while another has slower first token time but better sustained token rate and fewer failures. Explain which should handle a long coding review and why.",
  "A gateway must route between cheap, fast, and deep-reasoning models. Design a three-rule policy for simple, medium, and high-risk requests. Keep it concise.",
];
const BENCHMARK_TOOL_PROMPT =
  "Call the lookup_gateway_metric tool with metric set to latency_ms. Do not answer in plain text.";
const BENCHMARK_TOOL_DEFINITION: UnifiedToolDefinition = {
  type: "function",
  function: {
    name: "lookup_gateway_metric",
    description: "Looks up one gateway benchmark metric by name.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        metric: {
          type: "string",
          enum: ["latency_ms"],
        },
      },
      required: ["metric"],
    },
  },
};

interface ModelBinding {
  modelId: string;
  providerModel: string;
  provider: Provider;
  description?: string;
  fallbackModelIds: string[];
  capabilities: ModelCapability[];
  autoEligible: boolean;
}

interface RegistryLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
}

interface AutoRankedCandidate {
  binding: ModelBinding;
  score: number;
  index: number;
  stats?: ModelStatsModelSnapshot;
  benchmark?: AutoRouterBenchmarkSnapshot;
}

interface BenchmarkRunOptions {
  timeoutMs: number;
  maxModels: number;
  concurrency: number;
  evaluateQuality: boolean;
  evaluatorModelId?: string;
  qualityTimeoutMs: number;
  logger?: RegistryLogger;
}

interface BenchmarkProbeResult {
  measurement: AutoRouterBenchmarkMeasurement;
  outputText: string;
  toolCalls: ProviderToolCall[];
}

interface BenchmarkProbeSet {
  small: BenchmarkProbeResult;
  medium: BenchmarkProbeResult;
  reasoningLow?: BenchmarkProbeResult;
  reasoningHigh?: BenchmarkProbeResult;
  toolUse?: BenchmarkProbeResult;
}

interface ParsedQualityEvaluation {
  score: number;
  taskScores?: NonNullable<AutoRouterBenchmarkQualitySnapshot["taskScores"]>;
  verdict?: string;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();
  private readonly models = new Map<string, ModelBinding>();
  private readonly modelStats = new ModelStatsTracker();
  private readonly modelBenchmarks = new Map<string, AutoRouterBenchmarkSnapshot>();
  private activeBenchmarkRun?: Promise<AutoRouterBenchmarkSnapshot[]>;

  private constructor() {}

  static async create(configs: ProviderConfig[]): Promise<ProviderRegistry> {
    const registry = new ProviderRegistry();
    for (const config of configs) {
      const provider =
        config.type === "cli"
          ? new CliProvider(config)
          : await OpenAiCompatibleProvider.create(config);
      if (registry.providers.has(provider.id)) {
        throw new Error(`Duplicate provider id: ${provider.id}`);
      }
      registry.providers.set(provider.id, provider);

      for (const model of provider.models) {
        if (model.id === AUTO_MODEL_ID) {
          throw new Error(`Model id ${AUTO_MODEL_ID} is reserved for gateway auto routing.`);
        }
        if (registry.models.has(model.id)) {
          throw new Error(`Duplicate model id: ${model.id}`);
        }
        registry.models.set(model.id, {
          modelId: model.id,
          providerModel: model.providerModel || model.id,
          provider,
          description: model.description,
          fallbackModelIds: model.fallbackModels || [],
          capabilities: normalizeModelCapabilities(model.capabilities),
          autoEligible: model.autoEligible !== false,
        });
        registry.modelStats.registerModel({
          modelId: model.id,
          providerId: provider.id,
          providerModel: model.providerModel || model.id,
          description: model.description,
          fallbackModels: model.fallbackModels || [],
        });
        registry.modelBenchmarks.set(model.id, {
          modelId: model.id,
          providerId: provider.id,
          providerModel: model.providerModel || model.id,
          status: model.autoEligible === false ? "skipped" : "pending",
          score: 0,
        });
      }
    }

    if (registry.providers.size === 0) {
      throw new Error("No providers configured.");
    }

    return registry;
  }

  listModels(): Array<{
    id: string;
    description?: string;
    providerId: string;
    providerModel: string;
    fallbackModels: string[];
    capabilities: ModelCapability[];
    benchmark?: AutoRouterBenchmarkSnapshot;
  }> {
    return [
      {
        id: AUTO_MODEL_ID,
        description: "Gateway-native auto router across all configured compatible models.",
        providerId: AUTO_PROVIDER_ID,
        providerModel: "gateway/auto",
        fallbackModels: [],
        capabilities: [
          "chat",
          "responses",
          "tools",
          "streaming",
          "reasoning",
          "structured_outputs",
          "image_generation",
        ],
      },
      ...[...this.models.values()].map((binding) => ({
        id: binding.modelId,
        description: binding.description,
        providerId: binding.provider.id,
        providerModel: binding.providerModel,
        fallbackModels: binding.fallbackModelIds,
        capabilities: binding.capabilities,
        benchmark: this.modelBenchmarks.get(binding.modelId),
      })),
    ];
  }

  listProviders(): Provider[] {
    return [...this.providers.values()];
  }

  resolvePreferredImageGenerationModel(requestedModelId?: string): string | undefined {
    const requestedBinding = requestedModelId ? this.models.get(requestedModelId) : undefined;
    if (requestedBinding && bindingSupportsImageGeneration(requestedBinding)) {
      return requestedBinding.modelId;
    }

    for (const binding of this.models.values()) {
      if (bindingSupportsImageGeneration(binding)) {
        return binding.modelId;
      }
    }

    return requestedBinding?.modelId;
  }

  getProvider(providerId: string): Provider | undefined {
    return this.providers.get(providerId);
  }

  getModelStats(): ModelStatsSnapshot {
    return this.modelStats.snapshot();
  }

  getModelStatsById(modelId: string): ModelStatsModelSnapshot | undefined {
    return this.modelStats.snapshotModel(modelId);
  }

  getAutoRouterBenchmarks(): AutoRouterBenchmarkSnapshot[] {
    return [...this.modelBenchmarks.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
  }

  recordModelBenchmark(snapshot: AutoRouterBenchmarkSnapshot): void {
    this.modelBenchmarks.set(snapshot.modelId, snapshot);
  }

  explainAutoRouting(
    request: Omit<UnifiedRequest, "model" | "providerModel" | "requestId"> & { requestId?: string },
  ): AutoRouterDecisionSnapshot {
    const normalizedRequest: Omit<UnifiedRequest, "model" | "providerModel"> = {
      requestId: request.requestId ?? "explain_auto",
      messages: request.messages,
      tools: request.tools ?? [],
      stream: request.stream,
      requestKind: request.requestKind,
      reasoningEffort: request.reasoningEffort,
      metadata: request.metadata,
    };
    const profile = buildAutoRouterPromptProfile(normalizedRequest);
    const candidates = this.rankAutoCandidatesWithProfile(normalizedRequest, profile);
    const selected = candidates[0];
    if (!selected) {
      throw new Error("Auto routing could not find a compatible model.");
    }

    return {
      selectedModelId: selected.binding.modelId,
      selectedProviderId: selected.binding.provider.id,
      selectedProviderModel: selected.binding.providerModel,
      promptProfile: profile,
      candidates: candidates.map((candidate) => ({
        modelId: candidate.binding.modelId,
        providerId: candidate.binding.provider.id,
        providerModel: candidate.binding.providerModel,
        capabilities: candidate.binding.capabilities,
        score: roundNumber(candidate.score, 2),
        benchmarkStatus: candidate.benchmark?.status,
        benchmarkScore: candidate.benchmark?.score,
        benchmarkQualityScore: candidate.benchmark?.quality?.score,
        benchmarkTaskScores: candidate.benchmark?.taskScores,
        healthState: candidate.stats?.suggestedState,
      })),
    };
  }

  async runStartupBenchmarks(options: {
    timeoutMs: number;
    maxModels: number;
    concurrency: number;
    evaluateQuality?: boolean;
    evaluatorModelId?: string;
    qualityTimeoutMs?: number;
    logger?: RegistryLogger;
  }): Promise<AutoRouterBenchmarkSnapshot[]> {
    if (this.activeBenchmarkRun) {
      options.logger?.info(
        {},
        "Auto router benchmark already running; joining existing run.",
      );
      return this.activeBenchmarkRun;
    }

    const normalizedOptions: BenchmarkRunOptions = {
      timeoutMs: options.timeoutMs,
      maxModels: options.maxModels,
      concurrency: options.concurrency,
      evaluateQuality: options.evaluateQuality ?? true,
      evaluatorModelId: options.evaluatorModelId,
      qualityTimeoutMs: Math.max(
        1_000,
        Math.min(options.qualityTimeoutMs ?? options.timeoutMs, options.timeoutMs),
      ),
      logger: options.logger,
    };

    this.activeBenchmarkRun = this.runBenchmarkBatch(normalizedOptions).finally(() => {
      this.activeBenchmarkRun = undefined;
    });
    return this.activeBenchmarkRun;
  }

  private async runBenchmarkBatch(options: BenchmarkRunOptions): Promise<AutoRouterBenchmarkSnapshot[]> {
    const candidates = this.selectBenchmarkCandidates(options.maxModels);
    if (candidates.length === 0) {
      return this.getAutoRouterBenchmarks();
    }

    const concurrency = Math.max(1, Math.min(options.concurrency, candidates.length));
    let nextIndex = 0;

    const worker = async () => {
      while (nextIndex < candidates.length) {
        const index = nextIndex;
        nextIndex += 1;
        const binding = candidates[index];
        if (!binding) {
          continue;
        }
        await this.runBenchmarkForBinding(binding, options);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return this.getAutoRouterBenchmarks();
  }

  private selectBenchmarkCandidates(maxModels: number): ModelBinding[] {
    const candidates = [...this.models.values()].filter((binding) => {
      if (!binding.autoEligible) {
        return false;
      }
      if (bindingSupportsImageGeneration(binding) && binding.capabilities.length === 1) {
        return false;
      }
      return (
        bindingSupportsCapability(binding, "chat") ||
        bindingSupportsCapability(binding, "responses")
      );
    });

    const limit = Math.max(0, maxModels);
    if (limit === 0 || candidates.length <= limit) {
      return candidates;
    }

    const requiredProviderIds = new Set<string>();
    const selected: ModelBinding[] = [];
    for (const binding of candidates) {
      if (requiredProviderIds.has(binding.provider.id)) {
        continue;
      }
      selected.push(binding);
      requiredProviderIds.add(binding.provider.id);
      if (selected.length >= limit) {
        return selected;
      }
    }

    const selectedIds = new Set(selected.map((binding) => binding.modelId));
    const ranked = candidates
      .filter((binding) => !selectedIds.has(binding.modelId))
      .map((binding, index) => ({
        binding,
        index,
        score: benchmarkCandidatePriority(binding),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index);

    for (const candidate of ranked) {
      if (selected.length >= limit) {
        break;
      }
      selected.push(candidate.binding);
    }

    return selected;
  }

  private async runBenchmarkForBinding(
    binding: ModelBinding,
    options: BenchmarkRunOptions,
  ): Promise<void> {
    const running = {
      ...benchmarkBaseSnapshot(binding),
      status: "running" as const,
      updatedAt: new Date().toISOString(),
      score: 0,
    };
    this.modelBenchmarks.set(binding.modelId, running);

    try {
      const small = await this.runBenchmarkPrompt(
        binding,
        "small",
        BENCHMARK_SMALL_PROMPT,
        options.timeoutMs,
      );
      const medium = await this.runBenchmarkPrompt(
        binding,
        "medium",
        BENCHMARK_MEDIUM_PROMPT,
        options.timeoutMs,
      );
      const supportsReasoning = bindingSupportsCapability(binding, "reasoning");
      const reasoningLow = supportsReasoning
        ? await this.runBenchmarkPrompt(
          binding,
          "reasoning_low",
          selectBenchmarkPrompt(binding.modelId, "reasoning_low", BENCHMARK_REASONING_LOW_PROMPTS),
          options.timeoutMs,
          "low",
        )
        : undefined;
      const reasoningHigh = supportsReasoning
        ? await this.runBenchmarkPrompt(
          binding,
          "reasoning_high",
          selectBenchmarkPrompt(binding.modelId, "reasoning_high", BENCHMARK_REASONING_HIGH_PROMPTS),
          options.timeoutMs,
          "high",
        )
        : undefined;
      const toolUse = bindingSupportsCapability(binding, "tools")
        ? await this.runBenchmarkPrompt(
          binding,
          "tool_call",
          BENCHMARK_TOOL_PROMPT,
          options.timeoutMs,
          undefined,
          [BENCHMARK_TOOL_DEFINITION],
        )
        : undefined;
      const probeSet: BenchmarkProbeSet = {
        small,
        medium,
        reasoningLow,
        reasoningHigh,
        toolUse,
      };
      const quality = options.evaluateQuality
        ? await this.evaluateBenchmarkQuality(binding, probeSet, options)
        : undefined;
      const taskScores = buildBenchmarkTaskScores({
        small: small.measurement,
        medium: medium.measurement,
        reasoningLow: reasoningLow?.measurement,
        reasoningHigh: reasoningHigh?.measurement,
        toolUse: toolUse?.measurement,
        quality,
      });
      const snapshot: AutoRouterBenchmarkSnapshot = {
        ...benchmarkBaseSnapshot(binding),
        status: "succeeded",
        updatedAt: new Date().toISOString(),
        small: small.measurement,
        medium: medium.measurement,
        reasoningLow: reasoningLow?.measurement,
        reasoningHigh: reasoningHigh?.measurement,
        toolUse: toolUse?.measurement,
        quality,
        taskScores,
        score: taskScores.overall,
      };
      this.modelBenchmarks.set(binding.modelId, snapshot);
      options.logger?.info(
        {
          modelId: binding.modelId,
          providerId: binding.provider.id,
          score: snapshot.score,
          small: snapshot.small,
          medium: snapshot.medium,
          reasoningLow: snapshot.reasoningLow,
          reasoningHigh: snapshot.reasoningHigh,
          toolUse: snapshot.toolUse,
          quality: snapshot.quality,
        },
        "Auto router startup benchmark completed.",
      );
    } catch (error) {
      const snapshot: AutoRouterBenchmarkSnapshot = {
        ...benchmarkBaseSnapshot(binding),
        status: "failed",
        updatedAt: new Date().toISOString(),
        score: -35,
        error: error instanceof Error ? error.message : String(error),
      };
      this.modelBenchmarks.set(binding.modelId, snapshot);
      options.logger?.warn(
        {
          modelId: binding.modelId,
          providerId: binding.provider.id,
          error: snapshot.error,
        },
        "Auto router startup benchmark failed.",
      );
    }
  }

  private async runBenchmarkPrompt(
    binding: ModelBinding,
    promptKind: AutoRouterBenchmarkPromptKind,
    prompt: string,
    timeoutMs: number,
    reasoningEffort?: ReasoningEffort,
    tools: UnifiedToolDefinition[] = [],
  ): Promise<BenchmarkProbeResult> {
    if (binding.provider.runStream && binding.provider.supportsStreaming?.()) {
      try {
        return await this.runStreamingBenchmarkPrompt(
          binding,
          promptKind,
          prompt,
          timeoutMs,
          reasoningEffort,
          tools,
        );
      } catch {
        // Fall back to a non-stream probe; some providers advertise sessions but
        // still reject stream mode for a specific model or output contract.
      }
    }

    const startedAt = Date.now();
    const result = await binding.provider.run(
      buildBenchmarkRequest(binding, prompt, promptKind, timeoutMs, false, reasoningEffort, tools),
    );
    const durationMs = Date.now() - startedAt;
    const outputTokenEstimate =
      result.usage?.outputTokens ??
      result.usage?.completionTokens ??
      estimateTokensFromText(result.outputText);
    const outputText = result.outputText.trim();

    return {
      measurement: {
        promptKind,
        reasoningEffort,
        streamed: false,
        durationMs,
        timeToFirstTokenMs: durationMs,
        outputTokenEstimate,
        outputTokensPerSecond: tokensPerSecond(outputTokenEstimate, durationMs),
        outputCharCount: outputText.length,
        toolCallCount: result.toolCalls.length,
        expectedTextMatched: promptKind === "small" ? /^ok\.?$/i.test(outputText) : undefined,
        measuredUsage: result.usage,
      },
      outputText,
      toolCalls: result.toolCalls,
    };
  }

  private async runStreamingBenchmarkPrompt(
    binding: ModelBinding,
    promptKind: AutoRouterBenchmarkPromptKind,
    prompt: string,
    timeoutMs: number,
    reasoningEffort: ReasoningEffort | undefined,
    tools: UnifiedToolDefinition[],
  ): Promise<BenchmarkProbeResult> {
    if (!binding.provider.runStream) {
      throw new Error(`Model ${binding.modelId} does not expose streaming.`);
    }

    const startedAt = Date.now();
    let firstTokenMs: number | undefined;
    let outputText = "";
    let measuredUsage: ProviderResult["usage"];
    const toolCalls: ProviderToolCall[] = [];

    for await (const event of binding.provider.runStream(
      buildBenchmarkRequest(binding, prompt, promptKind, timeoutMs, true, reasoningEffort, tools),
    )) {
      if (event.type === "output_text_delta" || event.type === "reasoning_delta") {
        if (firstTokenMs === undefined) {
          firstTokenMs = Date.now() - startedAt;
        }
        outputText += event.delta;
        continue;
      }
      if (event.type === "tool_call") {
        toolCalls.push(event.toolCall);
        continue;
      }
      if (event.type === "done") {
        if (event.outputText && !outputText) {
          outputText = event.outputText;
        }
        measuredUsage = event.usage;
      }
    }

    const durationMs = Date.now() - startedAt;
    const outputTokenEstimate =
      measuredUsage?.outputTokens ??
      measuredUsage?.completionTokens ??
      estimateTokensFromText(outputText);

    return {
      measurement: {
        promptKind,
        reasoningEffort,
        streamed: true,
        durationMs,
        timeToFirstTokenMs: firstTokenMs ?? durationMs,
        outputTokenEstimate,
        outputTokensPerSecond: tokensPerSecond(outputTokenEstimate, durationMs),
        outputCharCount: outputText.trim().length,
        toolCallCount: toolCalls.length,
        expectedTextMatched: promptKind === "small" ? /^ok\.?$/i.test(outputText.trim()) : undefined,
        measuredUsage,
      },
      outputText: outputText.trim(),
      toolCalls,
    };
  }

  private async evaluateBenchmarkQuality(
    testedBinding: ModelBinding,
    probes: BenchmarkProbeSet,
    options: BenchmarkRunOptions,
  ): Promise<AutoRouterBenchmarkQualitySnapshot> {
    const evaluator = this.selectQualityEvaluatorBinding(
      options.evaluatorModelId,
      testedBinding.modelId,
    );
    if (!evaluator.binding) {
      return {
        status: "skipped",
        error: evaluator.error ?? "No separate quality evaluator model is configured.",
      };
    }

    try {
      const result = await evaluator.binding.provider.run(
        buildQualityEvaluationRequest(
          evaluator.binding,
          testedBinding,
          probes,
          options.qualityTimeoutMs,
        ),
      );
      const parsed = parseQualityEvaluation(result.outputText);
      return {
        status: "succeeded",
        evaluatorModelId: evaluator.binding.modelId,
        evaluatorProviderId: evaluator.binding.provider.id,
        evaluatorProviderModel: evaluator.binding.providerModel,
        score: parsed.score,
        taskScores: parsed.taskScores,
        verdict: parsed.verdict,
      };
    } catch (error) {
      return {
        status: "failed",
        evaluatorModelId: evaluator.binding.modelId,
        evaluatorProviderId: evaluator.binding.provider.id,
        evaluatorProviderModel: evaluator.binding.providerModel,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private selectQualityEvaluatorBinding(
    preferredModelId: string | undefined,
    testedModelId: string,
  ): { binding?: ModelBinding; error?: string } {
    if (preferredModelId) {
      const preferred = this.models.get(preferredModelId);
      if (!preferred) {
        return { error: `Quality evaluator model is not configured: ${preferredModelId}` };
      }
      if (preferred.modelId === testedModelId) {
        return { error: `Quality evaluator model ${preferredModelId} is the model under test.` };
      }
      if (!bindingCanEvaluateQuality(preferred)) {
        return { error: `Quality evaluator model ${preferredModelId} is not chat-capable.` };
      }
      return { binding: preferred };
    }

    const eligible = [...this.models.values()]
      .filter((binding) => binding.modelId !== testedModelId && bindingCanEvaluateQuality(binding))
      .map((binding, index) => ({
        binding,
        index,
        score: scoreQualityEvaluatorCandidate(binding),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index);

    return { binding: eligible[0]?.binding };
  }

  async runModel(
    modelId: string,
    request: Omit<UnifiedRequest, "model" | "providerModel">,
  ): Promise<ProviderResult> {
    const autoSelection = modelId === AUTO_MODEL_ID
      ? this.selectAutoModel(request)
      : undefined;

    if (!autoSelection && !this.models.has(modelId)) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    const attempted: string[] = [];
    const visited = new Set<string>();
    let currentModelId: string | undefined = autoSelection?.modelId ?? modelId;
    const autoFallbackModelIds = autoSelection?.fallbackModelIds ?? [];
    let lastError: unknown;

    while (currentModelId) {
      if (visited.has(currentModelId)) {
        break;
      }
      visited.add(currentModelId);

      const binding = this.models.get(currentModelId);
      if (!binding) {
        attempted.push(currentModelId);
        const attemptIndex = attempted.length - 1;
        lastError = new Error(`Fallback model not found: ${currentModelId}`);
        this.modelStats.recordAttempt({
          modelId: currentModelId,
          requestedModelId: modelId,
          providerId: "unknown",
          providerModel: currentModelId,
          attemptIndex,
        });
        this.modelStats.recordFailure({
          modelId: currentModelId,
          requestedModelId: modelId,
          providerId: "unknown",
          providerModel: currentModelId,
          attemptIndex,
          durationMs: 0,
          error: lastError,
        });
        break;
      }

      const skippedFailureKind = this.getModelSkipReason(binding, modelId);
      if (skippedFailureKind) {
        const nextModelId = this.findNextModelId(
          binding,
          autoFallbackModelIds,
          visited,
          request,
        );
        const stats = this.modelStats.snapshotModel(binding.modelId);
        const unavailableState =
          skippedFailureKind === "auth"
            ? "auth_blocked"
            : skippedFailureKind === "unknown"
              ? stats?.suggestedState || "degraded"
              : skippedFailureKind;
        lastError = new Error(
          `Model ${binding.modelId} is temporarily unavailable (${unavailableState}).` +
            (stats?.suggestedCooldownSeconds
              ? ` Retry after about ${stats.suggestedCooldownSeconds} seconds.`
              : ""),
        );
        if (!nextModelId) {
          break;
        }
        this.modelStats.recordFallback({
          requestedModelId: modelId,
          fromModelId: binding.modelId,
          toModelId: nextModelId,
          reason: skippedFailureKind,
        });
        trackFallback(binding.provider.id, nextModelId, skippedFailureKind);
        currentModelId = nextModelId;
        continue;
      }

      attempted.push(currentModelId);
      const attemptIndex = attempted.length - 1;

      const startedAt = Date.now();
      this.modelStats.recordAttempt({
        modelId: binding.modelId,
        requestedModelId: modelId,
        providerId: binding.provider.id,
        providerModel: binding.providerModel,
        attemptIndex,
      });

      try {
        const requiredCapability = requiredCapabilityForRequest(request);
        if (requiredCapability && !bindingSupportsCapability(binding, requiredCapability)) {
          throw new Error(
            `Model ${binding.modelId} does not support ${requiredCapability} requests.`,
          );
        }
        if (request.tools.length > 0 && !bindingSupportsCapability(binding, "tools")) {
          throw new Error(`Model ${binding.modelId} does not support tools requests.`);
        }

        const rawResult = await binding.provider.run({
          ...request,
          model: binding.modelId,
          providerModel: binding.providerModel,
        });
        const result = normalizeAssistantResult(rawResult);
        if (isInvalidProviderResult(result, request)) {
          throw new Error(buildInvalidProviderResultError(binding.provider.id, binding.modelId, result));
        }
        this.modelStats.recordSuccess({
          modelId: binding.modelId,
          requestedModelId: modelId,
          providerId: binding.provider.id,
          providerModel: binding.providerModel,
          attemptIndex,
          durationMs: Date.now() - startedAt,
        });
        trackProvider(binding.provider.id, binding.modelId, true, Date.now() - startedAt);
        return {
          ...result,
          resolvedModel: result.resolvedModel ?? binding.modelId,
        };
      } catch (error) {
        lastError = error;
        const failureKind = this.modelStats.recordFailure({
          modelId: binding.modelId,
          requestedModelId: modelId,
          providerId: binding.provider.id,
          providerModel: binding.providerModel,
          attemptIndex,
          durationMs: Date.now() - startedAt,
          error,
        });
        trackProvider(binding.provider.id, binding.modelId, false, Date.now() - startedAt);
        const nextModelId = this.findNextModelId(
          binding,
          autoFallbackModelIds,
          visited,
          request,
        );
        if (!nextModelId) {
          break;
        }
        this.modelStats.recordFallback({
          requestedModelId: modelId,
          fromModelId: binding.modelId,
          toModelId: nextModelId,
          reason: failureKind,
        });
        trackFallback(binding.provider.id, nextModelId, failureKind);
        currentModelId = nextModelId;
      }
    }

    if (attempted.length <= 1) {
      throw lastError instanceof Error
        ? lastError
        : new Error("Model execution failed with an unknown provider error.");
    }

    const lastErrorMessage =
      lastError instanceof Error ? lastError.message : "Unknown provider error.";
    throw new Error(
      `Model execution failed after fallback chain: ${attempted.join(" -> ")}.\nLast error: ${lastErrorMessage}`,
    );
  }

  canStreamModel(modelId: string): boolean {
    const binding = this.models.get(modelId);
    return Boolean(binding?.provider.runStream && (binding.provider.supportsStreaming?.() ?? true));
  }

  private modelSupportsImageGeneration(modelId: string): boolean {
    const binding = this.models.get(modelId);
    return Boolean(binding && bindingSupportsImageGeneration(binding));
  }

  private modelSupportsRequest(
    modelId: string,
    request: Omit<UnifiedRequest, "model" | "providerModel">,
  ): boolean {
    if (isImageGenerationRequest(request)) {
      return this.modelSupportsImageGeneration(modelId);
    }

    const requiredCapability = requiredCapabilityForRequest(request);
    const binding = this.models.get(modelId);
    if (!binding) {
      return false;
    }
    if (request.tools.length > 0 && !bindingSupportsCapability(binding, "tools")) {
      return false;
    }

    return !requiredCapability || bindingSupportsCapability(binding, requiredCapability);
  }

  private findNextModelId(
    binding: ModelBinding,
    autoFallbackModelIds: string[],
    visited: Set<string>,
    request: Omit<UnifiedRequest, "model" | "providerModel">,
  ): string | undefined {
    return (
      binding.fallbackModelIds.find(
        (fallback) =>
          !visited.has(fallback) &&
          this.modelSupportsRequest(fallback, request),
      ) ??
      autoFallbackModelIds.find(
        (fallback) =>
          !visited.has(fallback) &&
          this.modelSupportsRequest(fallback, request),
      )
    );
  }

  private getModelSkipReason(
    binding: ModelBinding,
    requestedModelId: string,
  ): ModelFailureKind | undefined {
    const snapshot = this.modelStats.snapshot();
    const providerQuotaBlocked = snapshot.models.some(
      (model) =>
        model.providerId === binding.provider.id &&
        model.suggestedState === "quota_exhausted" &&
        model.suggestedCooldownSeconds > 0,
    );
    if (providerQuotaBlocked) {
      return "quota_exhausted";
    }

    const stats = snapshot.models.find((model) => model.modelId === binding.modelId);
    if (!stats) {
      return undefined;
    }

    if (stats.suggestedCooldownSeconds > 0) {
      if (stats.suggestedState === "quota_exhausted") {
        return "quota_exhausted";
      }
      if (stats.suggestedState === "rate_limited") {
        return "rate_limited";
      }
      if (stats.suggestedState === "capacity_exhausted") {
        return "capacity_exhausted";
      }
      if (stats.suggestedState === "auth_blocked") {
        return "auth";
      }
      return stats.lastFailureKind || "unknown";
    }

    if (binding.modelId !== requestedModelId && stats.suggestedState === "degraded") {
      return stats.lastFailureKind || "unknown";
    }

    return undefined;
  }

  private selectAutoModel(
    request: Omit<UnifiedRequest, "model" | "providerModel">,
  ): { modelId: string; fallbackModelIds: string[] } {
    const candidates = this.rankAutoCandidates(request);
    const selected = candidates[0];
    if (!selected) {
      throw new Error("Auto routing could not find a compatible model.");
    }

    return {
      modelId: selected.binding.modelId,
      fallbackModelIds: candidates.slice(1).map((candidate) => candidate.binding.modelId),
    };
  }

  private rankAutoCandidates(
    request: Omit<UnifiedRequest, "model" | "providerModel">,
  ): AutoRankedCandidate[] {
    return this.rankAutoCandidatesWithProfile(
      request,
      buildAutoRouterPromptProfile(request),
    );
  }

  private rankAutoCandidatesWithProfile(
    request: Omit<UnifiedRequest, "model" | "providerModel">,
    profile: AutoRouterPromptProfile,
  ): AutoRankedCandidate[] {
    const candidates: AutoRankedCandidate[] = [];

    for (const [index, binding] of [...this.models.values()].entries()) {
      if (!binding.autoEligible) {
        continue;
      }
      if (!this.modelSupportsRequest(binding.modelId, request)) {
        continue;
      }

      const stats = this.modelStats.snapshotModel(binding.modelId);
      const benchmark = this.modelBenchmarks.get(binding.modelId);
      let score = 100 - index * 0.01;
      score += scoreModelHealth(stats);
      score += scoreModelBenchmark(benchmark, profile);
      score += scoreModelName(binding, {
        complexity: profile.complexity,
        codingSignal: profile.codingSignal,
        hasTools: profile.hasTools,
        wantsStrongReasoning: profile.wantsStrongReasoning,
        requiredCapability: profile.requiredCapability,
        requestKind: request.requestKind,
      });

      const candidate: AutoRankedCandidate = { binding, score, index };
      if (stats) {
        candidate.stats = stats;
      }
      if (benchmark) {
        candidate.benchmark = benchmark;
      }
      candidates.push(candidate);
    }

    return candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  }

  async *runModelStream(
    modelId: string,
    request: Omit<UnifiedRequest, "model" | "providerModel">,
  ): AsyncIterable<ProviderStreamEvent> {
    if (modelId === AUTO_MODEL_ID) {
      throw new Error("Auto model routing does not support provider-native streaming.");
    }
    const binding = this.models.get(modelId);
    if (!binding) {
      throw new Error(`Unknown model: ${modelId}`);
    }
    if (!binding.provider.runStream) {
      throw new Error(`Model ${modelId} does not support streaming.`);
    }
    if (binding.provider.supportsStreaming && !binding.provider.supportsStreaming()) {
      throw new Error(`Model ${modelId} does not support streaming.`);
    }

    const attemptIndex = 0;
    const startedAt = Date.now();
    this.modelStats.recordAttempt({
      modelId: binding.modelId,
      requestedModelId: modelId,
      providerId: binding.provider.id,
      providerModel: binding.providerModel,
      attemptIndex,
    });

    try {
      for await (const event of binding.provider.runStream({
        ...request,
        model: binding.modelId,
        providerModel: binding.providerModel,
      })) {
        yield event;
      }
      this.modelStats.recordSuccess({
        modelId: binding.modelId,
        requestedModelId: modelId,
        providerId: binding.provider.id,
        providerModel: binding.providerModel,
        attemptIndex,
        durationMs: Date.now() - startedAt,
      });
      trackProvider(binding.provider.id, binding.modelId, true, Date.now() - startedAt);
    } catch (error) {
      this.modelStats.recordFailure({
        modelId: binding.modelId,
        requestedModelId: modelId,
        providerId: binding.provider.id,
        providerModel: binding.providerModel,
        attemptIndex,
        durationMs: Date.now() - startedAt,
        error,
      });
      trackProvider(binding.provider.id, binding.modelId, false, Date.now() - startedAt);
      throw error;
    }
  }
}

function buildBenchmarkRequest(
  binding: ModelBinding,
  prompt: string,
  promptKind: AutoRouterBenchmarkPromptKind,
  timeoutMs: number,
  stream: boolean,
  reasoningEffort: ReasoningEffort | undefined,
  tools: UnifiedToolDefinition[] = [],
): UnifiedRequest {
  const maxTokens =
    promptKind === "small" ? 8 :
      promptKind === "medium" ? 220 :
        promptKind === "reasoning_low" ? 180 :
          promptKind === "tool_call" ? 120 :
            260;

  return {
    requestId: `bench_${binding.modelId}_${promptKind}_${Date.now()}`,
    model: binding.modelId,
    providerModel: binding.providerModel,
    messages: [{ role: "user", content: prompt }],
    tools,
    stream,
    requestKind: "chat_completions",
    reasoningEffort,
    metadata: {
      max_tokens: maxTokens,
      temperature: 0,
      gateway_benchmark: true,
      gateway_benchmark_prompt_kind: promptKind,
      gateway_benchmark_reasoning_effort: reasoningEffort ?? "none",
      gateway_benchmark_timeout_ms: timeoutMs,
    },
  };
}

function buildQualityEvaluationRequest(
  evaluator: ModelBinding,
  tested: ModelBinding,
  probes: BenchmarkProbeSet,
  timeoutMs: number,
): UnifiedRequest {
  return {
    requestId: `bench_quality_${tested.modelId}_${Date.now()}`,
    model: evaluator.modelId,
    providerModel: evaluator.providerModel,
    messages: [
      {
        role: "system",
        content: [
          "You grade short benchmark outputs for an OpenAI-compatible gateway router.",
          "Return only JSON with this shape:",
          "{\"overall\":0-100,\"tasks\":{\"small\":0-100,\"medium\":0-100,\"reasoning_low\":0-100,\"reasoning_high\":0-100,\"tool_call\":0-100},\"verdict\":\"short reason\"}.",
          "Score instruction following, correctness, usefulness, and concision. Penalize empty output, ignored tool requests, and rambling.",
        ].join(" "),
      },
      {
        role: "user",
        content: buildQualityEvaluationPrompt(tested, probes),
      },
    ],
    tools: [],
    stream: false,
    requestKind: "chat_completions",
    reasoningEffort: bindingSupportsCapability(evaluator, "reasoning") ? "high" : undefined,
    metadata: {
      max_tokens: 360,
      temperature: 0,
      gateway_benchmark: true,
      gateway_benchmark_quality_evaluator: true,
      gateway_benchmark_timeout_ms: timeoutMs,
    },
  };
}

function buildQualityEvaluationPrompt(
  tested: ModelBinding,
  probes: BenchmarkProbeSet,
): string {
  const entries = [
    formatQualityProbe("small", BENCHMARK_SMALL_PROMPT, probes.small, "Expected exact text: ok."),
    formatQualityProbe("medium", BENCHMARK_MEDIUM_PROMPT, probes.medium),
    probes.reasoningLow
      ? formatQualityProbe("reasoning_low", "Low-reasoning routing tradeoff prompt.", probes.reasoningLow)
      : undefined,
    probes.reasoningHigh
      ? formatQualityProbe("reasoning_high", "High-reasoning routing policy prompt.", probes.reasoningHigh)
      : undefined,
    probes.toolUse
      ? formatQualityProbe(
        "tool_call",
        BENCHMARK_TOOL_PROMPT,
        probes.toolUse,
        "Expected a function/tool call named lookup_gateway_metric with metric latency_ms.",
      )
      : undefined,
  ].filter((entry): entry is string => Boolean(entry));

  return [
    `Model under test: ${tested.modelId} (${tested.providerModel}) via ${tested.provider.id}.`,
    "Grade each available task independently, then provide the overall quality score.",
    ...entries,
  ].join("\n\n");
}

function formatQualityProbe(
  label: string,
  prompt: string,
  probe: BenchmarkProbeResult,
  expectation?: string,
): string {
  const toolCalls = probe.toolCalls.map((toolCall) => ({
    name: toolCall.name,
    arguments: safeJsonPreview(toolCall.arguments, 240),
  }));
  return [
    `Task: ${label}`,
    `Prompt: ${truncateText(prompt, 700)}`,
    expectation ? `Expectation: ${expectation}` : undefined,
    `Output: ${truncateText(probe.outputText || "(empty)", 1200)}`,
    `Tool calls: ${JSON.stringify(toolCalls)}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function parseQualityEvaluation(outputText: string): ParsedQualityEvaluation {
  const record = parseJsonObjectFromText(outputText);
  const tasksRecord = asRecord(record.tasks ?? record.taskScores ?? record.task_scores);
  const taskScores = tasksRecord
    ? {
      small: readQualityScore(tasksRecord.small),
      medium: readQualityScore(tasksRecord.medium),
      reasoningLow: readQualityScore(tasksRecord.reasoning_low ?? tasksRecord.reasoningLow),
      reasoningHigh: readQualityScore(tasksRecord.reasoning_high ?? tasksRecord.reasoningHigh),
      toolUse: readQualityScore(tasksRecord.tool_call ?? tasksRecord.toolUse),
    }
    : undefined;

  const explicitScore = readQualityScore(record.overall ?? record.score ?? record.quality);
  const taskScoreValues = taskScores
    ? Object.values(taskScores).filter((value): value is number => typeof value === "number")
    : [];
  const score = explicitScore ?? averageNumbers(taskScoreValues);
  if (score === undefined) {
    throw new Error("Quality evaluator did not return a numeric score.");
  }

  const verdict =
    typeof record.verdict === "string"
      ? truncateText(record.verdict.replace(/\s+/g, " ").trim(), 240)
      : undefined;

  return {
    score,
    taskScores,
    verdict,
  };
}

function parseJsonObjectFromText(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(`Quality evaluator returned non-JSON output: ${truncateText(trimmed, 160)}`);
}

function readQualityScore(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return roundNumber(Math.max(0, Math.min(100, value)), 2);
}

function averageNumbers(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return roundNumber(values.reduce((sum, value) => sum + value, 0) / values.length, 2);
}

function safeJsonPreview(value: unknown, maxLength: number): string {
  try {
    return truncateText(
      typeof value === "string" ? value : JSON.stringify(value),
      maxLength,
    );
  } catch {
    return truncateText(String(value), maxLength);
  }
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function benchmarkBaseSnapshot(binding: ModelBinding): Omit<AutoRouterBenchmarkSnapshot, "status" | "score"> {
  return {
    modelId: binding.modelId,
    providerId: binding.provider.id,
    providerModel: binding.providerModel,
  };
}

function tokensPerSecond(tokenEstimate: number, durationMs: number): number | undefined {
  if (tokenEstimate <= 0 || durationMs <= 0) {
    return undefined;
  }
  return roundNumber(tokenEstimate / (durationMs / 1000), 2);
}

function buildBenchmarkTaskScores(input: {
  small: AutoRouterBenchmarkMeasurement;
  medium: AutoRouterBenchmarkMeasurement;
  reasoningLow?: AutoRouterBenchmarkMeasurement;
  reasoningHigh?: AutoRouterBenchmarkMeasurement;
  toolUse?: AutoRouterBenchmarkMeasurement;
  quality?: AutoRouterBenchmarkQualitySnapshot;
}): AutoRouterBenchmarkTaskScores {
  const quick = scoreBenchmarkMeasurement(input.small, 0.9);
  const medium = scoreBenchmarkMeasurement(input.medium, 1);
  const reasoningLow = input.reasoningLow
    ? scoreBenchmarkMeasurement(input.reasoningLow, 0.9)
    : undefined;
  const reasoningHigh = input.reasoningHigh
    ? scoreBenchmarkMeasurement(input.reasoningHigh, 1.1)
    : undefined;
  const toolUse = input.toolUse
    ? scoreBenchmarkMeasurement(input.toolUse, 0.95)
    : undefined;
  const scores = [quick, medium, reasoningLow, reasoningHigh, toolUse].filter(
    (value): value is number => typeof value === "number",
  );
  const performanceOverall = scores.length > 0
    ? scores.reduce((sum, value) => sum + value, 0) / scores.length
    : 0;
  const qualityScore = input.quality?.status === "succeeded"
    ? input.quality.score
    : undefined;
  const qualityRouterScore =
    typeof qualityScore === "number" ? qualityScoreToRouterScore(qualityScore) : undefined;
  const overall = qualityRouterScore === undefined
    ? performanceOverall
    : performanceOverall * 0.7 + qualityRouterScore * 0.3;

  return {
    quick: roundNumber(quick, 2),
    medium: roundNumber(medium, 2),
    reasoningLow: reasoningLow === undefined ? undefined : roundNumber(reasoningLow, 2),
    reasoningHigh: reasoningHigh === undefined ? undefined : roundNumber(reasoningHigh, 2),
    toolUse: toolUse === undefined ? undefined : roundNumber(toolUse, 2),
    quality: qualityScore,
    overall: roundNumber(overall, 2),
  };
}

function scoreBenchmarkMeasurement(
  measurement: AutoRouterBenchmarkMeasurement,
  weight: number,
): number {
  let score = 0;
  const firstTokenMs = measurement.timeToFirstTokenMs ?? measurement.durationMs;
  if (firstTokenMs <= 1000) {
    score += 14;
  } else if (firstTokenMs <= 2500) {
    score += 9;
  } else if (firstTokenMs <= 6000) {
    score += 3;
  } else {
    score -= 10;
  }

  if (measurement.durationMs <= 3500) {
    score += 12;
  } else if (measurement.durationMs <= 9000) {
    score += 7;
  } else if (measurement.durationMs <= 18000) {
    score += 1;
  } else {
    score -= 14;
  }

  const rate = measurement.outputTokensPerSecond ?? 0;
  if (rate >= 45) {
    score += 14;
  } else if (rate >= 20) {
    score += 9;
  } else if (rate >= 8) {
    score += 4;
  } else if (rate > 0 && rate < 3) {
    score -= 8;
  }

  if (measurement.streamed) {
    score += 4;
  }

  if (measurement.promptKind === "small" && measurement.expectedTextMatched === false) {
    score -= 6;
  }

  if (measurement.promptKind === "tool_call") {
    score += (measurement.toolCallCount ?? 0) > 0 ? 18 : -16;
  }

  if ((measurement.outputCharCount ?? 0) === 0 && (measurement.toolCallCount ?? 0) === 0) {
    score -= 12;
  }

  return score * weight;
}

function qualityScoreToRouterScore(score: number): number {
  return ((Math.max(0, Math.min(100, score)) - 50) / 50) * 34;
}

function selectBenchmarkPrompt(
  modelId: string,
  promptKind: AutoRouterBenchmarkPromptKind,
  prompts: string[],
): string {
  if (prompts.length === 0) {
    return BENCHMARK_MEDIUM_PROMPT;
  }

  const now = new Date();
  const dayKey = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86_400_000;
  const seed = hashString(`${modelId}:${promptKind}:${dayKey}`);
  return prompts[seed % prompts.length] ?? prompts[0] ?? BENCHMARK_MEDIUM_PROMPT;
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function benchmarkCandidatePriority(binding: ModelBinding): number {
  const name = modelSearchText(binding);
  let score = 0;
  if (/groq|grok|xai|deepseek|kimi|moonshot|k2/.test(name)) {
    score += 40;
  }
  if (/gpt-5|codex|sonnet|qwen|llama|compound/.test(name)) {
    score += 15;
  }
  if (/image|whisper|speech|tts|embedding/.test(name)) {
    score -= 100;
  }
  return score;
}

function bindingCanEvaluateQuality(binding: ModelBinding): boolean {
  if (bindingSupportsImageGeneration(binding) && binding.capabilities.length === 1) {
    return false;
  }
  return bindingSupportsCapability(binding, "chat") || bindingSupportsCapability(binding, "responses");
}

function scoreQualityEvaluatorCandidate(binding: ModelBinding): number {
  const name = modelSearchText(binding);
  let score = benchmarkCandidatePriority(binding);
  if (bindingSupportsCapability(binding, "reasoning")) {
    score += 30;
  }
  if (/gpt-5\.5|gpt-5\.4|opus|sonnet|gemini.*pro|deepseek.*(r1|reason|v4-pro)|reasoner|120b|k2|pro-preview|pro\b/.test(name)) {
    score += 55;
  }
  if (/mini|flash|lite|instant|haiku|8b|20b|free|compound-mini/.test(name)) {
    score -= 20;
  }
  if (/image|whisper|speech|tts|embedding/.test(name)) {
    score -= 120;
  }
  return score;
}

function roundNumber(value: number, fractionDigits: number): number {
  const factor = 10 ** fractionDigits;
  return Math.round(value * factor) / factor;
}

function bindingSupportsImageGeneration(binding: ModelBinding): boolean {
  return binding.capabilities.includes("image_generation");
}

function bindingSupportsCapability(
  binding: ModelBinding,
  capability: ModelCapability,
): boolean {
  return binding.capabilities.includes(capability);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeModelCapabilities(
  capabilities: ModelCapability[] | undefined,
): ModelCapability[] {
  if (capabilities && capabilities.length > 0) {
    return [...new Set(capabilities)];
  }

  return ["chat", "responses", "tools", "reasoning", "structured_outputs"];
}

function requiredCapabilityForRequest(
  request: Omit<UnifiedRequest, "model" | "providerModel">,
): ModelCapability | undefined {
  if (request.requestKind === "images_generations") {
    return "image_generation";
  }

  if (request.requestKind === "chat_completions") {
    return "chat";
  }

  if (request.requestKind === "responses") {
    return "responses";
  }

  return undefined;
}

function isImageGenerationRequest(
  request: Omit<UnifiedRequest, "model" | "providerModel">,
): boolean {
  return request.requestKind === "images_generations";
}

function isInvalidProviderResult(
  result: ProviderResult,
  request: Omit<UnifiedRequest, "model" | "providerModel">,
): boolean {
  if (isImageGenerationRequest(request)) {
    return isBlankImageGenerationResult(result) || isSyntheticFailureProviderResult(result);
  }

  return isBlankProviderResult(result) || isSyntheticFailureProviderResult(result);
}

function isBlankProviderResult(result: ProviderResult): boolean {
  return result.toolCalls.length === 0 && result.outputText.trim().length === 0;
}

function isBlankImageGenerationResult(result: ProviderResult): boolean {
  return (
    result.toolCalls.length === 0 &&
    result.outputText.trim().length === 0 &&
    !hasPotentialImageGenerationPayload(result.raw)
  );
}

function hasPotentialImageGenerationPayload(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === undefined || value === null) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasPotentialImageGenerationPayload(item, depth + 1));
  }

  if (typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  for (const key of [
    "data",
    "images",
    "image",
    "inline_data",
    "inlineData",
    "output",
    "outputs",
    "content",
    "contentItems",
    "candidates",
    "parts",
    "items",
    "attachments",
    "artifact",
    "artifacts",
    "file",
    "files",
    "result",
    "url",
    "image_url",
    "imageUrl",
    "output_url",
    "outputUrl",
    "download_url",
    "downloadUrl",
    "b64_json",
    "b64_data",
    "base64",
    "base64_data",
    "image_base64",
    "imageBase64",
    "b64",
  ]) {
    if (
      Object.prototype.hasOwnProperty.call(record, key) &&
      hasPotentialImageGenerationPayload(record[key], depth + 1)
    ) {
      return true;
    }
  }

  return false;
}

function isSyntheticFailureProviderResult(result: ProviderResult): boolean {
  if (result.toolCalls.length > 0) {
    return false;
  }

  return isSyntheticAssistantOutputText(result.outputText);
}

function buildInvalidProviderResultError(
  providerId: string,
  modelId: string,
  result: ProviderResult,
): string {
  const raw = result.raw && typeof result.raw === "object"
    ? (result.raw as Record<string, unknown>)
    : undefined;
  const choice =
    raw && Array.isArray(raw.choices) && raw.choices[0] && typeof raw.choices[0] === "object"
      ? (raw.choices[0] as Record<string, unknown>)
      : undefined;
  const responseId = raw && typeof raw.id === "string" ? raw.id : undefined;
  const providerFinishReason =
    choice && typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;

  const details = [
    `provider=${providerId}`,
    `model=${modelId}`,
    `normalized_finish_reason=${result.finishReason}`,
    providerFinishReason ? `provider_finish_reason=${providerFinishReason}` : undefined,
    responseId ? `response_id=${responseId}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");

  if (isBlankProviderResult(result)) {
    return `Provider returned a blank assistant completion. ${details}`.trim();
  }

  const excerpt = result.outputText.trim().replace(/\s+/g, " ").slice(0, 160);
  return `Provider returned a synthetic failure assistant completion. ${details} output_excerpt=${JSON.stringify(excerpt)}`.trim();
}

function requestTextForScoring(
  request: Omit<UnifiedRequest, "model" | "providerModel">,
): string {
  const metadataPrompt =
    request.metadata && "prompt" in request.metadata
      ? extractTextContent(request.metadata.prompt).trim()
      : "";
  const messagesText = request.messages
    .map((message) => message.content)
    .filter(Boolean)
    .join("\n\n");
  return `${metadataPrompt}\n\n${messagesText}`.trim();
}

function buildAutoRouterPromptProfile(
  request: Omit<UnifiedRequest, "model" | "providerModel">,
): AutoRouterPromptProfile {
  const promptText = requestTextForScoring(request);
  const tokenEstimate = estimateTokensFromText(promptText);
  const complexity = scorePromptComplexity(promptText);
  const codingSignal = hasCodingSignal(promptText, request.metadata);
  const hasTools = request.tools.length > 0;
  const wantsStrongReasoning =
    request.reasoningEffort === "high" || request.reasoningEffort === "xhigh";
  const requiredCapability = requiredCapabilityForRequest(request);
  const signals: string[] = [];

  if (complexity >= 3) {
    signals.push("long-context");
  } else if (complexity >= 1) {
    signals.push("medium-complexity");
  } else {
    signals.push("simple");
  }
  if (tokenEstimate <= 300) {
    signals.push("small-token-budget");
  } else if (tokenEstimate >= 1_500) {
    signals.push("larger-token-budget");
  }
  if (codingSignal) {
    signals.push("coding");
  }
  if (hasTools) {
    signals.push("tools");
  }
  if (wantsStrongReasoning) {
    signals.push("strong-reasoning");
  }
  if (requiredCapability) {
    signals.push(`requires-${requiredCapability}`);
  }

  return {
    promptPreview: promptText.replace(/\s+/g, " ").slice(0, 240),
    tokenEstimate,
    complexity,
    codingSignal,
    hasTools,
    wantsStrongReasoning,
    requiredCapability,
    requestKind: request.requestKind,
    signals,
  };
}

function scorePromptComplexity(text: string): number {
  const length = text.length;
  let score = 0;
  if (length > 12000) {
    score += 3;
  } else if (length > 4000) {
    score += 2;
  } else if (length > 1200) {
    score += 1;
  }

  if (/debug|refactor|architect|security|reason|analy[sz]e|compare|plan|multi[- ]step/i.test(text)) {
    score += 1;
  }

  return score;
}

function hasCodingSignal(
  text: string,
  metadata: Record<string, unknown> | undefined,
): boolean {
  const metadataText = metadata ? extractTextContent(metadata) : "";
  return /code|typescript|javascript|python|react|node|repo|git|diff|patch|bug|stack trace|kubectl|docker|build|test|deploy|function|class|api|endpoint/i.test(
    `${text}\n${metadataText}`,
  );
}

function scoreModelHealth(stats: ModelStatsModelSnapshot | undefined): number {
  if (!stats) {
    return 0;
  }

  let score = 0;
  if (stats.suggestedState === "healthy") {
    score += 8;
  } else if (stats.suggestedState === "degraded") {
    score -= 15;
  } else if (
    stats.suggestedState === "cooldown" ||
    stats.suggestedState === "rate_limited" ||
    stats.suggestedState === "capacity_exhausted" ||
    stats.suggestedState === "quota_exhausted" ||
    stats.suggestedState === "auth_blocked"
  ) {
    score -= 120;
  }

  if (stats.successes > 0) {
    score += Math.min(12, stats.successRate * 12);
  }
  score -= Math.min(18, stats.consecutiveFailures * 6);
  score -= Math.min(8, stats.averageSuccessLatencyMs / 15000);

  return score;
}

function scoreModelBenchmark(
  benchmark: AutoRouterBenchmarkSnapshot | undefined,
  profile: AutoRouterPromptProfile,
): number {
  if (!benchmark) {
    return 0;
  }
  if (benchmark.status === "failed") {
    return -22;
  }
  if (benchmark.status === "running" || benchmark.status === "pending") {
    return 0;
  }
  if (benchmark.status === "skipped") {
    return -4;
  }

  const wantsStrongReasoning = profile.wantsStrongReasoning;
  const tokenEstimate = profile.tokenEstimate;
  const isShortPrompt = profile.complexity === 0 && tokenEstimate <= 300;
  const isLargePrompt = profile.complexity >= 2 || tokenEstimate >= 1_500;
  const mediumWeight = profile.complexity >= 1 && profile.complexity <= 2 ? 1.2 : 0.8;
  const smallScore = benchmark.taskScores?.quick ?? (
    benchmark.small ? scoreBenchmarkMeasurement(benchmark.small, 0.25) : 0
  );
  const mediumScore = benchmark.taskScores?.medium ?? (
    benchmark.medium ? scoreBenchmarkMeasurement(benchmark.medium, mediumWeight) : 0
  );
  const reasoningScore = wantsStrongReasoning
    ? benchmark.taskScores?.reasoningHigh ?? (
      benchmark.reasoningHigh ? scoreBenchmarkMeasurement(benchmark.reasoningHigh, 1.1) : 0
    )
    : benchmark.taskScores?.reasoningLow ?? (
      benchmark.reasoningLow ? scoreBenchmarkMeasurement(benchmark.reasoningLow, 0.8) : 0
    );
  const toolUseScore = benchmark.taskScores?.toolUse ?? (
    benchmark.toolUse ? scoreBenchmarkMeasurement(benchmark.toolUse, 0.95) : undefined
  );
  let score =
    isShortPrompt && !wantsStrongReasoning
      ? smallScore * 0.6 + mediumScore * 0.25 + reasoningScore * 0.15
      : wantsStrongReasoning
        ? mediumScore * 0.35 + reasoningScore * 0.65
        : isLargePrompt
          ? smallScore * 0.1 + mediumScore * 0.45 + reasoningScore * 0.45
          : smallScore * 0.2 + mediumScore * 0.55 + reasoningScore * 0.25;

  if (profile.hasTools && typeof toolUseScore === "number") {
    score = score * 0.72 + toolUseScore * 0.28;
  }

  if (benchmark.quality?.status === "succeeded" && typeof benchmark.quality.score === "number") {
    const qualityScore = qualityScoreToRouterScore(benchmark.quality.score);
    const qualityWeight =
      profile.hasTools ? 0.3 :
        wantsStrongReasoning ? 0.45 :
          isLargePrompt ? 0.35 :
            profile.complexity >= 1 ? 0.25 :
              0.12;
    score = score * (1 - qualityWeight) + qualityScore * qualityWeight;
  }

  return Math.max(-35, Math.min(42, score));
}

function scoreModelName(
  binding: ModelBinding,
  context: {
    complexity: number;
    codingSignal: boolean;
    hasTools: boolean;
    wantsStrongReasoning: boolean;
    requiredCapability?: ModelCapability;
    requestKind?: string;
  },
): number {
  const name = modelSearchText(binding);
  let score = 0;

  const isGpt56Sol = /gpt-5\.6-sol/.test(name);
  const isGpt56Terra = /gpt-5\.6-terra/.test(name);
  const isGpt56Luna = /gpt-5\.6-luna/.test(name);
  const isGpt56Family = isGpt56Sol || isGpt56Terra || isGpt56Luna;
  const isStrong = /gpt-5\.5|gpt-5\.4|grok-build|opus|sonnet|gemini.*pro|deepseek.*(r1|reason|v4-pro)|reasoner|120b|k2|pro-preview|pro\b/.test(name) || isGpt56Sol || isGpt56Terra;
  const isFast = /flash|mini|lite|instant|haiku|8b|20b|free|compound-mini/.test(name) || isGpt56Luna;
  const isCoding = /kimi|codex|coder|codestral|deepseek|qwen|gpt-5|grok-build|claude|sonnet/.test(name);
  const isMediumPreferred = /groq|grok|xai|deepseek|kimi|moonshot|k2|compound/.test(name) || isGpt56Terra;

  if (context.requestKind === "images_generations") {
    score += bindingSupportsImageGeneration(binding) ? 100 : -100;
  }

  if (context.hasTools) {
    score += bindingSupportsCapability(binding, "tools") ? 24 : -80;
    if (/compound(?:-mini)?|openrouter\/free/.test(name)) {
      score -= 12;
    }
  }

  if (context.requiredCapability && bindingSupportsCapability(binding, context.requiredCapability)) {
    score += 10;
  }

  if (context.codingSignal) {
    score += isCoding ? 28 : 0;
    score -= /whisper|speech|tts|image/.test(name) ? 60 : 0;
  }

  if (context.wantsStrongReasoning || context.complexity >= 2) {
    score += isStrong ? 24 : 0;
    score -= isFast && !isStrong ? 8 : 0;
  } else if (context.complexity === 0) {
    score += isFast ? 16 : 0;
  }

  if (context.complexity >= 1 && context.complexity <= 2 && !context.wantsStrongReasoning) {
    score += isMediumPreferred ? 18 : 0;
  }

  if (isGpt56Family) {
    if (context.wantsStrongReasoning || context.complexity >= 2) {
      score += isGpt56Sol ? 18 : isGpt56Terra ? 8 : -8;
    } else if (context.complexity === 0) {
      score += isGpt56Luna ? 18 : isGpt56Terra ? 8 : 0;
    } else {
      score += isGpt56Terra ? 18 : 6;
    }
  }

  if (/openrouter/.test(name)) {
    score += 4;
  }

  return score;
}

function modelSearchText(binding: ModelBinding): string {
  return `${binding.modelId} ${binding.providerModel} ${binding.provider.id} ${binding.provider.description ?? ""} ${binding.description ?? ""}`.toLowerCase();
}
