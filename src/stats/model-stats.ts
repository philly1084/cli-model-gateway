export type ModelFailureKind =
  | "rate_limited"
  | "capacity_exhausted"
  | "quota_exhausted"
  | "timeout"
  | "auth"
  | "provider_exit"
  | "config"
  | "invalid_model"
  | "unknown";

export type ModelSuggestedState =
  | "healthy"
  | "degraded"
  | "rate_limited"
  | "capacity_exhausted"
  | "quota_exhausted"
  | "auth_blocked"
  | "cooldown";

export interface RegisterModelInput {
  modelId: string;
  providerId: string;
  providerModel: string;
  fallbackModels: string[];
  description?: string;
}

export interface RecordAttemptInput {
  modelId: string;
  requestedModelId: string;
  providerId: string;
  providerModel: string;
  attemptIndex: number;
}

export interface RecordOutcomeInput {
  modelId: string;
  requestedModelId: string;
  providerId: string;
  providerModel: string;
  attemptIndex: number;
  durationMs: number;
}

export interface RecordFailureInput extends RecordOutcomeInput {
  error: unknown;
}

export interface RecordFallbackInput {
  requestedModelId: string;
  fromModelId: string;
  toModelId: string;
  reason: ModelFailureKind;
}

export interface ModelFailureEvent {
  ts: string;
  modelId: string;
  requestedModelId: string;
  providerId: string;
  providerModel: string;
  attemptIndex: number;
  kind: ModelFailureKind;
  message: string;
}

export interface ModelStatsModelSnapshot {
  modelId: string;
  providerId: string;
  providerModel: string;
  description?: string;
  fallbackModels: string[];
  attempts: number;
  successes: number;
  failures: number;
  successRate: number;
  failureRate: number;
  fallbackOutCount: number;
  fallbackInCount: number;
  failuresByKind: Record<ModelFailureKind, number>;
  consecutiveFailures: number;
  consecutiveRateLimitedFailures: number;
  consecutiveCapacityExhaustedFailures: number;
  consecutiveQuotaExhaustedFailures: number;
  averageAttemptLatencyMs: number;
  averageSuccessLatencyMs: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailureKind?: ModelFailureKind;
  lastFailureMessage?: string;
  suggestedState: ModelSuggestedState;
  suggestedCooldownSeconds: number;
}

export interface ModelStatsSnapshot {
  startedAt: string;
  generatedAt: string;
  uptimeSeconds: number;
  summary: {
    registeredModels: number;
    attempts: number;
    successes: number;
    failures: number;
    fallbackTransitions: number;
    failuresByKind: Record<ModelFailureKind, number>;
  };
  models: ModelStatsModelSnapshot[];
  recentFailures: ModelFailureEvent[];
}

interface MutableModelStats {
  modelId: string;
  providerId: string;
  providerModel: string;
  description?: string;
  fallbackModels: string[];
  attempts: number;
  successes: number;
  failures: number;
  fallbackOutCount: number;
  fallbackInCount: number;
  failuresByKind: Record<ModelFailureKind, number>;
  consecutiveFailures: number;
  consecutiveRateLimitedFailures: number;
  consecutiveCapacityExhaustedFailures: number;
  consecutiveQuotaExhaustedFailures: number;
  totalAttemptDurationMs: number;
  totalSuccessDurationMs: number;
  lastAttemptAtMs?: number;
  lastSuccessAtMs?: number;
  lastFailureAtMs?: number;
  lastFailureKind?: ModelFailureKind;
  lastFailureMessage?: string;
}

const MAX_RECENT_FAILURES = 200;
const MAX_FAILURE_MESSAGE_CHARS = 1200;
const FRACTION_DIGITS = 4;

export class ModelStatsTracker {
  private readonly startedAtMs = Date.now();
  private readonly models = new Map<string, MutableModelStats>();
  private readonly recentFailures: ModelFailureEvent[] = [];
  private fallbackTransitions = 0;

  registerModel(input: RegisterModelInput): void {
    const existing = this.models.get(input.modelId);
    if (existing) {
      existing.providerId = input.providerId;
      existing.providerModel = input.providerModel;
      existing.description = input.description;
      existing.fallbackModels = [...input.fallbackModels];
      return;
    }

    this.models.set(input.modelId, createMutableModelStats(input));
  }

  recordAttempt(input: RecordAttemptInput): void {
    const stat = this.ensureModel(
      input.modelId,
      input.providerId,
      input.providerModel,
      undefined,
      [],
    );
    stat.attempts += 1;
    stat.lastAttemptAtMs = Date.now();
  }

  recordSuccess(input: RecordOutcomeInput): void {
    const stat = this.ensureModel(
      input.modelId,
      input.providerId,
      input.providerModel,
      undefined,
      [],
    );

    const now = Date.now();
    const durationMs = sanitizeDuration(input.durationMs);
    stat.successes += 1;
    stat.totalAttemptDurationMs += durationMs;
    stat.totalSuccessDurationMs += durationMs;
    stat.lastSuccessAtMs = now;
    stat.lastAttemptAtMs = now;
    stat.consecutiveFailures = 0;
    stat.consecutiveRateLimitedFailures = 0;
    stat.consecutiveCapacityExhaustedFailures = 0;
    stat.consecutiveQuotaExhaustedFailures = 0;
  }

  recordFailure(input: RecordFailureInput): ModelFailureKind {
    const stat = this.ensureModel(
      input.modelId,
      input.providerId,
      input.providerModel,
      undefined,
      [],
    );

    const now = Date.now();
    const durationMs = sanitizeDuration(input.durationMs);
    const classified = classifyFailure(input.error);

    stat.failures += 1;
    stat.totalAttemptDurationMs += durationMs;
    stat.lastFailureAtMs = now;
    stat.lastFailureKind = classified.kind;
    stat.lastFailureMessage = classified.message;
    stat.lastAttemptAtMs = now;
    stat.failuresByKind[classified.kind] += 1;

    stat.consecutiveFailures += 1;
    if (classified.kind === "rate_limited") {
      stat.consecutiveRateLimitedFailures += 1;
    } else {
      stat.consecutiveRateLimitedFailures = 0;
    }
    if (classified.kind === "capacity_exhausted") {
      stat.consecutiveCapacityExhaustedFailures += 1;
    } else {
      stat.consecutiveCapacityExhaustedFailures = 0;
    }
    if (classified.kind === "quota_exhausted") {
      stat.consecutiveQuotaExhaustedFailures += 1;
    } else {
      stat.consecutiveQuotaExhaustedFailures = 0;
    }

    this.pushFailureEvent({
      ts: toIso(now),
      modelId: input.modelId,
      requestedModelId: input.requestedModelId,
      providerId: stat.providerId,
      providerModel: stat.providerModel,
      attemptIndex: input.attemptIndex,
      kind: classified.kind,
      message: classified.message,
    });

    return classified.kind;
  }

  recordFallback(input: RecordFallbackInput): void {
    const from = this.models.get(input.fromModelId);
    if (from) {
      from.fallbackOutCount += 1;
    }

    const to = this.models.get(input.toModelId);
    if (to) {
      to.fallbackInCount += 1;
    }

    this.fallbackTransitions += 1;
  }

  snapshot(): ModelStatsSnapshot {
    const now = Date.now();
    const modelSnapshots = [...this.models.values()]
      .map((stat) => this.toModelSnapshot(stat, now))
      .sort((a, b) => a.modelId.localeCompare(b.modelId));

    const summaryFailuresByKind = createEmptyFailureCounts();
    let attempts = 0;
    let successes = 0;
    let failures = 0;

    for (const stat of this.models.values()) {
      attempts += stat.attempts;
      successes += stat.successes;
      failures += stat.failures;
      for (const kind of failureKinds) {
        summaryFailuresByKind[kind] += stat.failuresByKind[kind];
      }
    }

    return {
      startedAt: toIso(this.startedAtMs),
      generatedAt: toIso(now),
      uptimeSeconds: Math.max(0, Math.floor((now - this.startedAtMs) / 1000)),
      summary: {
        registeredModels: this.models.size,
        attempts,
        successes,
        failures,
        fallbackTransitions: this.fallbackTransitions,
        failuresByKind: summaryFailuresByKind,
      },
      models: modelSnapshots,
      recentFailures: [...this.recentFailures],
    };
  }

  snapshotModel(modelId: string): ModelStatsModelSnapshot | undefined {
    const stat = this.models.get(modelId);
    if (!stat) {
      return undefined;
    }

    return this.toModelSnapshot(stat, Date.now());
  }

  private ensureModel(
    modelId: string,
    providerId: string,
    providerModel: string,
    description: string | undefined,
    fallbackModels: string[],
  ): MutableModelStats {
    const existing = this.models.get(modelId);
    if (existing) {
      if (providerId) {
        existing.providerId = providerId;
      }
      if (providerModel) {
        existing.providerModel = providerModel;
      }
      if (description !== undefined) {
        existing.description = description;
      }
      if (fallbackModels.length > 0) {
        existing.fallbackModels = [...fallbackModels];
      }
      return existing;
    }

    const created = createMutableModelStats({
      modelId,
      providerId: providerId || "unknown",
      providerModel: providerModel || modelId,
      description,
      fallbackModels,
    });
    this.models.set(modelId, created);
    return created;
  }

  private pushFailureEvent(event: ModelFailureEvent): void {
    this.recentFailures.push(event);
    if (this.recentFailures.length > MAX_RECENT_FAILURES) {
      this.recentFailures.splice(0, this.recentFailures.length - MAX_RECENT_FAILURES);
    }
  }

  private toModelSnapshot(stat: MutableModelStats, now: number): ModelStatsModelSnapshot {
    const attempts = stat.attempts;
    const failures = stat.failures;
    const successes = stat.successes;
    const successRate = attempts === 0 ? 0 : round(successes / attempts);
    const failureRate = attempts === 0 ? 0 : round(failures / attempts);
    const averageAttemptLatencyMs = attempts === 0 ? 0 : round(stat.totalAttemptDurationMs / attempts);
    const averageSuccessLatencyMs = successes === 0 ? 0 : round(stat.totalSuccessDurationMs / successes);

    const cooldown = computeCooldown(stat, now);
    const suggestedState = determineSuggestedState(stat, attempts, failureRate, cooldown.cooldownSeconds);

    return {
      modelId: stat.modelId,
      providerId: stat.providerId,
      providerModel: stat.providerModel,
      description: stat.description,
      fallbackModels: [...stat.fallbackModels],
      attempts,
      successes,
      failures,
      successRate,
      failureRate,
      fallbackOutCount: stat.fallbackOutCount,
      fallbackInCount: stat.fallbackInCount,
      failuresByKind: { ...stat.failuresByKind },
      consecutiveFailures: stat.consecutiveFailures,
      consecutiveRateLimitedFailures: stat.consecutiveRateLimitedFailures,
      consecutiveCapacityExhaustedFailures: stat.consecutiveCapacityExhaustedFailures,
      consecutiveQuotaExhaustedFailures: stat.consecutiveQuotaExhaustedFailures,
      averageAttemptLatencyMs,
      averageSuccessLatencyMs,
      lastAttemptAt: stat.lastAttemptAtMs ? toIso(stat.lastAttemptAtMs) : undefined,
      lastSuccessAt: stat.lastSuccessAtMs ? toIso(stat.lastSuccessAtMs) : undefined,
      lastFailureAt: stat.lastFailureAtMs ? toIso(stat.lastFailureAtMs) : undefined,
      lastFailureKind: stat.lastFailureKind,
      lastFailureMessage: stat.lastFailureMessage,
      suggestedState,
      suggestedCooldownSeconds: cooldown.cooldownSeconds,
    };
  }
}

function createMutableModelStats(input: RegisterModelInput): MutableModelStats {
  return {
    modelId: input.modelId,
    providerId: input.providerId,
    providerModel: input.providerModel,
    description: input.description,
    fallbackModels: [...input.fallbackModels],
    attempts: 0,
    successes: 0,
    failures: 0,
    fallbackOutCount: 0,
    fallbackInCount: 0,
    failuresByKind: createEmptyFailureCounts(),
    consecutiveFailures: 0,
    consecutiveRateLimitedFailures: 0,
    consecutiveCapacityExhaustedFailures: 0,
    consecutiveQuotaExhaustedFailures: 0,
    totalAttemptDurationMs: 0,
    totalSuccessDurationMs: 0,
  };
}

const failureKinds: ModelFailureKind[] = [
  "rate_limited",
  "capacity_exhausted",
  "quota_exhausted",
  "timeout",
  "auth",
  "provider_exit",
  "config",
  "invalid_model",
  "unknown",
];

function createEmptyFailureCounts(): Record<ModelFailureKind, number> {
  return {
    rate_limited: 0,
    capacity_exhausted: 0,
    quota_exhausted: 0,
    timeout: 0,
    auth: 0,
    provider_exit: 0,
    config: 0,
    invalid_model: 0,
    unknown: 0,
  };
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function round(value: number): number {
  return Number(value.toFixed(FRACTION_DIGITS));
}

function sanitizeDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return 0;
  }
  return Math.round(durationMs);
}

function classifyFailure(error: unknown): {
  kind: ModelFailureKind;
  message: string;
} {
  const message = truncateFailureMessage(getErrorMessage(error));
  const normalized = message.toLowerCase();

  if (includesAny(normalized, ["unknown model:"])) {
    return { kind: "invalid_model", message };
  }

  if (
    includesAny(normalized, [
      "fallback model not found",
      "duplicate model id",
      "does not expose model",
      "api_key is not set",
      "api key is not set",
      "_api_key is not set",
      "api key env",
      "missing api key",
      "missing provider api key",
      "environment variable",
    ])
  ) {
    return { kind: "config", message };
  }

  if (includesAny(normalized, ["insufficient_quota", "quota", "billing", "credit balance", "out of credits"])) {
    return { kind: "quota_exhausted", message };
  }

  if (
    includesAny(normalized, [
      "resource_exhausted",
      "capacity",
      "model exhausted",
      "overloaded",
      "no available",
      "temporarily unavailable",
    ])
  ) {
    return { kind: "capacity_exhausted", message };
  }

  if (includesAny(normalized, ["rate limit", "too many requests", "status code: 429", "http 429", "retry later"])) {
    return { kind: "rate_limited", message };
  }

  if (includesAny(normalized, ["timed out", "timeout"])) {
    return { kind: "timeout", message };
  }

  if (
    includesAny(normalized, [
      "unauthorized",
      "forbidden",
      "invalid api key",
      "authentication",
      "not authenticated",
      "permission denied",
      "access denied",
    ])
  ) {
    return { kind: "auth", message };
  }

  if (includesAny(normalized, ["provider command exited with code", "provider command"])) {
    return { kind: "provider_exit", message };
  }

  return { kind: "unknown", message };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || "Error";
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function truncateFailureMessage(message: string): string {
  const compact = message.trim();
  if (compact.length <= MAX_FAILURE_MESSAGE_CHARS) {
    return compact;
  }
  return `${compact.slice(0, MAX_FAILURE_MESSAGE_CHARS)}...`;
}

function includesAny(source: string, needles: string[]): boolean {
  for (const needle of needles) {
    if (source.includes(needle)) {
      return true;
    }
  }
  return false;
}

function computeCooldown(
  stat: MutableModelStats,
  now: number,
): {
  cooldownSeconds: number;
} {
  const kind = stat.lastFailureKind;
  const lastFailureAtMs = stat.lastFailureAtMs;
  if (!kind || !lastFailureAtMs) {
    return { cooldownSeconds: 0 };
  }

  const baseCooldownSecondsByKind: Partial<Record<ModelFailureKind, number>> = {
    rate_limited: 60,
    capacity_exhausted: 120,
    quota_exhausted: 3600,
    timeout: 30,
    auth: 600,
    config: 3600,
  };

  const base = baseCooldownSecondsByKind[kind] || 0;
  if (base === 0) {
    return { cooldownSeconds: 0 };
  }

  let consecutive = stat.consecutiveFailures;
  if (kind === "rate_limited") {
    consecutive = stat.consecutiveRateLimitedFailures;
  } else if (kind === "capacity_exhausted") {
    consecutive = stat.consecutiveCapacityExhaustedFailures;
  } else if (kind === "quota_exhausted") {
    consecutive = stat.consecutiveQuotaExhaustedFailures;
  }

  const multiplier = Math.min(8, Math.max(1, consecutive));
  const cooldownMs = base * 1000 * multiplier;
  const remainingMs = Math.max(0, lastFailureAtMs + cooldownMs - now);

  return {
    cooldownSeconds: Math.ceil(remainingMs / 1000),
  };
}

function determineSuggestedState(
  stat: MutableModelStats,
  attempts: number,
  failureRate: number,
  cooldownSeconds: number,
): ModelSuggestedState {
  if (cooldownSeconds > 0) {
    if (stat.lastFailureKind === "rate_limited") {
      return "rate_limited";
    }
    if (stat.lastFailureKind === "capacity_exhausted") {
      return "capacity_exhausted";
    }
    if (stat.lastFailureKind === "quota_exhausted") {
      return "quota_exhausted";
    }
    if (stat.lastFailureKind === "auth") {
      return "auth_blocked";
    }
    return "cooldown";
  }

  if (stat.consecutiveFailures >= 3 && failureRate >= 0.75) {
    return "degraded";
  }

  if (attempts >= 6 && failureRate >= 0.5) {
    return "degraded";
  }

  return "healthy";
}
