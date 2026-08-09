import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Provider } from "../providers/provider";
import {
  AgentHandoffStore,
  type GatewayVerifiedResultFiles,
} from "../jobs/agent-handoff-store";
import { CodexAgentManager } from "../jobs/codex-agent-manager";
import { ProviderSessionManager } from "../jobs/provider-session-manager";
import { RemoteAgentManager } from "../jobs/remote-agent-manager";
import type { RemoteCliTargetConfig } from "../types";
import type { RemoteAgentHandoff } from "../validation";

function buildHandoff(operationId: string): RemoteAgentHandoff {
  const buffer = Buffer.from("<brief/>");
  const runDirectory = `.kimibuilt/agent-runs/${operationId}`;
  return {
    version: "RemoteAgentHandoff/v1",
    operationId,
    runDirectory,
    contextDirectory: `${runDirectory}/input`,
    manifestPath: `${runDirectory}/input/manifest.json`,
    sourceArtifactIds: ["artifact-1"],
    files: [{
      filename: "brief.xml",
      mimeType: "application/xml",
      sizeBytes: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      contentBase64: buffer.toString("base64"),
    }],
    output: {
      version: "RemoteAgentResultFiles/v1",
      enabled: true,
      directory: `${runDirectory}/output`,
      filesDirectory: `${runDirectory}/output/files`,
      manifestPath: `${runDirectory}/output/manifest.json`,
      requestedGlobs: [],
      maxFiles: 12,
      maxFileBytes: 4 * 1024 * 1024,
      maxTotalBytes: 6 * 1024 * 1024,
    },
  };
}

function buildVerifiedResults(operationId: string): GatewayVerifiedResultFiles {
  const content = Buffer.from("<svg/>");
  return {
    version: "RemoteAgentResultFiles/v1",
    gatewayVerified: true,
    operationId,
    manifestPath: `.kimibuilt/agent-runs/${operationId}/output/manifest.json`,
    files: [{
      path: `.kimibuilt/agent-runs/${operationId}/output/files/result.svg`,
      filename: "result.svg",
      role: "artifact",
      mimeType: "image/svg+xml",
      description: "Verified SVG result",
      sizeBytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      contentBase64: content.toString("base64"),
    }],
  };
}

test("remote task rolls back its session and staged handoff when bootstrap input fails", async () => {
  const handoff = buildHandoff("81818181-9292-4030-8161-727272727272");
  let cleanupCalls = 0;
  let terminateCalls = 0;
  const sessionManager = {
    async createSession() {
      return {
        id: "session-1",
        status: "running",
        streamToken: "stream-1",
      };
    },
    emitReasoning() {},
    subscribe() {
      return () => undefined;
    },
    writeInput() {
      throw new Error("provider stdin closed");
    },
    terminateSession() {
      terminateCalls += 1;
    },
  } as unknown as ProviderSessionManager;
  const handoffStore = {
    async stageRemote() {
      return {
        accepted: true as const,
        version: "RemoteAgentHandoff/v1" as const,
        operationId: handoff.operationId,
        inputManifestPath: handoff.manifestPath,
        resultManifestPath: handoff.output.manifestPath,
      };
    },
    async cleanupRemote() {
      cleanupCalls += 1;
    },
  } as unknown as AgentHandoffStore;
  const target: RemoteCliTargetConfig = {
    targetId: "k3s-prod",
    host: "example.com",
    user: "deploy",
    allowedCwds: ["/srv/apps"],
    defaultCwd: "/srv/apps/demo",
  };
  const provider = {
    id: "kimi-cli",
    description: "Kimi CLI",
  } as unknown as Provider;
  const manager = new RemoteAgentManager(sessionManager, [target], { handoffStore });

  await assert.rejects(manager.createTask({
    provider,
    targetId: target.targetId,
    cwd: target.defaultCwd,
    task: "Build the selected design.",
    cols: 120,
    rows: 40,
    handoff,
  }), /provider stdin closed/);

  assert.equal(terminateCalls, 1);
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(manager.listTasks(), []);
});

test("remote cancel terminates the session and cleans staged handoff files", async () => {
  const handoff = buildHandoff("91919191-0202-4131-8272-838383838383");
  let cleanupCalls = 0;
  let terminateCalls = 0;
  const session = {
    id: "session-2",
    status: "running",
    streamToken: "stream-2",
    lastActivityAt: new Date().toISOString(),
  };
  const sessionManager = {
    async createSession() {
      return session;
    },
    emitReasoning() {},
    writeInput() {},
    subscribe() {
      return () => undefined;
    },
    terminateSession() {
      terminateCalls += 1;
      session.status = "terminated";
      return session;
    },
    getSession() {
      return session;
    },
  } as unknown as ProviderSessionManager;
  const handoffStore = {
    async stageRemote() {
      return {
        accepted: true as const,
        version: "RemoteAgentHandoff/v1" as const,
        operationId: handoff.operationId,
        inputManifestPath: handoff.manifestPath,
        resultManifestPath: handoff.output.manifestPath,
      };
    },
    async cleanupRemote() {
      cleanupCalls += 1;
    },
  } as unknown as AgentHandoffStore;
  const target: RemoteCliTargetConfig = {
    targetId: "k3s-prod",
    host: "example.com",
    user: "deploy",
    allowedCwds: ["/srv/apps"],
    defaultCwd: "/srv/apps/demo",
  };
  const provider = {
    id: "grok-cli",
    description: "Grok CLI",
  } as unknown as Provider;
  const manager = new RemoteAgentManager(sessionManager, [target], { handoffStore });
  const task = await manager.createTask({
    provider,
    targetId: target.targetId,
    cwd: target.defaultCwd,
    task: "Build the selected design.",
    cols: 120,
    rows: 40,
    handoff,
  });

  const cancelled = await manager.cancelTask(task.id);
  assert.equal(cancelled.status, "terminated");
  assert.equal(terminateCalls, 1);
  assert.equal(cleanupCalls, 1);
});

test("remote manager observes terminal session events and cleans an unclaimed handoff without polling", async () => {
  const handoff = buildHandoff("11111111-2222-4333-8444-555555555555");
  let cleanupCalls = 0;
  let sessionListener: ((event: { type: "status"; status: "completed"; message: string; cursor: number; ts: string }) => void) | undefined;
  const session = {
    id: "session-terminal-event",
    status: "running",
    streamToken: "stream-terminal-event",
    lastActivityAt: new Date().toISOString(),
  };
  const sessionManager = {
    async createSession() {
      return session;
    },
    emitReasoning() {},
    writeInput() {},
    subscribe(_sessionId: string, listener: typeof sessionListener) {
      sessionListener = listener;
      return () => {
        sessionListener = undefined;
      };
    },
    getSession() {
      return session;
    },
    terminateSession() {
      session.status = "terminated";
      return session;
    },
  } as unknown as ProviderSessionManager;
  const handoffStore = {
    async stageRemote() {
      return {
        accepted: true as const,
        version: "RemoteAgentHandoff/v1" as const,
        operationId: handoff.operationId,
        inputManifestPath: handoff.manifestPath,
        resultManifestPath: handoff.output.manifestPath,
      };
    },
    async cleanupRemote() {
      cleanupCalls += 1;
    },
  } as unknown as AgentHandoffStore;
  const { manager, provider, target } = createRemoteManager(sessionManager, handoffStore, {
    handoffClaimTtlMs: 40,
    resultCacheTtlMs: 40,
    taskLifetimeTtlMs: 1000,
  });

  try {
    const task = await manager.createTask({
      provider,
      targetId: target.targetId,
      cwd: target.defaultCwd,
      task: "Build the selected design.",
      cols: 120,
      rows: 40,
      handoff,
    });
    session.status = "completed";
    session.lastActivityAt = new Date().toISOString();
    sessionListener?.({
      type: "status",
      status: "completed",
      message: "Provider completed.",
      cursor: 2,
      ts: session.lastActivityAt,
    });

    await waitFor(() => cleanupCalls === 1);
    assert.equal(manager.getTask(task.id), undefined);
  } finally {
    await manager.close();
  }
});

test("remote manager hard-expires a task even when the provider emits no terminal event", async () => {
  let terminateCalls = 0;
  const session = {
    id: "session-hard-expiry",
    status: "running",
    streamToken: "stream-hard-expiry",
    lastActivityAt: new Date().toISOString(),
  };
  const sessionManager = {
    async createSession() {
      return session;
    },
    emitReasoning() {},
    writeInput() {},
    subscribe() {
      return () => undefined;
    },
    getSession() {
      return session;
    },
    terminateSession() {
      terminateCalls += 1;
      session.status = "terminated";
      session.lastActivityAt = new Date().toISOString();
      return session;
    },
  } as unknown as ProviderSessionManager;
  const { manager, provider, target } = createRemoteManager(
    sessionManager,
    {} as AgentHandoffStore,
    { handoffClaimTtlMs: 1000, resultCacheTtlMs: 40, taskLifetimeTtlMs: 40 },
  );

  try {
    const task = await manager.createTask({
      provider,
      targetId: target.targetId,
      cwd: target.defaultCwd,
      task: "Run without emitting a terminal event.",
      cols: 120,
      rows: 40,
    });
    await waitFor(() => terminateCalls === 1);
    assert.equal(manager.getTask(task.id)?.status, "terminated");
  } finally {
    await manager.close();
  }
});

test("remote manager retains verified result bytes for retry and then evicts the task", async () => {
  const handoff = buildHandoff("66666666-7777-4888-8999-000000000000");
  const expected = buildVerifiedResults(handoff.operationId);
  let collectCalls = 0;
  let sessionListener: ((event: { type: "status"; status: "completed"; message: string; cursor: number; ts: string }) => void) | undefined;
  const session = {
    id: "session-result-cache",
    status: "running",
    streamToken: "stream-result-cache",
    lastActivityAt: new Date().toISOString(),
  };
  const sessionManager = {
    async createSession() {
      return session;
    },
    emitReasoning() {},
    writeInput() {},
    subscribe(_sessionId: string, listener: typeof sessionListener) {
      sessionListener = listener;
      return () => {
        sessionListener = undefined;
      };
    },
    getSession() {
      return session;
    },
    terminateSession() {
      session.status = "terminated";
      return session;
    },
  } as unknown as ProviderSessionManager;
  const handoffStore = {
    async stageRemote() {
      return {
        accepted: true as const,
        version: "RemoteAgentHandoff/v1" as const,
        operationId: handoff.operationId,
        inputManifestPath: handoff.manifestPath,
        resultManifestPath: handoff.output.manifestPath,
      };
    },
    async collectRemote() {
      collectCalls += 1;
      return expected;
    },
  } as unknown as AgentHandoffStore;
  const { manager, provider, target } = createRemoteManager(sessionManager, handoffStore, {
    handoffClaimTtlMs: 1000,
    resultCacheTtlMs: 40,
    taskLifetimeTtlMs: 1000,
  });

  try {
    const task = await manager.createTask({
      provider,
      targetId: target.targetId,
      cwd: target.defaultCwd,
      task: "Return the selected design.",
      cols: 120,
      rows: 40,
      handoff,
    });
    session.status = "completed";
    session.lastActivityAt = new Date().toISOString();
    sessionListener?.({
      type: "status",
      status: "completed",
      message: "Provider completed.",
      cursor: 2,
      ts: session.lastActivityAt,
    });

    assert.deepEqual(await manager.getResultFiles(task.id), expected);
    assert.deepEqual(await manager.getResultFiles(task.id), expected);
    assert.equal(collectCalls, 1);
    await waitFor(() => manager.getTask(task.id) === undefined);
    await assert.rejects(manager.getResultFiles(task.id), /Unknown remote agent task/);
  } finally {
    await manager.close();
  }
});

test("Codex manager cleans unclaimed handoffs and evicts cached verified results", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "codex-manager-retention-"));
  const appServerPath = path.join(workspace, "app-server");
  await writeFakeCodexAppServer(appServerPath);
  const firstHandoff = buildHandoff("12121212-3434-4567-8899-010101010101");
  const secondHandoff = buildHandoff("23232323-4545-4678-8901-121212121212");
  const secondResult = buildVerifiedResults(secondHandoff.operationId);
  let cleanupCalls = 0;
  let collectCalls = 0;
  const handoffStore = {
    async stageLocal(_workspace: string, handoff: RemoteAgentHandoff) {
      return {
        accepted: true as const,
        version: "RemoteAgentHandoff/v1" as const,
        operationId: handoff.operationId,
        inputManifestPath: handoff.manifestPath,
        resultManifestPath: handoff.output.manifestPath,
      };
    },
    async cleanupLocal() {
      cleanupCalls += 1;
    },
    async collectLocal(_workspace: string, handoff: RemoteAgentHandoff) {
      collectCalls += 1;
      assert.equal(handoff.operationId, secondHandoff.operationId);
      return secondResult;
    },
  } as unknown as AgentHandoffStore;
  const manager = new CodexAgentManager({
    allowedWorkspaceRoots: [workspace],
    codexExecutableCandidates: [process.execPath],
    handoffStore,
    handoffClaimTtlMs: 50,
    resultCacheTtlMs: 50,
  });

  try {
    const unclaimed = await manager.startRun({
      workspacePath: workspace,
      prompt: "Complete without claiming results.",
      handoff: firstHandoff,
    });
    await waitFor(() => manager.getRun(unclaimed.runId)?.status === "completed");
    await waitFor(() => cleanupCalls === 1);
    assert.equal(manager.getRun(unclaimed.runId), undefined);

    const claimed = await manager.startRun({
      workspacePath: workspace,
      prompt: "Complete and return results.",
      handoff: secondHandoff,
    });
    await waitFor(() => manager.getRun(claimed.runId)?.status === "completed");
    assert.deepEqual(await manager.getResultFiles(claimed.runId), secondResult);
    assert.deepEqual(await manager.getResultFiles(claimed.runId), secondResult);
    assert.equal(collectCalls, 1);
    await waitFor(() => manager.getRun(claimed.runId) === undefined);
    await assert.rejects(manager.getResultFiles(claimed.runId), /Unknown codex agent run/);
  } finally {
    await manager.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

function createRemoteManager(
  sessionManager: ProviderSessionManager,
  handoffStore: AgentHandoffStore,
  options: {
    handoffClaimTtlMs: number;
    resultCacheTtlMs: number;
    taskLifetimeTtlMs: number;
  },
) {
  const target: RemoteCliTargetConfig = {
    targetId: "k3s-prod",
    host: "example.com",
    user: "deploy",
    allowedCwds: ["/srv/apps"],
    defaultCwd: "/srv/apps/demo",
  };
  const provider = {
    id: "kimi-cli",
    description: "Kimi CLI",
  } as unknown as Provider;
  return {
    manager: new RemoteAgentManager(sessionManager, [target], { handoffStore, ...options }),
    provider,
    target,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true, "Timed out waiting for manager lifecycle state.");
}

async function writeFakeCodexAppServer(targetPath: string): Promise<void> {
  await writeFile(
    targetPath,
    `const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else if (message.method === "thread/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-retention" } } });
  } else if (message.method === "turn/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-retention" } } });
    setTimeout(() => send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { id: "turn-retention", status: "completed" } },
    }), 5);
  }
});
`,
    "utf8",
  );
}
