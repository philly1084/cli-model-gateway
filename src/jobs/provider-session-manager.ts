import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import type {
  CliProviderConfig,
  CommandSpec,
  ProviderSessionCapability,
  ProviderSessionEvent,
  ProviderSessionMode,
  ProviderSessionStatus,
  ProviderSessionSummary,
  SessionCommandConfig,
  SessionPtyMode,
} from "../types";
import type { Provider } from "../providers/provider";
import { resolveCommand } from "../utils/command";
import { makeId } from "../utils/ids";
import { withRuntimeTemplateVars } from "../utils/runtime-template-vars";
import { shellEscape } from "../utils/shell";

const DEFAULT_TRANSCRIPT_MAX_BYTES = 256 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_LIFETIME_MS = 4 * 60 * 60 * 1000;
const DEFAULT_TERM = "xterm-256color";

let cachedScriptBinary: string | null | undefined;

interface ProviderSessionRecord {
  summary: ProviderSessionSummary;
  child: ChildProcessWithoutNullStreams;
  subscribers: Map<string, (event: ProviderSessionEvent) => void>;
  events: ProviderSessionEvent[];
  eventSizes: number[];
  transcriptBytes: number;
  idleTimeoutMs: number;
  maxLifetimeMs: number;
  closeInputAfterWrite: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  lifetimeTimer?: ReturnType<typeof setTimeout>;
}

export interface CreateProviderSessionOptions {
  provider: Provider;
  mode: ProviderSessionMode;
  model?: string;
  continuationSessionId?: string;
  cwd?: string;
  cols: number;
  rows: number;
  allowAnyCwd?: boolean;
}

export class ProviderSessionManager {
  private readonly sessions = new Map<string, ProviderSessionRecord>();
  private readonly allowedCwds: string[];
  private readonly maxTranscriptBytes: number;

  constructor(options: { allowedCwds?: string[]; maxTranscriptBytes?: number } = {}) {
    this.allowedCwds = (options.allowedCwds ?? []).map((value) => normalizePath(value));
    this.maxTranscriptBytes = options.maxTranscriptBytes ?? DEFAULT_TRANSCRIPT_MAX_BYTES;
  }

  static describeProviderCapabilities(provider: Provider): ProviderSessionCapability {
    if (provider.config.type !== "cli" || !provider.config.sessionCommand) {
      return {
        providerId: provider.id,
        providerDescription: provider.description,
        providerType: provider.config.type,
        supportsSessions: false,
        supportsLoginSessions: false,
        supportsModelSelection: false,
        supportsWorkingDirectory: false,
        models: provider.models,
      };
    }

    const session = provider.config.sessionCommand;
    return {
      providerId: provider.id,
      providerDescription: provider.description,
      providerType: provider.config.type,
      supportsSessions: true,
      supportsLoginSessions: true,
      supportsModelSelection: session.supportsModelSelection === true,
      supportsWorkingDirectory: session.supportsWorkingDirectory === true,
      ptyMode: session.ptyMode ?? "auto",
      models: provider.models,
    };
  }

  listCapabilities(providers: Provider[]): ProviderSessionCapability[] {
    return providers.map((provider) => ProviderSessionManager.describeProviderCapabilities(provider));
  }

  listSessions(limit = 50): ProviderSessionSummary[] {
    const sessions = [...this.sessions.values()].map((record) => ({
      ...record.summary,
    }));
    sessions.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return sessions.slice(0, Math.max(1, limit));
  }

  getSession(sessionId: string): ProviderSessionSummary | undefined {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return undefined;
    }
    return { ...record.summary };
  }

  getTranscript(sessionId: string, afterCursor = 0): ProviderSessionEvent[] | undefined {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return undefined;
    }
    return record.events.filter((event) => event.cursor > afterCursor).map((event) => ({ ...event }));
  }

  subscribe(
    sessionId: string,
    listener: (event: ProviderSessionEvent) => void,
    options: { afterCursor?: number; follow?: boolean } = {},
  ): (() => void) | null {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return null;
    }

    const afterCursor = options.afterCursor ?? 0;
    for (const event of record.events) {
      if (event.cursor > afterCursor) {
        listener({ ...event });
      }
    }

    if (options.follow === false || isFinalStatus(record.summary.status)) {
      return () => undefined;
    }

    const subscriberId = makeId("sub");
    record.subscribers.set(subscriberId, listener);
    return () => {
      record.subscribers.delete(subscriberId);
    };
  }

  async createSession(options: CreateProviderSessionOptions): Promise<ProviderSessionSummary> {
    const sessionConfig = getSessionConfig(options.provider);
    const resolvedLaunch = resolveSessionLaunch(
      options.provider,
      sessionConfig,
      options.mode,
      options.model,
      options.continuationSessionId,
      options.cwd,
      options.cols,
      options.rows,
      options.allowAnyCwd === true,
      this.allowedCwds,
    );
    const supportsResize = false;
    const now = new Date().toISOString();
    const summary: ProviderSessionSummary = {
      id: makeId("ps"),
      providerId: options.provider.id,
      providerDescription: options.provider.description,
      mode: options.mode,
      status: "starting",
      model: resolvedLaunch.modelId,
      cwd: resolvedLaunch.cwd,
      cols: options.cols,
      rows: options.rows,
      createdAt: now,
      startedAt: now,
      lastActivityAt: now,
      supportsResize,
      streamToken: makeId("pst"),
    };

    const child = spawn(resolvedLaunch.command, resolvedLaunch.args, {
      cwd: resolvedLaunch.cwd,
      env: {
        ...process.env,
        ...resolvedLaunch.env,
      },
      shell: false,
      stdio: "pipe",
      windowsHide: true,
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const record: ProviderSessionRecord = {
      summary,
      child,
      subscribers: new Map(),
      events: [],
      eventSizes: [],
      transcriptBytes: 0,
      idleTimeoutMs: sessionConfig.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      maxLifetimeMs: sessionConfig.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS,
      closeInputAfterWrite: sessionConfig.closeInputAfterWrite === true,
    };

    this.sessions.set(summary.id, record);
    this.armIdleTimer(record);
    this.armLifetimeTimer(record);
    this.emitEvent(record, {
      type: "status",
      status: "running",
      message: `Provider session started for ${options.provider.id}.`,
    });

    child.stdout.on("data", (chunk: string) => {
      this.markActivity(record);
      this.emitEvent(record, {
        type: "output",
        data: chunk,
      });
    });

    child.stderr.on("data", (chunk: string) => {
      this.markActivity(record);
      this.emitEvent(record, {
        type: "output",
        data: chunk,
      });
    });

    child.on("error", (error) => {
      this.finalizeRecord(record, "failed", null, `Failed to start provider session: ${error.message}`);
    });

    child.on("close", (exitCode) => {
      const nextStatus = resolveExitStatus(record.summary.status, exitCode);
      this.finalizeRecord(record, nextStatus, exitCode, undefined);
    });

    return { ...summary };
  }

  writeInput(sessionId: string, data: string): ProviderSessionSummary {
    const record = this.requireRecord(sessionId);
    ensureWritableSession(record.summary);
    record.child.stdin.write(data);
    if (record.closeInputAfterWrite) {
      record.child.stdin.end();
    }
    this.markActivity(record);
    return { ...record.summary };
  }

  resizeSession(sessionId: string, cols: number, rows: number): ProviderSessionSummary {
    const record = this.requireRecord(sessionId);
    record.summary.cols = cols;
    record.summary.rows = rows;
    this.markActivity(record);
    return { ...record.summary };
  }

  signalSession(sessionId: string, signal: "SIGINT" | "SIGTERM" | "SIGKILL"): ProviderSessionSummary {
    const record = this.requireRecord(sessionId);
    ensureWritableSession(record.summary);

    if (signal === "SIGINT") {
      record.child.stdin.write("\u0003");
    } else {
      record.child.kill(signal);
    }
    this.markActivity(record);
    return { ...record.summary };
  }

  emitReasoning(sessionId: string, summary: string, data?: Record<string, unknown>): void {
    const record = this.requireRecord(sessionId);
    this.emitEvent(record, {
      type: "reasoning",
      summary,
      data,
    });
  }

  terminateSession(sessionId: string): ProviderSessionSummary {
    const record = this.requireRecord(sessionId);
    if (!isFinalStatus(record.summary.status)) {
      record.summary.status = "terminated";
      record.child.kill("SIGTERM");
      this.markActivity(record);
    }
    return { ...record.summary };
  }

  async close(): Promise<void> {
    for (const record of this.sessions.values()) {
      if (!isFinalStatus(record.summary.status)) {
        record.summary.status = "terminated";
        record.child.kill("SIGTERM");
      }
      this.clearTimers(record);
      record.subscribers.clear();
    }
  }

  private requireRecord(sessionId: string): ProviderSessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error(`Unknown provider session: ${sessionId}`);
    }
    return record;
  }

  private markActivity(record: ProviderSessionRecord): void {
    record.summary.lastActivityAt = new Date().toISOString();
    this.armIdleTimer(record);
  }

  private armIdleTimer(record: ProviderSessionRecord): void {
    if (record.idleTimer) {
      clearTimeout(record.idleTimer);
    }
    record.idleTimer = setTimeout(() => {
      if (!isFinalStatus(record.summary.status)) {
        record.summary.status = "timed_out";
        record.child.kill("SIGTERM");
        this.emitEvent(record, {
          type: "status",
          status: "timed_out",
          message: "Provider session terminated after being idle for too long.",
        });
      }
    }, record.idleTimeoutMs);
    record.idleTimer.unref();
  }

  private armLifetimeTimer(record: ProviderSessionRecord): void {
    if (record.lifetimeTimer) {
      clearTimeout(record.lifetimeTimer);
    }
    record.lifetimeTimer = setTimeout(() => {
      if (!isFinalStatus(record.summary.status)) {
        record.summary.status = "timed_out";
        record.child.kill("SIGTERM");
        this.emitEvent(record, {
          type: "status",
          status: "timed_out",
          message: "Provider session reached its maximum lifetime.",
        });
      }
    }, record.maxLifetimeMs);
    record.lifetimeTimer.unref();
  }

  private finalizeRecord(
    record: ProviderSessionRecord,
    status: ProviderSessionStatus,
    exitCode: number | null,
    message?: string,
  ): void {
    if (isFinalStatus(record.summary.status) && record.summary.finishedAt) {
      return;
    }

    this.clearTimers(record);
    record.summary.status = status;
    record.summary.exitCode = exitCode;
    record.summary.finishedAt = new Date().toISOString();
    record.summary.lastActivityAt = record.summary.finishedAt;
    if (message) {
      this.emitEvent(record, {
        type: "status",
        status,
        message,
      });
    }
    this.emitEvent(record, {
      type: "exit",
      exitCode,
    });
    record.subscribers.clear();
  }

  private clearTimers(record: ProviderSessionRecord): void {
    if (record.idleTimer) {
      clearTimeout(record.idleTimer);
      record.idleTimer = undefined;
    }
    if (record.lifetimeTimer) {
      clearTimeout(record.lifetimeTimer);
      record.lifetimeTimer = undefined;
    }
  }

  private emitEvent(
    record: ProviderSessionRecord,
    event:
      | Omit<Extract<ProviderSessionEvent, { type: "output" }>, "cursor" | "ts">
      | Omit<Extract<ProviderSessionEvent, { type: "reasoning" }>, "cursor" | "ts">
      | Omit<Extract<ProviderSessionEvent, { type: "status" }>, "cursor" | "ts">
      | Omit<Extract<ProviderSessionEvent, { type: "exit" }>, "cursor" | "ts">,
  ): void {
    const nextCursor = record.events.length > 0
      ? (record.events[record.events.length - 1]?.cursor ?? 0) + 1
      : 1;
    const fullEvent = {
      ...event,
      cursor: nextCursor,
      ts: new Date().toISOString(),
    } as ProviderSessionEvent;

    if (fullEvent.type === "status") {
      record.summary.status = fullEvent.status;
    }

    const size = Buffer.byteLength(JSON.stringify(fullEvent), "utf8");
    record.events.push(fullEvent);
    record.eventSizes.push(size);
    record.transcriptBytes += size;
    while (record.transcriptBytes > this.maxTranscriptBytes && record.events.length > 1) {
      const removedSize = record.eventSizes.shift() ?? 0;
      record.events.shift();
      record.transcriptBytes -= removedSize;
    }

    for (const listener of record.subscribers.values()) {
      listener({ ...fullEvent });
    }
  }
}

function getSessionConfig(provider: Provider): SessionCommandConfig {
  if (provider.config.type !== "cli" || !provider.config.sessionCommand) {
    throw new Error(`Provider ${provider.id} does not expose an interactive session command.`);
  }
  return provider.config.sessionCommand;
}

function resolveSessionLaunch(
  provider: Provider,
  sessionConfig: SessionCommandConfig,
  mode: ProviderSessionMode,
  model: string | undefined,
  continuationSessionId: string | undefined,
  requestedCwd: string | undefined,
  cols: number,
  rows: number,
  allowAnyCwd: boolean,
  allowedCwds: string[],
): {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  modelId?: string;
} {
  const modelBinding = model
    ? provider.models.find((entry: CliProviderConfig["models"][number]) => entry.id === model)
    : undefined;
  if (model && !modelBinding) {
    throw new Error(`Provider ${provider.id} does not expose model ${model}.`);
  }
  if (model && sessionConfig.supportsModelSelection !== true) {
    throw new Error(`Provider ${provider.id} does not support session-level model selection.`);
  }

  const cwd = resolveSessionCwd(provider, sessionConfig, requestedCwd, allowAnyCwd, allowedCwds);
  const vars = withRuntimeTemplateVars({
    provider_id: provider.id,
    model: modelBinding?.id ?? "",
    provider_model: modelBinding?.providerModel ?? modelBinding?.id ?? "",
    session_id: continuationSessionId?.trim() ?? "",
    cwd: cwd ?? "",
  });
  const args = [...(mode === "login" && sessionConfig.loginArgs ? sessionConfig.loginArgs : sessionConfig.args ?? [])];
  if (
    modelBinding &&
    sessionConfig.supportsModelSelection === true &&
    sessionConfig.modelFlag &&
    !args.some((arg) => arg.includes("{{model}}") || arg.includes("{{provider_model}}"))
  ) {
    args.push(sessionConfig.modelFlag, modelBinding.providerModel ?? modelBinding.id);
  }

  const commandSpec: CommandSpec = {
    executable: sessionConfig.executable,
    args,
    env: {
      TERM: DEFAULT_TERM,
      COLUMNS: String(cols),
      LINES: String(rows),
      ...(sessionConfig.env ?? {}),
    },
    cwd,
    timeoutMs: 1,
  };
  const resolved = resolveCommand(commandSpec, vars, { escapeShell: false });
  const ptyMode = resolvePtyMode(sessionConfig.ptyMode ?? "auto");
  if (ptyMode === "script") {
    const wrapper = getScriptBinary();
    if (!wrapper) {
      throw new Error("The provider session requested a PTY wrapper, but no 'script' binary is available.");
    }
    const commandString = [resolved.executable, ...resolved.args].map((entry) => shellEscape(entry)).join(" ");
    return {
      command: wrapper,
      args: ["-q", "-f", "-c", commandString, "/dev/null"],
      env: resolved.env ?? {},
      cwd: resolved.cwd,
      modelId: modelBinding?.id,
    };
  }

  return {
    command: resolved.executable,
    args: resolved.args,
    env: resolved.env ?? {},
    cwd: resolved.cwd,
    modelId: modelBinding?.id,
  };
}

function resolveSessionCwd(
  provider: Provider,
  sessionConfig: SessionCommandConfig,
  requestedCwd: string | undefined,
  allowAnyCwd: boolean,
  allowedCwds: string[],
): string | undefined {
  if (!requestedCwd) {
    return sessionConfig.cwd ? normalizePath(sessionConfig.cwd) : undefined;
  }
  if (sessionConfig.supportsWorkingDirectory !== true) {
    throw new Error(`Provider ${provider.id} does not allow overriding the working directory.`);
  }

  const resolved = normalizePath(requestedCwd);
  if (allowAnyCwd) {
    return resolved;
  }
  if (allowedCwds.length === 0) {
    throw new Error("FRONTEND_ALLOWED_CWDS is not configured; frontend sessions cannot override cwd.");
  }
  const isAllowed = allowedCwds.some((root) => isWithinRoot(resolved, root));
  if (!isAllowed) {
    throw new Error(`Requested cwd is outside the configured frontend roots: ${resolved}`);
  }
  return resolved;
}

function resolvePtyMode(configured: SessionPtyMode): SessionPtyMode {
  if (configured === "pipe" || configured === "script") {
    return configured;
  }
  if (process.platform === "win32") {
    return "pipe";
  }
  return getScriptBinary() ? "script" : "pipe";
}

function getScriptBinary(): string | null {
  if (cachedScriptBinary !== undefined) {
    return cachedScriptBinary;
  }

  const candidates = ["/usr/bin/script", "/bin/script"];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      cachedScriptBinary = candidate;
      return candidate;
    } catch {
      continue;
    }
  }

  cachedScriptBinary = null;
  return null;
}

function normalizePath(value: string): string {
  return path.resolve(value);
}

function isWithinRoot(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function ensureWritableSession(summary: ProviderSessionSummary): void {
  if (isFinalStatus(summary.status)) {
    throw new Error(`Provider session ${summary.id} is no longer running.`);
  }
}

function isFinalStatus(status: ProviderSessionStatus): boolean {
  return status === "completed" || status === "failed" || status === "terminated" || status === "timed_out";
}

function resolveExitStatus(
  currentStatus: ProviderSessionStatus,
  exitCode: number | null,
): ProviderSessionStatus {
  if (currentStatus === "terminated" || currentStatus === "timed_out") {
    return currentStatus;
  }
  return exitCode === 0 ? "completed" : "failed";
}
