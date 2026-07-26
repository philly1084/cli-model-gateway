export type ChatRole = "system" | "user" | "assistant" | "tool";
export type AssistantPhase = "commentary" | "final_answer";
export const REASONING_EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

export interface ChatMessage {
  role: ChatRole;
  content: string;
  phase?: AssistantPhase;
  name?: string;
  tool_call_id?: string;
  reasoningContent?: unknown;
}

export interface UnifiedToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface UnifiedRequest {
  requestId: string;
  model: string;
  providerModel: string;
  messages: ChatMessage[];
  tools: UnifiedToolDefinition[];
  stream?: boolean;
  requestKind?: string;
  reasoningEffort?: ReasoningEffort;
  metadata?: Record<string, unknown>;
}

export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ProviderTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  promptTokensDetails?: Record<string, unknown>;
  completionTokensDetails?: Record<string, unknown>;
  inputTokensDetails?: Record<string, unknown>;
  outputTokensDetails?: Record<string, unknown>;
  estimated?: boolean;
  source?: string;
}

export interface ProviderResult {
  outputText: string;
  toolCalls: ProviderToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "error";
  reasoningText?: string;
  reasoningContent?: unknown;
  usage?: ProviderTokenUsage;
  resolvedModel?: string;
  raw?: unknown;
}

export type ProviderStreamEvent =
  | {
    type: "reasoning_delta";
    delta: string;
  }
  | {
    type: "output_text_delta";
    delta: string;
  }
  | {
    type: "tool_call";
    toolCall: ProviderToolCall;
  }
  | {
    type: "done";
    finishReason: ProviderResult["finishReason"];
    outputText?: string;
    reasoningText?: string;
    usage?: ProviderTokenUsage;
  };

export type CommandOutputMode =
  | "text"
  | "text_plain"
  | "text_contract_final_line"
  | "json_contract";
export type CommandInputMode = "prompt_stdin" | "request_json_stdin";
export type SessionPtyMode = "auto" | "pipe" | "script";
export type ProviderSessionMode = "interactive" | "login";
export type ProviderSessionStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "terminated"
  | "timed_out";

export interface CommandSpec {
  executable: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
}

export interface SessionCommandConfig {
  executable: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  loginArgs?: string[];
  supportsModelSelection?: boolean;
  modelFlag?: string;
  supportsWorkingDirectory?: boolean;
  idleTimeoutMs?: number;
  maxLifetimeMs?: number;
  ptyMode?: SessionPtyMode;
  closeInputAfterWrite?: boolean;
}

export interface AuthConfig {
  loginCommand?: CommandSpec;
  statusCommand?: CommandSpec;
  /** Command to check rate limits/quota for this provider */
  rateLimitCommand?: CommandSpec;
}

export interface ProviderModelConfig {
  id: string;
  providerModel?: string;
  description?: string;
  fallbackModels?: string[];
  capabilities?: ModelCapability[];
}

export type ModelCapability =
  | "chat"
  | "responses"
  | "tools"
  | "streaming"
  | "reasoning"
  | "structured_outputs"
  | "image_generation";

export interface ModelDiscoveryConfig {
  enabled?: boolean;
  include?: string[];
  exclude?: string[];
}

export interface CliProviderConfig {
  id: string;
  type: "cli";
  description?: string;
  models: ProviderModelConfig[];
  responseCommand: CommandSpec & {
    output: CommandOutputMode;
    input: CommandInputMode;
  };
  sessionCommand?: SessionCommandConfig;
  auth?: AuthConfig;
}

export interface OpenAiCompatibleProviderConfig {
  id: string;
  type: "openai";
  description?: string;
  baseUrl: string;
  apiKeyEnv: string;
  timeoutMs?: number;
  models?: ProviderModelConfig[];
  discovery?: ModelDiscoveryConfig;
}

export type ProviderConfig = CliProviderConfig | OpenAiCompatibleProviderConfig;

export interface ProvidersFile {
  providers: ProviderConfig[];
  remoteCliTargets?: RemoteCliTargetConfig[];
}

export type RemoteCliToolAuthScope = "admin" | "frontend" | "n8n";

export interface RemoteCliTargetConfig {
  targetId: string;
  description?: string;
  host: string;
  user?: string;
  port?: number;
  allowedCwds: string[];
  defaultCwd?: string;
  defaultModel?: string;
  opencodeExecutable?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface AppConfig {
  host: string;
  port: number;
  n8nApiKeys: Set<string>;
  adminApiKey: string;
  frontendApiKeys: Set<string>;
  frontendAllowedCwds: string[];
  codexAgentAllowedWorkspaceRoots: string[];
  remoteCliToolAuthScopes: Set<RemoteCliToolAuthScope>;
  providersPath: string;
  remoteCliTargetsPath?: string;
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  maxJobLogLines: number;
  // Graceful shutdown timeout in milliseconds
  shutdownTimeoutMs: number;
  // HTTP request/socket timeout in milliseconds
  requestTimeoutMs: number;
  // Rate limiting configuration
  rateLimitMax: number;
  rateLimitWindowMs: number;
  // Request body size limit in bytes
  maxRequestBodySize: number;
  // Default reasoning effort when callers omit it
  defaultReasoningEffort?: ReasoningEffort;
  // Run bounded startup probes so the auto router can learn live latency/token signals
  autoRouterBenchmarkOnStart: boolean;
  autoRouterBenchmarkTimeoutMs: number;
  autoRouterBenchmarkMaxModels: number;
  autoRouterBenchmarkConcurrency: number;
  autoRouterBenchmarkIntervalMs: number;
  autoRouterBenchmarkEvaluateQuality: boolean;
  autoRouterBenchmarkEvaluatorModel?: string;
  autoRouterBenchmarkQualityTimeoutMs: number;
}

export type AutoRouterBenchmarkPromptKind =
  | "small"
  | "medium"
  | "reasoning_low"
  | "reasoning_high"
  | "tool_call";
export type AutoRouterBenchmarkStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type AutoRouterQualityEvaluationStatus = "succeeded" | "failed" | "skipped";

export interface AutoRouterBenchmarkMeasurement {
  promptKind: AutoRouterBenchmarkPromptKind;
  reasoningEffort?: ReasoningEffort;
  streamed: boolean;
  durationMs: number;
  timeToFirstTokenMs?: number;
  outputTokenEstimate: number;
  outputTokensPerSecond?: number;
  outputCharCount?: number;
  toolCallCount?: number;
  expectedTextMatched?: boolean;
  measuredUsage?: ProviderTokenUsage;
}

export interface AutoRouterBenchmarkQualityTaskScores {
  small?: number;
  medium?: number;
  reasoningLow?: number;
  reasoningHigh?: number;
  toolUse?: number;
}

export interface AutoRouterBenchmarkQualitySnapshot {
  status: AutoRouterQualityEvaluationStatus;
  evaluatorModelId?: string;
  evaluatorProviderId?: string;
  evaluatorProviderModel?: string;
  score?: number;
  taskScores?: AutoRouterBenchmarkQualityTaskScores;
  verdict?: string;
  error?: string;
}

export interface AutoRouterBenchmarkTaskScores {
  quick?: number;
  medium?: number;
  reasoningLow?: number;
  reasoningHigh?: number;
  toolUse?: number;
  quality?: number;
  overall: number;
}

export interface AutoRouterBenchmarkSnapshot {
  modelId: string;
  providerId: string;
  providerModel: string;
  status: AutoRouterBenchmarkStatus;
  updatedAt?: string;
  score: number;
  small?: AutoRouterBenchmarkMeasurement;
  medium?: AutoRouterBenchmarkMeasurement;
  reasoningLow?: AutoRouterBenchmarkMeasurement;
  reasoningHigh?: AutoRouterBenchmarkMeasurement;
  toolUse?: AutoRouterBenchmarkMeasurement;
  quality?: AutoRouterBenchmarkQualitySnapshot;
  taskScores?: AutoRouterBenchmarkTaskScores;
  error?: string;
}

export interface AutoRouterPromptProfile {
  promptPreview: string;
  tokenEstimate: number;
  complexity: number;
  codingSignal: boolean;
  hasTools: boolean;
  wantsStrongReasoning: boolean;
  requiredCapability?: ModelCapability;
  requestKind?: string;
  signals: string[];
}

export interface AutoRouterCandidateSnapshot {
  modelId: string;
  providerId: string;
  providerModel: string;
  capabilities: ModelCapability[];
  score: number;
  benchmarkStatus?: AutoRouterBenchmarkStatus;
  benchmarkScore?: number;
  benchmarkQualityScore?: number;
  benchmarkTaskScores?: AutoRouterBenchmarkTaskScores;
  healthState?:
    | "healthy"
    | "degraded"
    | "rate_limited"
    | "capacity_exhausted"
    | "quota_exhausted"
    | "auth_blocked"
    | "cooldown";
}

export interface AutoRouterDecisionSnapshot {
  selectedModelId: string;
  selectedProviderId: string;
  selectedProviderModel: string;
  promptProfile: AutoRouterPromptProfile;
  candidates: AutoRouterCandidateSnapshot[];
}

export interface AuthStatusResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface LoginJobSummary {
  id: string;
  providerId: string;
  command: string;
  args: string[];
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  urls: string[];
  logs: string[];
}

// Rate limit tracking types
export interface RateLimitInfo {
  /** Provider ID */
  providerId: string;
  /** Model ID (if model-specific) */
  modelId?: string;
  /** Type of limit */
  limitType: "requests" | "tokens" | "credits" | "billing" | "unknown";
  /** Current usage (if available) */
  currentUsage?: number;
  /** Maximum allowed (if available) */
  maxAllowed?: number;
  /** Remaining quota (if available) */
  remaining?: number;
  /** When the limit resets (ISO timestamp) */
  resetAt?: string;
  /** Time when this data was fetched */
  checkedAt: string;
  /** Whether the check was successful */
  ok: boolean;
  /** Error message if check failed */
  error?: string;
  /** Raw output from the provider command */
  raw?: unknown;
}

export interface ProviderRateLimits {
  providerId: string;
  providerDescription?: string;
  /** Overall provider status */
  status: "healthy" | "degraded" | "rate_limited" | "auth_error" | "unknown";
  /** Rate limit info for this provider */
  limits: RateLimitInfo[];
  /** When all limits were last checked */
  lastCheckedAt?: string;
}

export interface ProviderSessionCapability {
  providerId: string;
  providerDescription?: string;
  providerType: ProviderConfig["type"];
  supportsSessions: boolean;
  supportsLoginSessions: boolean;
  supportsModelSelection: boolean;
  supportsWorkingDirectory: boolean;
  ptyMode?: SessionPtyMode;
  models: ProviderModelConfig[];
}

export interface ProviderSessionSummary {
  id: string;
  providerId: string;
  providerDescription?: string;
  mode: ProviderSessionMode;
  status: ProviderSessionStatus;
  model?: string;
  cwd?: string;
  cols: number;
  rows: number;
  createdAt: string;
  startedAt: string;
  lastActivityAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  supportsResize: boolean;
  streamToken: string;
}

export type ProviderSessionEvent =
  | {
    type: "output";
    cursor: number;
    ts: string;
    data: string;
  }
  | {
    type: "reasoning";
    cursor: number;
    ts: string;
    summary: string;
    data?: Record<string, unknown>;
  }
  | {
    type: "status";
    cursor: number;
    ts: string;
    status: ProviderSessionStatus;
    message?: string;
  }
  | {
    type: "exit";
    cursor: number;
    ts: string;
    exitCode: number | null;
  };

export type RemoteAgentTaskStatus = ProviderSessionStatus;

export interface RemoteAgentTaskSummary {
  id: string;
  providerId: string;
  providerDescription?: string;
  targetId: string;
  targetDescription?: string;
  host: string;
  user?: string;
  port?: number;
  cwd: string;
  model?: string;
  adminMode?: boolean;
  task: string;
  status: RemoteAgentTaskStatus;
  createdAt: string;
  updatedAt: string;
  sessionId: string;
  streamToken: string;
  reasoning: {
    summary: string;
    data: Record<string, unknown>;
  };
}
