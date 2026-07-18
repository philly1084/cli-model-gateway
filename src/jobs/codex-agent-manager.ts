import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { makeId } from "../utils/ids";
import { getCodexExecutableCandidates } from "../utils/runtime-template-vars";
import type { RemoteAgentHandoff } from "../validation";
import {
  AgentHandoffStore,
  buildHandoffPrompt,
  redactAgentHandoff,
  type AgentHandoffAcknowledgement,
  type GatewayVerifiedResultFiles,
} from "./agent-handoff-store";

type CodexAgentRunStatus = "starting" | "running" | "completed" | "failed" | "cancelled" | "input_required";

export const DEFAULT_CODEX_AGENT_MODEL = "gpt-5.6-sol";
const DEFAULT_HANDOFF_CLAIM_TTL_MS = 15 * 60 * 1000;
const DEFAULT_RESULT_CACHE_TTL_MS = 2 * 60 * 1000;

export interface CodexAgentRunRequest {
  workspacePath: string;
  issue?: {
    id?: string;
    identifier?: string;
    title?: string;
    description?: string;
    state?: string;
    labels?: string[];
  };
  prompt: string;
  attempt?: unknown;
  continuation?: boolean;
  threadId?: string;
  config?: {
    approvalPolicy?: string;
    threadSandbox?: string;
    turnSandboxPolicy?: unknown;
    turnTimeoutMs?: number;
    stallTimeoutMs?: number;
    model?: string;
    reasoningEffort?: string;
  };
  handoff?: RemoteAgentHandoff;
}

export interface CodexAgentRunSummary {
  runId: string;
  status: CodexAgentRunStatus;
  workspacePath: string;
  issueIdentifier?: string;
  threadId?: string;
  turnId?: string;
  sessionId?: string;
  startedAt: string;
  completedAt: string | null;
  lastEventAt: string;
}

export type CodexAgentEvent = {
  event: string;
  timestamp: string;
  cursor: number;
  [key: string]: unknown;
};

interface JsonRpcRequest {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { message?: unknown };
}

interface CodexAgentRunRecord {
  summary: CodexAgentRunSummary;
  request: CodexAgentRunRequest;
  child?: ChildProcessWithoutNullStreams;
  rpc?: JsonRpcLineClient;
  events: CodexAgentEvent[];
  subscribers: Map<string, (event: CodexAgentEvent) => void>;
  terminal: boolean;
  outputTextParts: string[];
  reasoningParts: string[];
  stderr: string;
  stallTimer?: ReturnType<typeof setTimeout>;
  turnTimer?: ReturnType<typeof setTimeout>;
  handoff?: RemoteAgentHandoff;
  handoffAcknowledgement?: AgentHandoffAcknowledgement;
  resultFiles?: GatewayVerifiedResultFiles;
  resultCollection?: Promise<GatewayVerifiedResultFiles>;
  retentionTimer?: ReturnType<typeof setTimeout>;
}

export class CodexAgentManager {
  private readonly runs = new Map<string, CodexAgentRunRecord>();
  private readonly allowedRoots: string[];
  private readonly codexExecutableCandidates: string[];
  private readonly handoffStore: AgentHandoffStore;
  private readonly handoffClaimTtlMs: number;
  private readonly resultCacheTtlMs: number;
  private closed = false;

  constructor(options: {
    allowedWorkspaceRoots?: string[];
    codexExecutableCandidates?: string[];
    handoffStore?: AgentHandoffStore;
    handoffClaimTtlMs?: number;
    resultCacheTtlMs?: number;
  } = {}) {
    this.allowedRoots = (options.allowedWorkspaceRoots ?? []).map((entry) => normalizePath(entry));
    this.codexExecutableCandidates = options.codexExecutableCandidates ?? getCodexExecutableCandidates();
    this.handoffStore = options.handoffStore ?? new AgentHandoffStore();
    this.handoffClaimTtlMs = positiveNumber(options.handoffClaimTtlMs) ?? DEFAULT_HANDOFF_CLAIM_TTL_MS;
    this.resultCacheTtlMs = positiveNumber(options.resultCacheTtlMs) ?? DEFAULT_RESULT_CACHE_TTL_MS;
  }

  async startRun(request: CodexAgentRunRequest): Promise<CodexAgentRunSummary> {
    if (this.closed) {
      throw new Error("Codex agent manager is closed.");
    }
    const workspacePath = await this.resolveWorkspacePath(request.workspacePath);
    if (!request.prompt.trim()) {
      throw new Error("prompt is required.");
    }

    const now = new Date().toISOString();
    const runId = makeId("run");
    const record: CodexAgentRunRecord = {
      summary: {
        runId,
        status: "starting",
        workspacePath,
        issueIdentifier: request.issue?.identifier,
        threadId: request.threadId,
        startedAt: now,
        completedAt: null,
        lastEventAt: now,
      },
      request: { ...request, workspacePath },
      events: [],
      subscribers: new Map(),
      terminal: false,
      outputTextParts: [],
      reasoningParts: [],
      stderr: "",
      handoff: request.handoff,
    };
    this.runs.set(runId, record);

    let handoffStaged = false;
    try {
      if (record.handoff) {
        record.handoffAcknowledgement = await this.handoffStore.stageLocal(workspacePath, record.handoff);
        handoffStaged = true;
      }
      await this.launchCodex(record);
      if (record.handoff) {
        record.handoff = redactAgentHandoff(record.handoff);
        record.request.handoff = record.handoff;
      }
    } catch (error) {
      if (handoffStaged && record.handoff) {
        await this.handoffStore.cleanupLocal(workspacePath, record.handoff).catch(() => undefined);
      }
      this.runs.delete(runId);
      throw error;
    }
    return { ...record.summary };
  }

  getRun(runId: string): CodexAgentRunSummary | undefined {
    const record = this.runs.get(runId);
    return record ? { ...record.summary } : undefined;
  }

  getEvents(runId: string, afterCursor = 0): CodexAgentEvent[] | undefined {
    const record = this.runs.get(runId);
    if (!record) {
      return undefined;
    }
    return record.events.filter((event) => event.cursor > afterCursor).map((event) => ({ ...event }));
  }

  getHandoffAcknowledgement(runId: string): AgentHandoffAcknowledgement | undefined {
    const acknowledgement = this.runs.get(runId)?.handoffAcknowledgement;
    return acknowledgement ? { ...acknowledgement } : undefined;
  }

  async getResultFiles(runId: string): Promise<GatewayVerifiedResultFiles> {
    const record = this.requireRun(runId);
    if (!record.terminal) {
      throw new Error(`Codex agent run is not terminal: ${runId}`);
    }
    if (!record.resultFiles && !record.handoff?.output.enabled) {
      throw new Error(`Codex agent run did not request result files: ${runId}`);
    }
    if (!record.resultFiles) {
      const handoff = record.handoff;
      if (!handoff) {
        throw new Error(`Codex agent run did not request result files: ${runId}`);
      }
      this.clearRetentionTimer(record);
      if (!record.resultCollection) {
        record.resultCollection = this.handoffStore.collectLocal(record.summary.workspacePath, handoff)
          .then((result) => {
            if (this.runs.get(runId) === record) {
              record.resultFiles = result;
            }
            return result;
          })
          .finally(() => {
            record.handoff = undefined;
            record.request.handoff = undefined;
            record.resultCollection = undefined;
            if (this.runs.get(runId) === record) {
              this.armResultCacheEviction(record);
            }
          });
      }
      await record.resultCollection;
    }
    if (!record.resultFiles) {
      throw new Error(`Codex agent result files are no longer retained: ${runId}`);
    }
    return {
      ...record.resultFiles,
      files: record.resultFiles.files.map((file) => ({ ...file })),
    };
  }

  subscribe(runId: string, listener: (event: CodexAgentEvent) => void): (() => void) | null {
    const record = this.runs.get(runId);
    if (!record || record.terminal) {
      return null;
    }
    const id = makeId("sub");
    record.subscribers.set(id, listener);
    return () => {
      record.subscribers.delete(id);
    };
  }

  async cancelRun(runId: string): Promise<CodexAgentRunSummary> {
    const record = this.requireRun(runId);
    this.finalize(record, "cancelled", {
      event: "turn_cancelled",
      message: "Run cancelled.",
    });
    if (record.handoff) {
      try {
        await this.handoffStore.cleanupLocal(record.summary.workspacePath, record.handoff);
      } finally {
        record.handoff = undefined;
        record.request.handoff = undefined;
      }
    }
    return { ...record.summary };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const record of this.runs.values()) {
      this.clearRetentionTimer(record);
      if (!record.terminal) {
        this.finalize(record, "cancelled", { event: "turn_cancelled", message: "Server shutting down." });
      }
      if (record.handoff && !record.resultFiles) {
        await this.handoffStore.cleanupLocal(record.summary.workspacePath, record.handoff).catch(() => undefined);
        record.handoff = undefined;
        record.request.handoff = undefined;
      }
      record.resultFiles = undefined;
      record.resultCollection = undefined;
      this.clearRetentionTimer(record);
      await this.waitForChildExit(record);
    }
    this.runs.clear();
  }

  private async launchCodex(record: CodexAgentRunRecord): Promise<void> {
    let lastError: unknown;
    for (const executable of this.codexExecutableCandidates) {
      try {
        const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
          cwd: record.summary.workspacePath,
          env: {
            ...process.env,
            ...(record.handoffAcknowledgement ? {
              KIMIBUILT_CONTEXT_MANIFEST: record.handoffAcknowledgement.inputManifestPath,
              ...(record.handoffAcknowledgement.resultManifestPath
                ? { KIMIBUILT_RESULT_MANIFEST: record.handoffAcknowledgement.resultManifestPath }
                : {}),
            } : {}),
          },
          stdio: "pipe",
          shell: false,
          windowsHide: true,
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          record.stderr += chunk;
        });
        child.on("close", (exitCode) => {
          if (!record.terminal) {
            this.finalize(record, "failed", {
              event: "turn_failed",
              error: "codex_app_server_closed",
              message: `Codex app-server exited before a terminal turn event.${exitCode === null ? "" : ` Exit code: ${exitCode}.`}`,
            });
          }
        });
        record.child = child;
        record.rpc = new JsonRpcLineClient(child);

        await record.rpc.request("initialize", {
          clientInfo: { name: "n8n-openai-cli-gateway-codex-agent", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        }, 30_000);
        record.rpc.notify("initialized");

        await this.startThreadAndTurn(record);
        this.monitorRun(record).catch((error) => {
          this.finalize(record, "failed", {
            event: "turn_failed",
            error: "turn_failed",
            message: error instanceof Error ? error.message : String(error),
          });
        });
        return;
      } catch (error) {
        lastError = error;
        this.killChild(record);
        record.child = undefined;
        record.rpc = undefined;
      }
    }

    throw new Error(`Unable to start Codex app-server. Tried: ${this.codexExecutableCandidates.join(", ")}. ${lastError instanceof Error ? lastError.message : ""}`.trim());
  }

  private async startThreadAndTurn(record: CodexAgentRunRecord): Promise<void> {
    const rpc = requireRpc(record);
    const cfg = record.request.config ?? {};
    const model = typeof cfg.model === "string" && cfg.model.trim() ? cfg.model.trim() : DEFAULT_CODEX_AGENT_MODEL;
    const reasoningEffort = typeof cfg.reasoningEffort === "string" ? cfg.reasoningEffort : undefined;
    const approvalPolicy = cfg.approvalPolicy ?? "never";
    const sandbox = cfg.threadSandbox ?? "workspace-write";

    let threadId = record.request.continuation === true && record.request.threadId ? record.request.threadId : undefined;
    if (!threadId) {
      const threadStart = await rpc.request("thread/start", {
        model,
        reasoningEffort,
        approvalPolicy,
        sandbox,
        experimentalRawEvents: true,
        persistExtendedHistory: true,
      }, 30_000) as Record<string, unknown>;
      const thread = asRecord(threadStart.thread);
      threadId = typeof thread?.id === "string" ? thread.id : undefined;
    }
    if (!threadId) {
      throw new Error("codex app-server did not return thread id.");
    }

    const prompt = record.handoff
      ? `${buildHandoffPrompt(record.handoff)}\n\n${record.request.prompt}`
      : record.request.prompt;
    const turnStart = await rpc.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      model,
      reasoningEffort,
      sandboxPolicy: cfg.turnSandboxPolicy,
    }, 30_000) as Record<string, unknown>;
    const turn = asRecord(turnStart.turn);
    const turnId = typeof turn?.id === "string" ? turn.id : makeId("turn");
    record.summary.threadId = threadId;
    record.summary.turnId = turnId;
    record.summary.sessionId = `${threadId}-${turnId}`;
    record.summary.status = "running";

    this.emit(record, {
      event: "session_started",
      thread_id: threadId,
      turn_id: turnId,
      session_id: record.summary.sessionId,
      codex_app_server_pid: record.child?.pid,
    });
    this.armTimers(record);
  }

  private async monitorRun(record: CodexAgentRunRecord): Promise<void> {
    const rpc = requireRpc(record);
    while (!record.terminal) {
      const incoming = await rpc.nextMessage(1000);
      if (!incoming) {
        continue;
      }
      this.handleRpcMessage(record, incoming);
    }
  }

  private handleRpcMessage(record: CodexAgentRunRecord, incoming: JsonRpcRequest): void {
    const method = typeof incoming.method === "string" ? incoming.method : "";
    const params = asRecord(incoming.params);
    this.armTimers(record);

    if (method === "rawResponseItem/completed" || method === "item/completed") {
      const item = asRecord(params?.item);
      const text = extractText(item);
      if (text) {
        record.outputTextParts.push(text);
        this.emit(record, { event: "output", text });
      }
      return;
    }

    if (method === "turn/completed") {
      const turn = asRecord(params?.turn);
      const status = typeof turn?.status === "string" ? turn.status : "";
      if (status === "failed") {
        this.finalize(record, "failed", {
          event: "turn_failed",
          error: "turn_failed",
          message: extractErrorMessage(turn) || "Codex turn failed.",
        });
        return;
      }
      this.finalize(record, "completed", {
        event: "turn_completed",
        usage: extractUsage(turn),
        result: {
          output_text: record.outputTextParts.join("\n").trim(),
          reasoning: record.reasoningParts.join("\n").trim() || undefined,
        },
      });
      return;
    }

    if (method === "error") {
      const message = extractErrorMessage(params) || "Codex turn failed.";
      this.finalize(record, "failed", { event: "turn_failed", error: "turn_failed", message });
      return;
    }

    if (method.toLowerCase().includes("approval") || method.toLowerCase().includes("input")) {
      if (incoming.id !== undefined) {
        record.rpc?.respond(incoming.id, {
          approved: false,
          success: false,
          message: "Interactive approvals and user input are disabled for codex-agent runs.",
        });
      }
      this.finalize(record, "input_required", {
        event: "turn_input_required",
        message: "Codex requested approval or user input; this agent endpoint runs non-interactively.",
      });
    }
  }

  private armTimers(record: CodexAgentRunRecord): void {
    const stallTimeoutMs = positiveNumber(record.request.config?.stallTimeoutMs) ?? 300_000;
    const turnTimeoutMs = positiveNumber(record.request.config?.turnTimeoutMs) ?? 3_600_000;
    if (record.stallTimer) {
      clearTimeout(record.stallTimer);
    }
    record.stallTimer = setTimeout(() => {
      this.finalize(record, "failed", {
        event: "turn_failed",
        error: "stall_timeout",
        message: "Codex agent run stalled.",
      });
    }, stallTimeoutMs);
    record.stallTimer.unref();

    if (!record.turnTimer) {
      record.turnTimer = setTimeout(() => {
        this.finalize(record, "failed", {
          event: "turn_failed",
          error: "turn_timeout",
          message: "Codex agent run exceeded turnTimeoutMs.",
        });
      }, turnTimeoutMs);
      record.turnTimer.unref();
    }
  }

  private finalize(record: CodexAgentRunRecord, status: CodexAgentRunStatus, event: Omit<CodexAgentEvent, "timestamp" | "cursor">): void {
    if (record.terminal) {
      return;
    }
    record.terminal = true;
    record.summary.status = status;
    record.summary.completedAt = new Date().toISOString();
    if (record.stallTimer) {
      clearTimeout(record.stallTimer);
    }
    if (record.turnTimer) {
      clearTimeout(record.turnTimer);
    }
    this.emit(record, event);
    this.killChild(record);
    record.subscribers.clear();
    this.armTerminalEviction(record);
  }

  private armTerminalEviction(record: CodexAgentRunRecord): void {
    this.armRetentionTimer(record, this.handoffClaimTtlMs);
  }

  private armResultCacheEviction(record: CodexAgentRunRecord): void {
    this.armRetentionTimer(record, this.resultCacheTtlMs);
  }

  private armRetentionTimer(record: CodexAgentRunRecord, ttlMs: number): void {
    if (this.closed || this.runs.get(record.summary.runId) !== record) {
      return;
    }
    this.clearRetentionTimer(record);
    record.retentionTimer = setTimeout(() => {
      void this.evictRun(record);
    }, ttlMs);
    record.retentionTimer.unref();
  }

  private clearRetentionTimer(record: CodexAgentRunRecord): void {
    if (record.retentionTimer) {
      clearTimeout(record.retentionTimer);
      record.retentionTimer = undefined;
    }
  }

  private async evictRun(record: CodexAgentRunRecord): Promise<void> {
    if (this.runs.get(record.summary.runId) !== record) {
      return;
    }
    this.clearRetentionTimer(record);
    if (record.resultCollection) {
      this.armResultCacheEviction(record);
      return;
    }
    if (record.handoff && !record.resultFiles) {
      await this.handoffStore.cleanupLocal(record.summary.workspacePath, record.handoff).catch(() => undefined);
      record.handoff = undefined;
      record.request.handoff = undefined;
    }
    record.resultFiles = undefined;
    await this.waitForChildExit(record);
    this.runs.delete(record.summary.runId);
  }

  private async waitForChildExit(record: CodexAgentRunRecord): Promise<void> {
    const child = record.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    if (await waitForProcessClose(child, 1000)) {
      return;
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may have exited between the bounded wait and forced termination.
    }
    await waitForProcessClose(child, 1000);
  }

  private emit(record: CodexAgentRunRecord, event: Omit<CodexAgentEvent, "timestamp" | "cursor">): void {
    const full = {
      ...event,
      timestamp: new Date().toISOString(),
      cursor: (record.events[record.events.length - 1]?.cursor ?? 0) + 1,
    } as CodexAgentEvent;
    record.summary.lastEventAt = full.timestamp;
    record.events.push(full);
    for (const subscriber of record.subscribers.values()) {
      subscriber({ ...full });
    }
  }

  private killChild(record: CodexAgentRunRecord): void {
    try {
      record.rpc?.close();
    } catch {
      // no-op
    }
    try {
      record.child?.kill("SIGTERM");
    } catch {
      // no-op
    }
  }

  private requireRun(runId: string): CodexAgentRunRecord {
    const record = this.runs.get(runId);
    if (!record) {
      throw new Error(`Unknown codex agent run: ${runId}`);
    }
    return record;
  }

  private async resolveWorkspacePath(workspacePath: string): Promise<string> {
    const resolved = normalizePath(workspacePath);
    if (this.allowedRoots.length === 0) {
      throw new Error("No Codex agent workspace roots are configured.");
    }
    const candidateRoots = this.allowedRoots.filter((root) => isWithinRoot(resolved, root));
    if (candidateRoots.length === 0) {
      throw new Error(`workspacePath is outside the allowed workspace roots: ${resolved}`);
    }
    const workspaceInfo = await lstat(resolved).catch(() => null);
    if (!workspaceInfo?.isDirectory() || workspaceInfo.isSymbolicLink()) {
      throw new Error(`workspacePath is not a safe directory: ${resolved}`);
    }
    const canonicalWorkspace = await realpath(resolved);
    for (const root of candidateRoots) {
      const canonicalRoot = await realpath(root).catch(() => "");
      if (!canonicalRoot) {
        continue;
      }
      const rootInfo = await lstat(canonicalRoot).catch(() => null);
      if (rootInfo?.isDirectory() && isWithinRoot(canonicalWorkspace, canonicalRoot)) {
        return canonicalWorkspace;
      }
    }
    throw new Error(`workspacePath is outside the allowed workspace roots after realpath resolution: ${canonicalWorkspace}`);
  }
}

class JsonRpcLineClient {
  private nextId = 1;
  private buffer = "";
  private closed = false;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly queue: JsonRpcRequest[] = [];
  private readonly waiters: Array<(value: JsonRpcRequest | null) => void> = [];

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.drain();
    });
    child.on("close", () => this.close());
    child.on("error", (error) => this.rejectAll(error));
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  respond(id: unknown, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  nextMessage(timeoutMs: number): Promise<JsonRpcRequest | null> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift() ?? null);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(resolve);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        resolve(null);
      }, timeoutMs);
      this.waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  close(): void {
    this.closed = true;
    this.rejectAll(new Error("codex app-server process closed."));
  }

  private send(payload: unknown): void {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
  }

  private drain(): void {
    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) {
        return;
      }
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) {
        continue;
      }
      let parsed: JsonRpcRequest;
      try {
        parsed = JSON.parse(line) as JsonRpcRequest;
      } catch {
        continue;
      }
      if (typeof parsed.id === "number" && (Object.prototype.hasOwnProperty.call(parsed, "result") || Object.prototype.hasOwnProperty.call(parsed, "error"))) {
        const pending = this.pending.get(parsed.id);
        if (!pending) {
          continue;
        }
        this.pending.delete(parsed.id);
        clearTimeout(pending.timer);
        if (parsed.error) {
          pending.reject(new Error(typeof parsed.error.message === "string" ? parsed.error.message : "JSON-RPC error."));
        } else {
          pending.resolve(parsed.result);
        }
        continue;
      }
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(parsed);
      } else {
        this.queue.push(parsed);
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    while (this.waiters.length > 0) {
      this.waiters.shift()?.(null);
    }
  }
}

function requireRpc(record: CodexAgentRunRecord): JsonRpcLineClient {
  if (!record.rpc) {
    throw new Error("Codex app-server RPC client is unavailable.");
  }
  return record.rpc;
}

function waitForProcessClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      child.off("error", onError);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const onError = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once("close", onClose);
    child.once("error", onError);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish(true);
    }
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function normalizePath(value: string): string {
  return path.resolve(value);
}

function isWithinRoot(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function extractText(item: Record<string, unknown> | undefined): string {
  if (!item) {
    return "";
  }
  const text = item.text ?? item.output_text ?? item.content;
  if (typeof text === "string") {
    return text.trim();
  }
  if (Array.isArray(text)) {
    return text.map((entry) => extractText(asRecord(entry))).filter(Boolean).join("\n").trim();
  }
  return "";
}

function extractErrorMessage(record: Record<string, unknown> | undefined): string {
  const error = asRecord(record?.error);
  const message = error?.message ?? record?.message;
  return typeof message === "string" ? message : "";
}

function extractUsage(turn: Record<string, unknown> | undefined): Record<string, number> | undefined {
  const usage = asRecord(turn?.usage);
  if (!usage) {
    return undefined;
  }
  const input = usage.input_tokens ?? usage.inputTokens;
  const output = usage.output_tokens ?? usage.outputTokens;
  const total = usage.total_tokens ?? usage.totalTokens;
  return {
    ...(typeof input === "number" ? { input_tokens: input } : {}),
    ...(typeof output === "number" ? { output_tokens: output } : {}),
    ...(typeof total === "number" ? { total_tokens: total } : {}),
  };
}
