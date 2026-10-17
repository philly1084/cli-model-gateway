const aliases = ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const;

/** Validate caller ceilings without silently replacing an invalid or conflicting limit. */
export function readOutputLimit(metadata?: Record<string, unknown>): number | undefined {
  let limit: number | undefined;
  for (const key of aliases) {
    const value = metadata?.[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${key} must be a positive safe integer`);
    }
    if (limit !== undefined && limit !== value) throw new Error("Conflicting output token limits");
    limit = value;
  }
  return limit;
}

export function copyChatOutputLimit(target: Record<string, unknown>, metadata?: Record<string, unknown>): void {
  const limit = readOutputLimit(metadata);
  if (limit !== undefined) {
    target[metadata?.max_completion_tokens !== undefined ? "max_completion_tokens" : "max_tokens"] = limit;
  }
}

/** Kimi CLI 1.52 reads this per-generation cap; it is not a cap on a whole agent turn. */
export function kimiOutputEnvironment(metadata: Record<string, unknown> | undefined, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const requested = readOutputLimit(metadata);
  const env = { ...inherited };
  if (requested === undefined) return env;
  let limit = requested;
  for (const key of ["KIMI_MODEL_MAX_COMPLETION_TOKENS", "KIMI_MODEL_MAX_TOKENS"]) {
    const existing = Number(inherited[key]);
    if (Number.isSafeInteger(existing) && existing > 0) limit = Math.min(limit, existing);
  }
  env.KIMI_MODEL_MAX_COMPLETION_TOKENS = String(limit);
  return env;
}
