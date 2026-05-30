import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import type { RemoteCliTargetConfig } from "../types";
import { makeId } from "../utils/ids";
import { shellEscape } from "../utils/shell";

const DEFAULT_OPENCODE_EXECUTABLE = "opencode";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_WAIT_MS = 1000;
const MAX_WAIT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

export type RemoteCliJobStatus = "running" | "completed" | "failed" | "timed_out" | "cancelled";

export interface RemoteCliRunInput {
  targetId: string;
  cwd?: string;
  task: string;
  model?: string;
  sessionId?: string;
  adminMode?: boolean;
  waitMs?: number;
}

export interface RemoteCliJob {
  id: string;
  targetId: string;
  cwd: string;
  status: RemoteCliJobStatus;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  sessionId?: string;
  summary?: string;
  proof?: RemoteCliProof;
  durationMs?: number;
}

export interface RemoteCliProof {
  complete: boolean;
  missing: string[];
  markers: Record<string, string[]>;
  finalText?: string;
}

interface RemoteCliJobInternal extends RemoteCliJob {
  child?: ChildProcessWithoutNullStreams;
  timeout?: ReturnType<typeof setTimeout>;
  sigkillTimer?: ReturnType<typeof setTimeout>;
  maxOutputBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface RemoteCliLaunch {
  command: string;
  args: string[];
  cwd: string;
  target: RemoteCliTargetConfig;
  remoteCommand: string;
}

export class RemoteCliToolManager {
  private readonly targets = new Map<string, RemoteCliTargetConfig>();
  private readonly jobs = new Map<string, RemoteCliJobInternal>();
  private readonly sshExecutable: string;
  private readonly spawnFn: SpawnFn;

  constructor(
    targets: RemoteCliTargetConfig[] = [],
    options: { sshExecutable?: string; spawnFn?: SpawnFn } = {},
  ) {
    for (const target of targets) {
      this.targets.set(target.targetId, target);
    }
    this.sshExecutable = options.sshExecutable ?? "ssh";
    this.spawnFn = options.spawnFn ?? spawn;
  }

  listTargets(): RemoteCliTargetConfig[] {
    return [...this.targets.values()].map((target) => ({
      ...target,
      allowedCwds: [...target.allowedCwds],
    }));
  }

  async run(input: RemoteCliRunInput): Promise<RemoteCliJob> {
    const launch = buildRemoteOpenCodeLaunch(input, this.targets, this.sshExecutable);
    const job = this.createJob(launch);
    this.startJob(job, launch);

    const waitMs = normalizeWaitMs(input.waitMs);
    if (waitMs > 0) {
      await this.waitForSettled(job.id, waitMs);
    }

    return this.toPublic(job);
  }

  getJob(jobId: string): RemoteCliJob | undefined {
    const job = this.jobs.get(jobId);
    return job ? this.toPublic(job) : undefined;
  }

  cancel(jobId: string): RemoteCliJob {
    const job = this.requireJob(jobId);
    if (job.status === "running") {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      job.durationMs = Date.now() - new Date(job.startedAt).getTime();
      if (job.timeout) {
        clearTimeout(job.timeout);
      }
      job.child?.kill("SIGTERM");
    }
    return this.toPublic(job);
  }

  async close(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.status === "running") {
        job.status = "cancelled";
        job.child?.kill("SIGTERM");
      }
      if (job.timeout) {
        clearTimeout(job.timeout);
      }
      if (job.sigkillTimer) {
        clearTimeout(job.sigkillTimer);
      }
    }
  }

  private createJob(launch: RemoteCliLaunch): RemoteCliJobInternal {
    const now = new Date().toISOString();
    const job: RemoteCliJobInternal = {
      id: makeId("rcli"),
      targetId: launch.target.targetId,
      cwd: launch.cwd,
      status: "running",
      startedAt: now,
      stdout: "",
      stderr: "",
      maxOutputBytes: launch.target.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  private startJob(job: RemoteCliJobInternal, launch: RemoteCliLaunch): void {
    const startedAt = Date.now();
    let finished = false;
    const child = this.spawnFn(launch.command, launch.args, {
      env: process.env,
      stdio: "pipe",
      shell: false,
      windowsHide: true,
    });
    job.child = child;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      appendOutput(job, "stdout", chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      appendOutput(job, "stderr", chunk);
    });

    job.timeout = setTimeout(() => {
      if (finished || job.status !== "running") {
        return;
      }
      finished = true;
      job.status = "timed_out";
      job.finishedAt = new Date().toISOString();
      job.durationMs = Date.now() - startedAt;
      child.kill("SIGTERM");
      job.sigkillTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      job.sigkillTimer.unref();
    }, launch.target.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    job.timeout.unref();

    child.on("error", (error) => {
      if (finished || job.status !== "running") {
        return;
      }
      finished = true;
      clearJobTimers(job);
      job.status = "failed";
      job.exitCode = null;
      appendOutput(job, "stderr", `\n[system] Failed to start remote CLI: ${error.message}`);
      finalizeOutput(job, startedAt);
    });

    child.on("close", (exitCode) => {
      if (finished) {
        if (job.sigkillTimer) {
          clearTimeout(job.sigkillTimer);
          job.sigkillTimer = undefined;
        }
        return;
      }
      finished = true;
      clearJobTimers(job);
      job.exitCode = exitCode;
      if (job.status === "running") {
        job.status = exitCode === 0 ? "completed" : "failed";
      }
      finalizeOutput(job, startedAt);
    });
  }

  private async waitForSettled(jobId: string, waitMs: number): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < waitMs) {
      const job = this.jobs.get(jobId);
      if (!job || job.status !== "running") {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private requireJob(jobId: string): RemoteCliJobInternal {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Unknown remote CLI job: ${jobId}`);
    }
    return job;
  }

  private toPublic(job: RemoteCliJobInternal): RemoteCliJob {
    return {
      id: job.id,
      targetId: job.targetId,
      cwd: job.cwd,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      exitCode: job.exitCode,
      stdout: job.stdout,
      stderr: job.stderr,
      sessionId: job.sessionId,
      summary: job.summary,
      proof: job.proof,
      durationMs: job.durationMs,
    };
  }
}

export function buildRemoteOpenCodeLaunch(
  input: RemoteCliRunInput,
  targets: Map<string, RemoteCliTargetConfig>,
  sshExecutable = "ssh",
): RemoteCliLaunch {
  const target = targets.get(input.targetId);
  if (!target) {
    throw new Error(`Unknown remote CLI target: ${input.targetId}`);
  }
  if (!input.task.trim()) {
    throw new Error("task is required.");
  }

  const cwd = resolveRemoteCwd(input.cwd ?? target.defaultCwd, target);
  const destination = target.user ? `${target.user}@${target.host}` : target.host;
  const remoteExecutable = target.opencodeExecutable ?? DEFAULT_OPENCODE_EXECUTABLE;
  const remoteArgs = [
    shellEscape(remoteExecutable),
    "run",
    "--format",
    "json",
  ];
  if (supportsSandboxMode(remoteExecutable)) {
    remoteArgs.push("--sandbox", input.adminMode ? "danger-full-access" : "workspace-write");
  }
  if (input.model?.trim()) {
    remoteArgs.push("--model", shellEscape(input.model.trim()));
  } else if (target.defaultModel?.trim()) {
    remoteArgs.push("--model", shellEscape(target.defaultModel.trim()));
  }
  if (input.sessionId?.trim()) {
    remoteArgs.push("--session", shellEscape(input.sessionId.trim()));
  }
  remoteArgs.push(shellEscape(withRemoteProofInstructions(input.task)));

  const remoteCommand = `cd ${shellEscape(cwd)} && ${remoteArgs.join(" ")}`;
  const args = ["-o", "BatchMode=yes"];
  if (target.port) {
    args.push("-p", String(target.port));
  }
  args.push(destination, remoteCommand);

  return {
    command: sshExecutable,
    args,
    cwd,
    target,
    remoteCommand,
  };
}

function supportsSandboxMode(executable: string): boolean {
  return /(?:^|[/\\])(?:codex|codex-remote-run)(?:$|[.\s_-])/i.test(executable)
    || /\bcodex\b/i.test(executable);
}

function resolveRemoteCwd(requestedCwd: string | undefined, target: RemoteCliTargetConfig): string {
  if (!requestedCwd) {
    throw new Error(`Remote CLI target ${target.targetId} requires cwd or defaultCwd.`);
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

function normalizeWaitMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_WAIT_MS;
  }
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_WAIT_MS;
  }
  return Math.min(Math.floor(value), MAX_WAIT_MS);
}

function appendOutput(job: RemoteCliJobInternal, stream: "stdout" | "stderr", chunk: string): void {
  if (stream === "stdout") {
    if (job.stdout.length + chunk.length <= job.maxOutputBytes) {
      job.stdout += chunk;
      return;
    }
    if (!job.stdoutTruncated) {
      const remaining = Math.max(0, job.maxOutputBytes - job.stdout.length);
      job.stdout += `${chunk.slice(0, remaining)}\n[...stdout truncated]\n`;
      job.stdoutTruncated = true;
    }
    return;
  }

  if (job.stderr.length + chunk.length <= job.maxOutputBytes) {
    job.stderr += chunk;
    return;
  }
  if (!job.stderrTruncated) {
    const remaining = Math.max(0, job.maxOutputBytes - job.stderr.length);
    job.stderr += `${chunk.slice(0, remaining)}\n[...stderr truncated]\n`;
    job.stderrTruncated = true;
  }
}

function clearJobTimers(job: RemoteCliJobInternal): void {
  if (job.timeout) {
    clearTimeout(job.timeout);
    job.timeout = undefined;
  }
  if (job.sigkillTimer) {
    clearTimeout(job.sigkillTimer);
    job.sigkillTimer = undefined;
  }
}

function finalizeOutput(job: RemoteCliJobInternal, startedAt: number): void {
  job.finishedAt = new Date().toISOString();
  job.durationMs = Date.now() - startedAt;
  const parsed = parseOpenCodeOutput(job.stdout);
  job.sessionId = job.sessionId ?? parsed.sessionId;
  job.summary = parsed.summary;
  job.proof = parsed.proof;
}

function parseOpenCodeOutput(stdout: string): { sessionId?: string; summary?: string; proof: RemoteCliProof } {
  let sessionId: string | undefined;
  let summary: string | undefined;
  const textFragments: string[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) {
      if (trimmed) {
        textFragments.push(trimmed);
      }
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      sessionId = sessionId ?? firstString(parsed.sessionId, parsed.session_id, parsed.sessionID);
      summary = firstString(parsed.summary, parsed.output, parsed.text, parsed.message) ?? summary;
      collectTextFragments(parsed, textFragments);
      const nested = typeof parsed.session === "object" && parsed.session !== null
        ? parsed.session as Record<string, unknown>
        : undefined;
      sessionId = sessionId ?? firstString(nested?.id, nested?.sessionId, nested?.session_id);
    } catch {
      textFragments.push(trimmed);
      continue;
    }
  }

  const proof = parseRemoteProof(textFragments.join("\n"));
  if (!summary && proof.markers.WHAT_CHANGED?.[0]) {
    summary = proof.markers.WHAT_CHANGED[0];
  }

  return { sessionId, summary, proof };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function withRemoteProofInstructions(task: string): string {
  return [
    task,
    "",
    "Remote CLI completion contract:",
    "Finish by printing these marker lines exactly once the work is done:",
    "WHAT_CHANGED=<short summary of source/config/deploy changes>",
    "VERIFY_COMMANDS=<commands or checks run, or not_available>",
    "VERIFY_RESULTS=<pass/fail/blocked result for those checks>",
    "PUBLIC_URL=<https URL or not_available>",
    "BLOCKER=<none or exact blocker>",
    "Also include continuity markers when known: REMOTE_CLI_SESSION_ID=<session id>, WORKSPACE=<path>, GIT_COMMIT=<sha>, DEPLOYMENT=<namespace/name>, PUBLIC_HOST=<host>, UI_CHECK_REPORT=<path>, UI_SCREENSHOTS=<paths>.",
  ].join("\n");
}

const REQUIRED_PROOF_MARKERS = [
  "WHAT_CHANGED",
  "VERIFY_COMMANDS",
  "VERIFY_RESULTS",
  "PUBLIC_URL",
  "BLOCKER",
] as const;

function parseRemoteProof(text: string): RemoteCliProof {
  const markers: Record<string, string[]> = {};
  for (const marker of [
    ...REQUIRED_PROOF_MARKERS,
    "REMOTE_AGENT_RESULT",
    "REMOTE_CLI_SESSION_ID",
    "WORKSPACE",
    "GIT_REPO",
    "GIT_BRANCH",
    "GIT_BASE_COMMIT",
    "GIT_COMMIT",
    "CHANGED_FILES",
    "DEPLOYMENT",
    "PUBLIC_HOST",
    "UI_CHECK_REPORT",
    "UI_SCREENSHOTS",
  ]) {
    const values = readMarkerValues(text, marker);
    if (values.length > 0) {
      markers[marker] = values;
    }
  }

  const missing = REQUIRED_PROOF_MARKERS.filter((marker) => !markers[marker]?.length);
  return {
    complete: missing.length === 0,
    missing,
    markers,
    finalText: lastNonEmptyText(text),
  };
}

function readMarkerValues(text: string, marker: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(`^${marker}=([^\\r\\n]*)`, "gm");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = match[1]?.trim();
    if (value && !isPlaceholderMarkerValue(value)) {
      values.push(value);
    }
  }
  return values;
}

function isPlaceholderMarkerValue(value: string): boolean {
  return value.startsWith("<") && value.endsWith(">");
}

function lastNonEmptyText(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.at(-1);
}

function collectTextFragments(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    if (value.trim()) {
      output.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTextFragments(item, output);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      collectTextFragments(nested, output);
    }
  }
}
