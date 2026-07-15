import type {
  ProviderSessionEvent,
  RemoteAgentTaskSummary,
  RemoteCliTargetConfig,
} from "../types";
import type { Provider } from "../providers/provider";
import { makeId } from "../utils/ids";
import { ProviderSessionManager } from "./provider-session-manager";

interface RemoteAgentTaskRecord {
  summary: RemoteAgentTaskSummary;
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
}

export class RemoteAgentManager {
  private readonly targets = new Map<string, RemoteCliTargetConfig>();
  private readonly tasks = new Map<string, RemoteAgentTaskRecord>();
  private readonly sessionManager: ProviderSessionManager;

  constructor(
    sessionManager: ProviderSessionManager,
    targets: RemoteCliTargetConfig[] = [],
  ) {
    for (const target of targets) {
      this.targets.set(target.targetId, target);
    }
    this.sessionManager = sessionManager;
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
    const target = this.requireTarget(options.targetId);
    if (!options.task.trim()) {
      throw new Error("task is required.");
    }

    const cwd = resolveRemoteCwd(options.cwd ?? target.defaultCwd, target);
    const reasoning = buildRemoteAgentReasoning(options.provider, target, cwd);
    const session = await this.sessionManager.createSession({
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

    const record: RemoteAgentTaskRecord = { summary };
    this.tasks.set(summary.id, record);
    this.sessionManager.emitReasoning(session.id, reasoning.summary, {
      ...reasoning.data,
      taskId: summary.id,
    });
    this.sessionManager.writeInput(session.id, buildBootstrapPrompt(summary));
    return this.refreshSummary(record);
  }

  cancelTask(taskId: string): RemoteAgentTaskSummary {
    const record = this.requireTask(taskId);
    this.sessionManager.terminateSession(record.summary.sessionId);
    return this.refreshSummary(record);
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
      progressMarkers: [
        "REMOTE_AGENT_PLAN",
        "REMOTE_AGENT_PROGRESS",
        "REMOTE_AGENT_RESULT",
      ],
    },
  };
}

function buildBootstrapPrompt(summary: RemoteAgentTaskSummary): string {
  const destination = summary.user ? `${summary.user}@${summary.host}` : summary.host;
  const sshCommand = summary.port
    ? `ssh -p ${summary.port} ${destination}`
    : `ssh ${destination}`;
  const allowedCwds = Array.isArray(summary.reasoning.data.allowedCwds)
    ? summary.reasoning.data.allowedCwds.join(", ")
    : summary.cwd;

  return [
    "You are being run by the n8n OpenAI CLI Gateway remote-agent service.",
    "",
    "Use the configured remote target for this task:",
    `- targetId: ${summary.targetId}`,
    `- ssh: ${sshCommand}`,
    `- remote cwd: ${summary.cwd}`,
    `- allowed remote roots: ${allowedCwds}`,
    "",
    "Operational rules:",
    "- Work through SSH on the configured target; do not request secrets from the user.",
    "- Keep remote file and Kubernetes changes scoped to the requested task.",
    "- Verify changes before reporting completion.",
    "- Emit concise progress markers so the chat session can track state:",
    "  REMOTE_AGENT_PLAN: <one sentence>",
    "  REMOTE_AGENT_PROGRESS: <one sentence>",
    "  REMOTE_AGENT_RESULT: <success|failed> <one sentence>",
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
