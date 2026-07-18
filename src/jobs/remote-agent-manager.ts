import type {
  ProviderSessionEvent,
  RemoteAgentTaskSummary,
  RemoteCliTargetConfig,
} from "../types";
import type { Provider } from "../providers/provider";
import type { RemoteAgentHandoff } from "../validation";
import { makeId } from "../utils/ids";
import { ProviderSessionManager } from "./provider-session-manager";
import {
  AgentHandoffStore,
  buildHandoffPrompt,
  redactAgentHandoff,
  type AgentHandoffAcknowledgement,
  type GatewayVerifiedResultFiles,
} from "./agent-handoff-store";

const DEFAULT_HANDOFF_CLAIM_TTL_MS = 15 * 60 * 1000;
const DEFAULT_RESULT_CACHE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_TASK_LIFETIME_TTL_MS = 4 * 60 * 60 * 1000;

interface RemoteAgentTaskRecord {
  summary: RemoteAgentTaskSummary;
  target: RemoteCliTargetConfig;
  handoff?: RemoteAgentHandoff;
  handoffAcknowledgement?: AgentHandoffAcknowledgement;
  resultFiles?: GatewayVerifiedResultFiles;
  resultCollection?: Promise<GatewayVerifiedResultFiles>;
  hardExpiryTimer?: ReturnType<typeof setTimeout>;
  retentionTimer?: ReturnType<typeof setTimeout>;
  unsubscribeSession?: () => void;
  terminalObserved?: boolean;
}

export interface CreateRemoteAgentTaskOptions {
  provider: Provider;
  targetId: string;
  task: string;
  sessionId?: string;
  cwd?: string;
  model?: string;
  cols: number;
  rows: number;
  allowAnyProviderCwd?: boolean;
  handoff?: RemoteAgentHandoff;
}

export class RemoteAgentManager {
  private readonly targets = new Map<string, RemoteCliTargetConfig>();
  private readonly tasks = new Map<string, RemoteAgentTaskRecord>();
  private readonly sessionManager: ProviderSessionManager;
  private readonly handoffStore: AgentHandoffStore;
  private readonly handoffClaimTtlMs: number;
  private readonly resultCacheTtlMs: number;
  private readonly taskLifetimeTtlMs: number;
  private closed = false;

  constructor(
    sessionManager: ProviderSessionManager,
    targets: RemoteCliTargetConfig[] = [],
    options: {
      handoffStore?: AgentHandoffStore;
      handoffClaimTtlMs?: number;
      resultCacheTtlMs?: number;
      taskLifetimeTtlMs?: number;
    } = {},
  ) {
    for (const target of targets) {
      this.targets.set(target.targetId, target);
    }
    this.sessionManager = sessionManager;
    this.handoffStore = options.handoffStore ?? new AgentHandoffStore();
    this.handoffClaimTtlMs = positiveNumber(options.handoffClaimTtlMs) ?? DEFAULT_HANDOFF_CLAIM_TTL_MS;
    this.resultCacheTtlMs = positiveNumber(options.resultCacheTtlMs) ?? DEFAULT_RESULT_CACHE_TTL_MS;
    this.taskLifetimeTtlMs = positiveNumber(options.taskLifetimeTtlMs) ?? DEFAULT_TASK_LIFETIME_TTL_MS;
  }

  listTargets(): RemoteCliTargetConfig[] {
    return [...this.targets.values()].map((target) => ({
      ...target,
      allowedCwds: [...target.allowedCwds],
    }));
  }

  listTasks(limit = 50): RemoteAgentTaskSummary[] {
    const tasks = [...this.tasks.values()].map((record) => this.refreshSummary(record));
    tasks.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return tasks.slice(0, Math.max(1, limit));
  }

  getTask(taskId: string): RemoteAgentTaskSummary | undefined {
    const record = this.tasks.get(taskId);
    return record ? this.refreshSummary(record) : undefined;
  }

  getTranscript(taskId: string, afterCursor = 0): ProviderSessionEvent[] | undefined {
    const record = this.tasks.get(taskId);
    if (!record) {
      return undefined;
    }
    return this.sessionManager.getTranscript(record.summary.sessionId, afterCursor);
  }

  getHandoffAcknowledgement(taskId: string): AgentHandoffAcknowledgement | undefined {
    const acknowledgement = this.tasks.get(taskId)?.handoffAcknowledgement;
    return acknowledgement ? { ...acknowledgement } : undefined;
  }

  async getResultFiles(taskId: string): Promise<GatewayVerifiedResultFiles> {
    const record = this.requireTask(taskId);
    const summary = this.refreshSummary(record);
    if (!isFinalStatus(summary.status)) {
      throw new Error(`Remote agent task is not terminal: ${taskId}`);
    }
    this.observeTerminal(record);
    if (!record.resultFiles && !record.handoff?.output.enabled) {
      throw new Error(`Remote agent task did not request result files: ${taskId}`);
    }
    if (!record.resultFiles) {
      const handoff = record.handoff;
      if (!handoff) {
        throw new Error(`Remote agent task did not request result files: ${taskId}`);
      }
      this.clearRetentionTimer(record);
      if (!record.resultCollection) {
        record.resultCollection = this.handoffStore.collectRemote(
          record.target,
          record.summary.cwd,
          handoff,
        ).then((result) => {
          if (this.tasks.get(taskId) === record) {
            record.resultFiles = result;
          }
          return result;
        }).finally(() => {
          record.handoff = undefined;
          record.resultCollection = undefined;
          if (this.tasks.get(taskId) === record) {
            this.armResultCacheEviction(record);
          }
        });
      }
      await record.resultCollection;
    }
    if (!record.resultFiles) {
      throw new Error(`Remote agent result files are no longer retained: ${taskId}`);
    }
    return {
      ...record.resultFiles,
      files: record.resultFiles.files.map((file) => ({ ...file })),
    };
  }

  subscribe(
    taskId: string,
    listener: (event: ProviderSessionEvent) => void,
    options: { afterCursor?: number; follow?: boolean } = {},
  ): (() => void) | null {
    const record = this.tasks.get(taskId);
    if (!record) {
      return null;
    }
    return this.sessionManager.subscribe(record.summary.sessionId, listener, options);
  }

  async createTask(options: CreateRemoteAgentTaskOptions): Promise<RemoteAgentTaskSummary> {
    if (this.closed) {
      throw new Error("Remote agent manager is closed.");
    }
    const target = this.requireTarget(options.targetId);
    if (!options.task.trim()) {
      throw new Error("task is required.");
    }

    const cwd = resolveRemoteCwd(options.cwd ?? target.defaultCwd, target);
    const reasoning = buildRemoteAgentReasoning(options.provider, target, cwd);
    let handoffStaged = false;
    let handoffAcknowledgement: AgentHandoffAcknowledgement | undefined;
    let session: Awaited<ReturnType<ProviderSessionManager["createSession"]>> | undefined;
    let taskId = "";
    let record: RemoteAgentTaskRecord | undefined;
    try {
      if (options.handoff) {
        handoffAcknowledgement = await this.handoffStore.stageRemote(target, cwd, options.handoff);
        handoffStaged = true;
      }
      session = await this.sessionManager.createSession({
        provider: options.provider,
        mode: "interactive",
        model: options.model,
        continuationSessionId: options.sessionId,
        cols: options.cols,
        rows: options.rows,
        allowAnyCwd: options.allowAnyProviderCwd === true,
      });
      const now = new Date().toISOString();
      const summary: RemoteAgentTaskSummary = {
        id: makeId("ragent"),
        providerId: options.provider.id,
        providerDescription: options.provider.description,
        targetId: target.targetId,
        targetDescription: target.description,
        host: target.host,
        user: target.user,
        port: target.port,
        cwd,
        model: options.model,
        task: options.task,
        status: session.status,
        createdAt: now,
        updatedAt: now,
        sessionId: session.id,
        streamToken: session.streamToken,
        reasoning,
      };

      record = {
        summary,
        target,
        handoff: options.handoff,
        handoffAcknowledgement,
      };
      taskId = summary.id;
      this.tasks.set(taskId, record);
      this.armHardExpiry(record);
      const createdRecord = record;
      record.unsubscribeSession = this.sessionManager.subscribe(
        session.id,
        (event) => this.observeSessionEvent(createdRecord, event),
        { afterCursor: 0, follow: true },
      ) ?? undefined;
      this.sessionManager.emitReasoning(session.id, reasoning.summary, {
        ...reasoning.data,
        taskId,
      });
      this.sessionManager.writeInput(session.id, buildBootstrapPrompt(summary, options.handoff));
      if (record.handoff) {
        record.handoff = redactAgentHandoff(record.handoff);
      }
      return this.refreshSummary(record);
    } catch (error) {
      if (record) {
        this.clearRecordTimers(record);
        record.unsubscribeSession?.();
        record.unsubscribeSession = undefined;
      }
      if (taskId) {
        this.tasks.delete(taskId);
      }
      if (session) {
        try {
          this.sessionManager.terminateSession(session.id);
        } catch {
          // The session may already have exited while the bootstrap prompt was being written.
        }
      }
      if (handoffStaged && options.handoff) {
        await this.handoffStore.cleanupRemote(target, cwd, options.handoff).catch(() => undefined);
      }
      throw error;
    }
  }

  async cancelTask(taskId: string): Promise<RemoteAgentTaskSummary> {
    const record = this.requireTask(taskId);
    this.sessionManager.terminateSession(record.summary.sessionId);
    if (record.handoff) {
      try {
        await this.handoffStore.cleanupRemote(record.target, record.summary.cwd, record.handoff);
      } finally {
        record.handoff = undefined;
      }
    }
    const summary = this.refreshSummary(record);
    this.observeTerminal(record);
    return summary;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const record of this.tasks.values()) {
      this.clearRecordTimers(record);
      record.unsubscribeSession?.();
      record.unsubscribeSession = undefined;
      try {
        this.sessionManager.terminateSession(record.summary.sessionId);
      } catch {
        // The provider session may already be terminal.
      }
      if (record.handoff && !record.resultFiles) {
        await this.handoffStore.cleanupRemote(record.target, record.summary.cwd, record.handoff).catch(() => undefined);
        record.handoff = undefined;
      }
      record.resultFiles = undefined;
      record.resultCollection = undefined;
    }
    this.tasks.clear();
  }

  private observeSessionEvent(record: RemoteAgentTaskRecord, event: ProviderSessionEvent): void {
    if (this.tasks.get(record.summary.id) !== record) {
      return;
    }
    const summary = this.refreshSummary(record);
    if (event.type === "status" && isFinalStatus(event.status)) {
      record.summary.status = event.status;
      record.summary.updatedAt = event.ts;
      this.observeTerminal(record);
      return;
    }
    if (event.type === "exit") {
      if (!isFinalStatus(summary.status)) {
        record.summary.status = event.exitCode === 0 ? "completed" : "failed";
        record.summary.updatedAt = event.ts;
      }
      this.observeTerminal(record);
    }
  }

  private observeTerminal(record: RemoteAgentTaskRecord): void {
    if (record.terminalObserved || !isFinalStatus(record.summary.status)) {
      return;
    }
    record.terminalObserved = true;
    this.clearHardExpiryTimer(record);
    record.unsubscribeSession?.();
    record.unsubscribeSession = undefined;
    this.armTerminalEviction(record);
  }

  private armHardExpiry(record: RemoteAgentTaskRecord): void {
    this.clearHardExpiryTimer(record);
    record.hardExpiryTimer = setTimeout(() => {
      if (this.tasks.get(record.summary.id) !== record || record.terminalObserved) {
        return;
      }
      try {
        const session = this.sessionManager.terminateSession(record.summary.sessionId);
        record.summary.status = isFinalStatus(session.status) ? session.status : "timed_out";
        record.summary.updatedAt = session.lastActivityAt;
      } catch {
        record.summary.status = "timed_out";
        record.summary.updatedAt = new Date().toISOString();
      }
      this.observeTerminal(record);
    }, this.taskLifetimeTtlMs);
    record.hardExpiryTimer.unref();
  }

  private armTerminalEviction(record: RemoteAgentTaskRecord): void {
    this.armRetentionTimer(record, this.handoffClaimTtlMs);
  }

  private armResultCacheEviction(record: RemoteAgentTaskRecord): void {
    this.armRetentionTimer(record, this.resultCacheTtlMs);
  }

  private armRetentionTimer(record: RemoteAgentTaskRecord, ttlMs: number): void {
    if (this.closed || this.tasks.get(record.summary.id) !== record) {
      return;
    }
    this.clearRetentionTimer(record);
    record.retentionTimer = setTimeout(() => {
      void this.evictTask(record);
    }, ttlMs);
    record.retentionTimer.unref();
  }

  private clearHardExpiryTimer(record: RemoteAgentTaskRecord): void {
    if (record.hardExpiryTimer) {
      clearTimeout(record.hardExpiryTimer);
      record.hardExpiryTimer = undefined;
    }
  }

  private clearRetentionTimer(record: RemoteAgentTaskRecord): void {
    if (record.retentionTimer) {
      clearTimeout(record.retentionTimer);
      record.retentionTimer = undefined;
    }
  }

  private clearRecordTimers(record: RemoteAgentTaskRecord): void {
    this.clearHardExpiryTimer(record);
    this.clearRetentionTimer(record);
  }

  private async evictTask(record: RemoteAgentTaskRecord): Promise<void> {
    if (this.tasks.get(record.summary.id) !== record) {
      return;
    }
    this.clearRecordTimers(record);
    record.unsubscribeSession?.();
    record.unsubscribeSession = undefined;
    if (record.resultCollection) {
      this.armResultCacheEviction(record);
      return;
    }
    if (record.handoff && !record.resultFiles) {
      await this.handoffStore.cleanupRemote(record.target, record.summary.cwd, record.handoff).catch(() => undefined);
      record.handoff = undefined;
    }
    record.resultFiles = undefined;
    this.tasks.delete(record.summary.id);
  }

  private requireTarget(targetId: string): RemoteCliTargetConfig {
    const target = this.targets.get(targetId);
    if (!target) {
      throw new Error(`Unknown remote agent target: ${targetId}`);
    }
    return target;
  }

  private requireTask(taskId: string): RemoteAgentTaskRecord {
    const record = this.tasks.get(taskId);
    if (!record) {
      throw new Error(`Unknown remote agent task: ${taskId}`);
    }
    return record;
  }

  private refreshSummary(record: RemoteAgentTaskRecord): RemoteAgentTaskSummary {
    const session = this.sessionManager.getSession(record.summary.sessionId);
    if (session) {
      record.summary.status = session.status;
      record.summary.updatedAt = session.lastActivityAt;
    }
    if (isFinalStatus(record.summary.status)) {
      this.observeTerminal(record);
    }
    return {
      ...record.summary,
      reasoning: {
        summary: record.summary.reasoning.summary,
        data: { ...record.summary.reasoning.data },
      },
    };
  }
}

function buildRemoteAgentReasoning(
  provider: Provider,
  target: RemoteCliTargetConfig,
  cwd: string,
): RemoteAgentTaskSummary["reasoning"] {
  const destination = target.user ? `${target.user}@${target.host}` : target.host;
  const sshCommand = target.port
    ? `ssh -p ${target.port} ${destination}`
    : `ssh ${destination}`;
  return {
    summary: `Remote agent task started with provider ${provider.id} on target ${target.targetId}.`,
    data: {
      providerId: provider.id,
      targetId: target.targetId,
      targetDescription: target.description,
      host: target.host,
      user: target.user,
      port: target.port,
      cwd,
      sshCommand,
      allowedCwds: [...target.allowedCwds],
      remoteExecutable: target.opencodeExecutable,
      progressMarkers: [
        "REMOTE_AGENT_PLAN",
        "REMOTE_AGENT_PROGRESS",
        "REMOTE_AGENT_RESULT",
      ],
    },
  };
}

function buildBootstrapPrompt(summary: RemoteAgentTaskSummary, handoff?: RemoteAgentHandoff): string {
  const destination = summary.user ? `${summary.user}@${summary.host}` : summary.host;
  const sshCommand = summary.port
    ? `ssh -p ${summary.port} ${destination}`
    : `ssh ${destination}`;
  const allowedCwds = Array.isArray(summary.reasoning.data.allowedCwds)
    ? summary.reasoning.data.allowedCwds.join(", ")
    : summary.cwd;
  const remoteExecutable = typeof summary.reasoning.data.remoteExecutable === "string"
    ? summary.reasoning.data.remoteExecutable
    : "opencode";
  const targetMarker = JSON.stringify({
    host: summary.host,
    user: summary.user,
    port: summary.port,
    cwd: summary.cwd,
    executable: remoteExecutable,
  });

  return [
    "You are being run by the n8n OpenAI CLI Gateway remote-agent service.",
    "",
    "Use the configured remote target for this task:",
    `- targetId: ${summary.targetId}`,
    `- ssh: ${sshCommand}`,
    `- remote cwd: ${summary.cwd}`,
    `- allowed remote roots: ${allowedCwds}`,
    `REMOTE_AGENT_TARGET_JSON=${targetMarker}`,
    "",
    "Operational rules:",
    "- Work through SSH on the configured target; do not request secrets from the user.",
    "- Keep remote file and Kubernetes changes scoped to the requested task.",
    "- Verify changes before reporting completion.",
    "- Emit concise progress markers so the chat session can track state:",
    "  REMOTE_AGENT_PLAN: <one sentence>",
    "  REMOTE_AGENT_PROGRESS: <one sentence>",
    "  REMOTE_AGENT_RESULT: <success|failed> <one sentence>",
    handoff ? buildHandoffPrompt(handoff) : "",
    "",
    "Task:",
    summary.task.trim(),
    "",
  ].join("\n");
}

function resolveRemoteCwd(requestedCwd: string | undefined, target: RemoteCliTargetConfig): string {
  if (!requestedCwd) {
    throw new Error(`Remote agent target ${target.targetId} requires cwd or defaultCwd.`);
  }
  const cwd = normalizeRemotePath(requestedCwd);
  const allowed = target.allowedCwds.map(normalizeRemotePath);
  if (!allowed.some((root) => isWithinRemoteRoot(cwd, root))) {
    throw new Error(`Requested cwd is outside target ${target.targetId} allowed roots: ${cwd}`);
  }
  return cwd;
}

function normalizeRemotePath(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/");
  if (!trimmed.startsWith("/")) {
    throw new Error(`Remote cwd must be an absolute POSIX path: ${value}`);
  }
  const parts: string[] = [];
  for (const part of trimmed.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function isWithinRemoteRoot(cwd: string, root: string): boolean {
  return cwd === root || cwd.startsWith(`${root}/`);
}

function isFinalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "terminated" || status === "timed_out";
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
