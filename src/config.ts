import { loadProviderProfiles, resolveProviderProfile } from "./provider-profiles.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import {
  REASONING_EFFORT_VALUES,
  type AppConfig,
  type ProvidersFile,
  type RemoteCliToolAuthScope,
} from "./types";
import { parseReasoningEffort } from "./utils/reasoning";

const commandSchema = z.object({
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().default(180000),
});

const modelCapabilitySchema = z.enum([
  "chat",
  "responses",
  "tools",
  "streaming",
  "reasoning",
  "structured_outputs",
  "image_generation",
]);

const providerModelSchema = z.object({
  id: z.string().min(1),
  providerModel: z.string().optional(),
  description: z.string().optional(),
  fallbackModels: z.array(z.string().min(1)).optional(),
  capabilities: z.array(modelCapabilitySchema).optional(),
  autoEligible: z.boolean().optional(),
  manualOnly: z.boolean().optional(),
});

const discoverySchema = z.object({
  enabled: z.boolean().optional(),
  include: z.array(z.string().min(1)).optional(),
  exclude: z.array(z.string().min(1)).optional(),
});

const cliProviderSchema = z.object({
  profile: z.string().min(1).optional(),
  id: z.string().min(1),
  type: z.literal("cli"),
  description: z.string().optional(),
  models: z.array(providerModelSchema).min(1),
  responseCommand: commandSchema.extend({
    output: z
      .enum(["text", "text_plain", "text_contract_final_line", "json_contract"])
      .default("text"),
    input: z.enum(["prompt_stdin", "request_json_stdin"]).default("prompt_stdin"),
  }),
  sessionCommand: z
    .object({
      executable: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string()).optional(),
      cwd: z.string().optional(),
      loginArgs: z.array(z.string()).optional(),
      supportsModelSelection: z.boolean().optional(),
      modelFlag: z.string().min(1).optional(),
      supportsWorkingDirectory: z.boolean().optional(),
      idleTimeoutMs: z.number().int().positive().optional(),
      maxLifetimeMs: z.number().int().positive().optional(),
      ptyMode: z.enum(["auto", "pipe", "script"]).optional(),
      closeInputAfterWrite: z.boolean().optional(),
    })
    .optional(),
  auth: z
    .object({
      loginCommand: commandSchema.optional(),
      statusCommand: commandSchema.optional(),
      rateLimitCommand: commandSchema.optional(),
    })
    .optional(),
});

const openAiProviderSchema = z.object({
  profile: z.string().min(1).optional(),
  id: z.string().min(1),
  type: z.literal("openai"),
  description: z.string().optional(),
  baseUrl: z.string().min(1),
  apiKeyEnv: z.string().min(1).optional(),
  credentialBroker: z.object({
    url: z.string().url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; }),
    providerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    certFile: z.string().refine(path.isAbsolute),
    keyFile: z.string().refine(path.isAbsolute),
    caFile: z.string().refine(path.isAbsolute),
    serverFingerprint: z.string().regex(/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/),
  }).strict().optional(),
  timeoutMs: z.number().int().positive().default(240000),
  models: z.array(providerModelSchema).default([]),
  discovery: discoverySchema.optional(),
});

const remoteCliTargetSchema = z.object({
  targetId: z.string().min(1),
  description: z.string().optional(),
  host: z.string().min(1),
  user: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  allowedCwds: z.array(z.string().min(1)).min(1),
  defaultCwd: z.string().min(1).optional(),
  defaultModel: z.string().min(1).optional(),
  opencodeExecutable: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
});

const providersFileSchema = z.object({
  providers: z
    .array(z.discriminatedUnion("type", [cliProviderSchema, openAiProviderSchema]))
    .min(1),
  remoteCliTargets: z.array(remoteCliTargetSchema).default([]),
});

const remoteCliTargetsFileSchema = z.object({
  remoteCliTargets: z.array(remoteCliTargetSchema),
});

const reasoningEffortSchema = z.enum(REASONING_EFFORT_VALUES);

function parseApiKeys(): Set<string> {
  return parseApiKeysFromEnv("N8N_API_KEY", "N8N_API_KEYS", true);
}

function parseFrontendApiKeys(): Set<string> {
  return parseApiKeysFromEnv("FRONTEND_API_KEY", "FRONTEND_API_KEYS", false);
}

function parseApiKeysFromEnv(
  singleEnvKey: string,
  multiEnvKey: string,
  required: boolean,
): Set<string> {
  const keys = new Set<string>();

  const single = process.env[singleEnvKey]?.trim();
  if (single) {
    keys.add(single);
  }

  const multi = process.env[multiEnvKey];
  if (multi) {
    for (const key of multi.split(",")) {
      const value = key.trim();
      if (value) {
        keys.add(value);
      }
    }
  }

  if (required && keys.size === 0) {
    throw new Error(`Set ${singleEnvKey} or ${multiEnvKey}.`);
  }

  return keys;
}

function parseFrontendAllowedCwds(): string[] {
  const raw = process.env.FRONTEND_ALLOWED_CWDS?.trim();
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(process.cwd(), entry));
}

function parseCodexAgentAllowedWorkspaceRoots(frontendAllowedCwds: string[]): string[] {
  const raw =
    process.env.CODEX_AGENT_ALLOWED_WORKSPACE_ROOTS?.trim() ||
    process.env.SYMPHONY_WORKSPACE_ROOTS?.trim() ||
    process.env.SYMPHONY_WORKSPACE_ROOT?.trim();
  if (!raw) {
    return frontendAllowedCwds;
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(process.cwd(), entry));
}

function parseRemoteCliToolAuthScopes(): Set<RemoteCliToolAuthScope> {
  const raw = process.env.REMOTE_CLI_TOOL_AUTH_SCOPES?.trim();
  const values = raw ? raw.split(",").map((entry) => entry.trim()).filter(Boolean) : ["frontend", "admin"];
  const allowed = new Set<RemoteCliToolAuthScope>(["admin", "frontend", "n8n"]);
  const scopes = new Set<RemoteCliToolAuthScope>();

  for (const value of values) {
    if (!allowed.has(value as RemoteCliToolAuthScope)) {
      throw new Error(
        `Invalid REMOTE_CLI_TOOL_AUTH_SCOPES entry: ${value}. Expected one of: admin, frontend, n8n`,
      );
    }
    scopes.add(value as RemoteCliToolAuthScope);
  }

  return scopes;
}

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return defaultValue;
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  throw new Error(`Invalid ${name}: ${process.env[name]}. Expected true or false.`);
}

function parseIntegerEnv(name: string, defaultValue: number, minValue: number): number {
  const raw = process.env[name]?.trim() || String(defaultValue);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minValue) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

export function loadEmbeddingsConfig(): AppConfig["embeddings"] {
  const rawUrl = process.env.EMBEDDINGS_UPSTREAM_URL?.trim();
  if (!rawUrl) return undefined;
  let url: URL;
  try {
    url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        rawUrl.includes("?") || rawUrl.includes("#")) throw new Error();
  } catch {
    throw new Error("Invalid EMBEDDINGS_UPSTREAM_URL: expected HTTP(S) without credentials, query or fragment.");
  }
  const schema = z.array(z.object({
    id: z.string().trim().min(1),
    aliases: z.array(z.string().trim().min(1)).default([]),
    upstreamModel: z.string().trim().min(1),
    dimensions: z.number().int().positive(),
  }).strict()).min(1);
  let models;
  try {
    models = schema.parse(process.env.EMBEDDINGS_MODELS === undefined ? [{
      id: "sentence-transformers/all-MiniLM-L6-v2",
      aliases: ["all-minilm-l6-v2"], upstreamModel: "all-minilm:l6-v2", dimensions: 384,
    }] : JSON.parse(process.env.EMBEDDINGS_MODELS));
    const names = models.flatMap(model => [model.id, ...model.aliases]);
    if (names.includes("auto") || new Set(names).size !== names.length) throw new Error();
  } catch {
    throw new Error("Invalid EMBEDDINGS_MODELS: expected unique ids/aliases (excluding auto), upstreamModel and positive integer dimensions.");
  }
  return {
    upstreamUrl: url.toString().replace(/\/+$/, ""),
    apiKey: process.env.EMBEDDINGS_UPSTREAM_API_KEY?.trim() || undefined,
    timeoutMs: parseIntegerEnv("EMBEDDINGS_TIMEOUT_MS", 15000, 1),
    models,
  };
}

export function loadAppConfig(): AppConfig {
  const adminApiKey = process.env.ADMIN_API_KEY?.trim();
  if (!adminApiKey) {
    throw new Error("Set ADMIN_API_KEY.");
  }

  const host = process.env.HOST?.trim() || "0.0.0.0";
  const portRaw = process.env.PORT?.trim() || "8080";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${portRaw}`);
  }

  const providersPath = path.resolve(
    process.cwd(),
    process.env.PROVIDERS_CONFIG_PATH?.trim() || "config/providers.yaml",
  );

  const logLevel = (process.env.LOG_LEVEL?.trim() as AppConfig["logLevel"] | undefined) || "info";
  const maxJobLogLinesRaw = process.env.MAX_JOB_LOG_LINES?.trim() || "300";
  const maxJobLogLines = Number(maxJobLogLinesRaw);
  if (!Number.isInteger(maxJobLogLines) || maxJobLogLines < 50) {
    throw new Error(`Invalid MAX_JOB_LOG_LINES: ${maxJobLogLinesRaw}`);
  }

  // Graceful shutdown timeout (default: 30 seconds)
  const shutdownTimeoutMsRaw = process.env.SHUTDOWN_TIMEOUT_MS?.trim() || "30000";
  const shutdownTimeoutMs = Number(shutdownTimeoutMsRaw);
  if (!Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1000) {
    throw new Error(`Invalid SHUTDOWN_TIMEOUT_MS: ${shutdownTimeoutMsRaw}`);
  }

  const requestTimeoutMsRaw = process.env.REQUEST_TIMEOUT_MS?.trim() || "300000";
  const requestTimeoutMs = Number(requestTimeoutMsRaw);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000) {
    throw new Error(`Invalid REQUEST_TIMEOUT_MS: ${requestTimeoutMsRaw}`);
  }

  // Rate limiting configuration
  const rateLimitMaxRaw = process.env.RATE_LIMIT_MAX?.trim() || "100";
  const rateLimitMax = Number(rateLimitMaxRaw);
  if (!Number.isInteger(rateLimitMax) || rateLimitMax < 1) {
    throw new Error(`Invalid RATE_LIMIT_MAX: ${rateLimitMaxRaw}`);
  }

  const rateLimitWindowMsRaw = process.env.RATE_LIMIT_WINDOW_MS?.trim() || "60000";
  const rateLimitWindowMs = Number(rateLimitWindowMsRaw);
  if (!Number.isInteger(rateLimitWindowMs) || rateLimitWindowMs < 1000) {
    throw new Error(`Invalid RATE_LIMIT_WINDOW_MS: ${rateLimitWindowMsRaw}`);
  }

  // Request body size limit (default: 10MB)
  const maxRequestBodySizeRaw = process.env.MAX_REQUEST_BODY_SIZE?.trim() || "10485760";
  const maxRequestBodySize = Number(maxRequestBodySizeRaw);
  if (!Number.isInteger(maxRequestBodySize) || maxRequestBodySize < 1024) {
    throw new Error(`Invalid MAX_REQUEST_BODY_SIZE: ${maxRequestBodySizeRaw}`);
  }

  const defaultReasoningEffortRaw = process.env.OPENAI_REASONING_EFFORT?.trim();
  const defaultReasoningEffort = defaultReasoningEffortRaw
    ? parseReasoningEffort(defaultReasoningEffortRaw)
    : undefined;
  if (defaultReasoningEffortRaw && !defaultReasoningEffort) {
    const allowed = reasoningEffortSchema.options.join(", ");
    throw new Error(
      `Invalid OPENAI_REASONING_EFFORT: ${defaultReasoningEffortRaw}. Expected one of: ${allowed}`,
    );
  }

  const frontendAllowedCwds = parseFrontendAllowedCwds();
  const autoRouterBenchmarkOnStart = parseBooleanEnv("AUTO_ROUTER_BENCHMARK_ON_START", true);
  const autoRouterBenchmarkTimeoutMs = parseIntegerEnv(
    "AUTO_ROUTER_BENCHMARK_TIMEOUT_MS",
    20000,
    1000,
  );
  const remoteCliTargetsPathRaw = process.env.REMOTE_CLI_TARGETS_CONFIG_PATH?.trim();
  const remoteCliTargetsPath = remoteCliTargetsPathRaw
    ? path.resolve(process.cwd(), remoteCliTargetsPathRaw)
    : undefined;
  const autoRouterBenchmarkMaxModels = parseIntegerEnv(
    "AUTO_ROUTER_BENCHMARK_MAX_MODELS",
    16,
    0,
  );
  const autoRouterBenchmarkConcurrency = parseIntegerEnv(
    "AUTO_ROUTER_BENCHMARK_CONCURRENCY",
    2,
    1,
  );
  const autoRouterBenchmarkIntervalMs = parseIntegerEnv(
    "AUTO_ROUTER_BENCHMARK_INTERVAL_MS",
    28_800_000,
    0,
  );
  const autoRouterBenchmarkEvaluateQuality = parseBooleanEnv(
    "AUTO_ROUTER_BENCHMARK_EVALUATE_QUALITY",
    true,
  );
  const autoRouterBenchmarkEvaluatorModel =
    process.env.AUTO_ROUTER_BENCHMARK_EVALUATOR_MODEL?.trim() || undefined;
  const autoRouterBenchmarkQualityTimeoutMs = parseIntegerEnv(
    "AUTO_ROUTER_BENCHMARK_QUALITY_TIMEOUT_MS",
    15_000,
    1_000,
  );

  return {
    host,
    port,
    providersPath,
    remoteCliTargetsPath,
    n8nApiKeys: parseApiKeys(),
    adminApiKey,
    frontendApiKeys: parseFrontendApiKeys(),
    frontendAllowedCwds,
    codexAgentAllowedWorkspaceRoots: parseCodexAgentAllowedWorkspaceRoots(frontendAllowedCwds),
    remoteCliToolAuthScopes: parseRemoteCliToolAuthScopes(),
    logLevel,
    maxJobLogLines,
    shutdownTimeoutMs,
    requestTimeoutMs,
    rateLimitMax,
    rateLimitWindowMs,
    maxRequestBodySize,
    embeddings: loadEmbeddingsConfig(),
    defaultReasoningEffort,
    autoRouterBenchmarkOnStart,
    autoRouterBenchmarkTimeoutMs,
    autoRouterBenchmarkMaxModels,
    autoRouterBenchmarkConcurrency,
    autoRouterBenchmarkIntervalMs,
    autoRouterBenchmarkEvaluateQuality,
    autoRouterBenchmarkEvaluatorModel,
    autoRouterBenchmarkQualityTimeoutMs,
  };
}

export function loadProvidersFile(providersPath: string): ProvidersFile {
  let raw = "";
  try {
    raw = readFileSync(providersPath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read providers config at ${providersPath}. Copy config/providers.example.yaml to this path and edit it.`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    const details = describeYamlError(error, raw);
    throw new Error(`Invalid YAML in ${providersPath}.${details ? ` ${details}` : ""}`, {
      cause: error,
    });
  }

  const profiles = loadProviderProfiles();
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { providers?: unknown }).providers)) {
    const document = parsed as { providers: Array<Record<string, unknown>> };
    document.providers = document.providers.map(provider => {
      if (!provider.profile) return provider;
      const profile = profiles.get(String(provider.profile));
      if (!profile) throw Error("Unknown provider profile: " + String(provider.profile));
      if (provider.type !== profile.type) throw Error("Provider profile type mismatch: " + profile.id);
      return profile.type === "cli"
        ? { responseCommand: { ...profile.command, timeoutMs: profile.quirks.timeouts.total },
            ...(profile.auth.statusCommand ? { auth: { statusCommand: profile.auth.statusCommand } } : {}), ...provider }
        : { baseUrl: profile.baseUrl, ...(provider.credentialBroker ? {} : { apiKeyEnv: profile.auth.env }), timeoutMs: profile.quirks.timeouts.total, ...provider };
    });
  }
  const config = providersFileSchema.parse(parsed);
  for (const provider of config.providers) {
    if (provider.type === 'openai' && Boolean(provider.apiKeyEnv) === Boolean(provider.credentialBroker)) throw Error('Choose exactly one provider credential source: apiKeyEnv or credentialBroker.');
  }
  for (const provider of config.providers) resolveProviderProfile(provider, profiles);
  config.remoteCliTargets = overrideRemoteTargetHosts(config.remoteCliTargets);
  return config;
}

export function loadRemoteCliTargetsFile(targetsPath: string): ProvidersFile["remoteCliTargets"] {
  if (!existsSync(targetsPath)) {
    return undefined;
  }

  let raw = "";
  try {
    raw = readFileSync(targetsPath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read remote CLI targets config at ${targetsPath}.`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    const details = describeYamlError(error, raw);
    throw new Error(`Invalid YAML in ${targetsPath}.${details ? ` ${details}` : ""}`, {
      cause: error,
    });
  }

  return overrideRemoteTargetHosts(remoteCliTargetsFileSchema.parse(parsed).remoteCliTargets);
}

function describeYamlError(error: unknown, source: string): string {
  if (!error || typeof error !== "object") {
    return "";
  }

  const record = error as Record<string, unknown>;
  const message =
    typeof record.message === "string" && record.message.trim()
      ? record.message.trim()
      : "";

  const linePos = Array.isArray(record.linePos) ? record.linePos : [];
  const firstLinePos =
    linePos.length > 0 && linePos[0] && typeof linePos[0] === "object"
      ? (linePos[0] as Record<string, unknown>)
      : null;
  const line =
    firstLinePos && typeof firstLinePos.line === "number" ? firstLinePos.line : undefined;
  const col =
    firstLinePos && typeof firstLinePos.col === "number" ? firstLinePos.col : undefined;

  if (line && col) {
    const excerpt = buildYamlExcerpt(source, line, 2);
    return `${message} at line ${line}, column ${col}.${excerpt ? `\n${excerpt}` : ""}`;
  }

  return message;
}

function buildYamlExcerpt(source: string, line: number, radius: number): string {
  const lines = source.split(/\r?\n/);
  const start = Math.max(1, line - radius);
  const end = Math.min(lines.length, line + radius);
  const excerpt: string[] = [];

  for (let i = start; i <= end; i += 1) {
    const prefix = i === line ? ">" : " ";
    excerpt.push(`${prefix} ${String(i).padStart(4, " ")} | ${lines[i - 1] ?? ""}`);
  }

  return excerpt.join("\n");
}

function overrideRemoteTargetHosts<T extends { targetId: string; host: string }>(targets: T[]): T[] {
  return targets.map((target) => {
    const key = `REMOTE_TARGET_HOST_${target.targetId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    const value = process.env[key];
    if (value === undefined) return target;
    const host = value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host)) {
      throw new Error(`Invalid ${key}: expected a non-empty SSH host, without user, port suffix, or options.`);
    }
    return { ...target, host };
  });
}
