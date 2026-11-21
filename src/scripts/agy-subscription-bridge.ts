import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import process from "node:process";
import { buildPrompt } from "../utils/prompt.js";
import { resolveReasoningEffort } from "../utils/reasoning.js";

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error";

export interface GatewayRequest {
  prompt?: unknown;
  messages?: unknown;
  reasoningEffort?: unknown;
  metadata?: unknown;
}

export interface JsonContract {
  output_text: string;
  finish_reason: FinishReason;
}

export type AgySubscriptionMode = "http" | "local" | "ssh";

export interface AgySubscriptionConfig {
  enabled: boolean;
  mode: AgySubscriptionMode;
  url?: string;
  token?: string;
  executable: string;
  workdir?: string;
  sshExecutable: string;
  sshHost?: string;
  sshUser?: string;
  sshPort: number;
  printTimeout: string;
}

export interface AgyLaunch {
  executable: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

export interface AgyJsonEnvelope {
  status?: unknown;
  response?: unknown;
  error?: unknown;
  usage?: unknown;
  output_text?: unknown;
  finish_reason?: unknown;
}

const ALLOWED_MODELS = new Set(["gemini-4-neon", "gemini-4-hydrogen"]);
const ALLOWED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const DEFAULT_EXECUTABLE = "agy";
const DEFAULT_PRINT_TIMEOUT = "10m";
const DEFAULT_SSH_PORT = 22;

type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

type FetchFn = typeof fetch;

export function isTruthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function parseBridgeArgs(argv: string[]): { model: string; status: boolean } {
  let model = "";
  let status = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--status") {
      status = true;
    } else if (arg === "--model") {
      model = argv[i + 1] ?? "";
      i += 1;
    }
  }
  return { model: model.trim(), status };
}

export function loadAgySubscriptionConfig(env: NodeJS.ProcessEnv = process.env): AgySubscriptionConfig {
  const modeRaw = (env.AGY_SUBSCRIPTION_MODE ?? "http").trim().toLowerCase();
  if (modeRaw !== "http" && modeRaw !== "local" && modeRaw !== "ssh") {
    throw new Error("AGY_SUBSCRIPTION_MODE must be http, local, or ssh.");
  }
  const portRaw = env.AGY_SUBSCRIPTION_SSH_PORT?.trim();
  const sshPort = portRaw ? Number(portRaw) : DEFAULT_SSH_PORT;
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
    throw new Error("AGY_SUBSCRIPTION_SSH_PORT must be an integer from 1 to 65535.");
  }
  return {
    enabled: isTruthyEnv(env.AGY_SUBSCRIPTION_ENABLED),
    mode: modeRaw,
    url: env.AGY_SUBSCRIPTION_URL?.trim() || undefined,
    token: env.AGY_SUBSCRIPTION_TOKEN?.trim() || undefined,
    executable: env.AGY_SUBSCRIPTION_EXECUTABLE?.trim() || DEFAULT_EXECUTABLE,
    workdir: env.AGY_SUBSCRIPTION_WORKDIR?.trim() || undefined,
    sshExecutable: env.AGY_SUBSCRIPTION_SSH_EXECUTABLE?.trim() || "ssh",
    sshHost: env.AGY_SUBSCRIPTION_SSH_HOST?.trim() || undefined,
    sshUser: env.AGY_SUBSCRIPTION_SSH_USER?.trim() || undefined,
    sshPort,
    printTimeout: env.AGY_SUBSCRIPTION_PRINT_TIMEOUT?.trim() || DEFAULT_PRINT_TIMEOUT,
  };
}

export function assertEnabled(config: AgySubscriptionConfig): void {
  if (!config.enabled) {
    throw new Error("agy-subscription is disabled. Set AGY_SUBSCRIPTION_ENABLED=true to opt in.");
  }
}

export function parseGatewayRequest(input: string): GatewayRequest {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("agy-subscription bridge expected a JSON object on stdin.");
  }
  return parsed as GatewayRequest;
}

export function buildAgyPrompt(request: GatewayRequest): string {
  if (typeof request.prompt === "string" && request.prompt.trim()) {
    return request.prompt.trim();
  }
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const prompt = buildPrompt(messages as never).trim();
  if (!prompt) {
    throw new Error("agy-subscription bridge received an empty prompt.");
  }
  return prompt;
}

export function resolveAgyModel(model: string): string {
  const trimmed = model.trim();
  if (!ALLOWED_MODELS.has(trimmed)) {
    throw new Error(`Unsupported agy-subscription model: ${trimmed || "(empty)"}`);
  }
  return trimmed;
}

export function resolveAgyEffort(request: GatewayRequest): string | undefined {
  const effort = resolveReasoningEffort(request);
  if (!effort) {
    return undefined;
  }
  if (!ALLOWED_EFFORTS.has(effort)) {
    throw new Error(`Unsupported agy-subscription effort: ${effort}`);
  }
  return effort;
}

export function buildAgyArgv(options: {
  model: string;
  prompt: string;
  effort?: string;
  printTimeout?: string;
  settings?: string;
}): string[] {
  const args = [
    "-p",
    options.prompt,
    "--model",
    resolveAgyModel(options.model),
    "--output-format",
    "json",
    "--print-timeout",
    options.printTimeout?.trim() || DEFAULT_PRINT_TIMEOUT,
    "--sandbox",
  ];
  if (options.effort) {
    args.push("--effort", options.effort);
  }
  if (options.settings?.trim()) {
    args.push("--settings", options.settings.trim());
  }
  return args;
}

export function defaultAgySettings(): string {
  return JSON.stringify({
    agentMode: "default",
    permissions: {
      deny: ["command", "write_file"],
    },
  });
}

export function buildLocalLaunch(
  config: AgySubscriptionConfig,
  options: { model: string; prompt: string; effort?: string },
): AgyLaunch {
  return {
    executable: config.executable,
    args: buildAgyArgv({
      model: options.model,
      prompt: options.prompt,
      effort: options.effort,
      printTimeout: config.printTimeout,
      settings: defaultAgySettings(),
    }),
    cwd: config.workdir,
    env: {
      ...process.env,
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    },
  };
}

export function buildSshLaunch(
  config: AgySubscriptionConfig,
  options: { model: string; prompt: string; effort?: string },
): AgyLaunch {
  if (!config.sshHost) {
    throw new Error("AGY_SUBSCRIPTION_SSH_HOST is required for ssh mode.");
  }
  const destination = config.sshUser ? `${config.sshUser}@${config.sshHost}` : config.sshHost;
  const remote = buildLocalLaunch(config, options);
  const remoteCommand = serializeWindowsCommand(remote);
  return {
    executable: config.sshExecutable,
    args: [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-p",
      String(config.sshPort),
      destination,
      remoteCommand,
    ],
    env: { ...process.env },
  };
}

export function serializeWindowsCommand(launch: AgyLaunch): string {
  const parts = [launch.executable, ...launch.args].map(quoteForCmd);
  const prefix = launch.cwd ? `cd /d ${quoteForCmd(launch.cwd)} && ` : "";
  return `${prefix}set AGY_CLI_DISABLE_AUTO_UPDATE=true&& ${parts.join(" ")}`;
}

function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function parseAgyJsonOutput(stdout: string): JsonContract {
  const envelope = extractJsonObject(stdout);
  if (!envelope) {
    throw new Error("agy-subscription received no JSON envelope from agy.");
  }
  const outputText = typeof envelope.output_text === "string" ? envelope.output_text.trim() : "";
  const status = typeof envelope.status === "string" ? envelope.status.trim().toUpperCase() : "";
  const response = typeof envelope.response === "string" ? envelope.response.trim() : "";
  const error = typeof envelope.error === "string" ? envelope.error.trim() : "";
  if (status && status !== "SUCCESS") {
    throw new Error(error || `agy-subscription run ended with status ${status}.`);
  }
  const text = outputText || response;
  if (!text) {
    throw new Error(error || "agy-subscription received an empty model response.");
  }
  return { output_text: text, finish_reason: "stop" };
}

export function extractJsonObject(text: string): AgyJsonEnvelope | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const candidates = [trimmed];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(trimmed.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as AgyJsonEnvelope;
      }
    } catch {
      // Keep scanning for a trailing envelope.
    }
  }
  return undefined;
}

export async function runAgyLaunch(
  launch: AgyLaunch,
  spawnFn: SpawnFn = ((command, args, options) => spawn(command, args, options)) as SpawnFn,
): Promise<string> {
  const child = spawnFn(launch.executable, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(
      [
        `agy-subscription command exited with code ${exitCode}.`,
        stderr.trim() ? `stderr: ${sanitizeDiagnostic(stderr)}` : "",
        stdout.trim() ? `stdout: ${sanitizeDiagnostic(stdout)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return stdout;
}

export function sanitizeDiagnostic(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]")
    .replace(/AGY_SUBSCRIPTION_TOKEN=([^\s]+)/gi, "AGY_SUBSCRIPTION_TOKEN=[redacted]")
    .trim();
}

export async function completeViaHttp(
  config: AgySubscriptionConfig,
  options: { model: string; prompt: string; effort?: string },
  fetchFn: FetchFn = fetch,
): Promise<string> {
  if (!config.url) {
    throw new Error("AGY_SUBSCRIPTION_URL is required for http mode.");
  }
  if (!config.token) {
    throw new Error("AGY_SUBSCRIPTION_TOKEN is required for http mode.");
  }
  const response = await fetchFn(new URL("/v1/complete", config.url).toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      prompt: options.prompt,
      effort: options.effort,
      printTimeout: config.printTimeout,
      workdir: config.workdir,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`agy-subscription worker returned HTTP ${response.status}.`);
  }
  return body;
}

export async function readStatus(
  config: AgySubscriptionConfig,
  fetchFn: FetchFn = fetch,
): Promise<{ ok: boolean; mode: AgySubscriptionMode; error?: string }> {
  if (!config.enabled) {
    return { ok: false, mode: config.mode, error: "AGY_SUBSCRIPTION_ENABLED is not set" };
  }
  if (config.mode === "http") {
    if (!config.url) {
      return { ok: false, mode: config.mode, error: "AGY_SUBSCRIPTION_URL is not set" };
    }
    if (!config.token) {
      return { ok: false, mode: config.mode, error: "AGY_SUBSCRIPTION_TOKEN is not set" };
    }
    try {
      const response = await fetchFn(new URL("/healthz", config.url).toString(), {
        headers: { authorization: `Bearer ${config.token}` },
      });
      if (!response.ok) {
        return { ok: false, mode: config.mode, error: `worker healthz HTTP ${response.status}` };
      }
      return { ok: true, mode: config.mode };
    } catch (error) {
      return {
        ok: false,
        mode: config.mode,
        error: error instanceof Error ? error.message : "worker unreachable",
      };
    }
  }
  if (config.mode === "ssh" && !config.sshHost) {
    return { ok: false, mode: config.mode, error: "AGY_SUBSCRIPTION_SSH_HOST is not set" };
  }
  return { ok: true, mode: config.mode };
}

export async function completeRequest(
  config: AgySubscriptionConfig,
  model: string,
  request: GatewayRequest,
  options: { spawnFn?: SpawnFn; fetchFn?: FetchFn } = {},
): Promise<JsonContract> {
  assertEnabled(config);
  const resolvedModel = resolveAgyModel(model);
  const prompt = buildAgyPrompt(request);
  const effort = resolveAgyEffort(request);
  const raw =
    config.mode === "http"
      ? await completeViaHttp(config, { model: resolvedModel, prompt, effort }, options.fetchFn)
      : await runAgyLaunch(
          config.mode === "ssh"
            ? buildSshLaunch(config, { model: resolvedModel, prompt, effort })
            : buildLocalLaunch(config, { model: resolvedModel, prompt, effort }),
          options.spawnFn,
        );
  return parseAgyJsonOutput(raw);
}

async function readStdin(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const config = loadAgySubscriptionConfig(env);
  const args = parseBridgeArgs(argv);
  if (args.status) {
    const status = await readStatus(config);
    process.stdout.write(`${JSON.stringify(status)}\n`);
    if (!status.ok) {
      process.exitCode = 1;
    }
    return;
  }
  if (!args.model) {
    throw new Error("Missing required --model argument.");
  }
  const request = parseGatewayRequest(await readStdin());
  const contract = await completeRequest(config, args.model, request);
  process.stdout.write(JSON.stringify(contract));
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${sanitizeDiagnostic(message)}\n`);
    process.exitCode = 1;
  });
}
