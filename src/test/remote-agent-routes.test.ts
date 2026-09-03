import test from "node:test";
import assert from "node:assert/strict";
import type {
  AppConfig,
  CliProviderConfig,
  ProviderResult,
  ProviderStreamEvent,
  RemoteCliTargetConfig,
  UnifiedRequest,
} from "../types";
import type { Provider } from "../providers/provider";
import type { ProviderRegistry } from "../providers/registry";
import { buildServer } from "../server";
import Fastify from "fastify";
import { remoteAgentRoutes } from "../routes/remote-agents";
import type { RemoteAgentManager } from "../jobs/remote-agent-manager";

const SESSION_SCRIPT = [
  "process.stdin.setEncoding('utf8');",
  "process.stdout.write('ready\\\\n');",
  "process.stdout.write(`continuation:${process.argv[1] || 'fresh'}\\\\n`);",
  "process.stdin.on('data', (chunk) => {",
  "  process.stdout.write(`input:${chunk}`);",
  "});",
].join(" ");

test("authenticated task read restores the accepted handoff and result endpoint for continuation", async () => {
  const app = Fastify();
  const handoff = { operationId: "op-123", resultManifestPath: ".kimibuilt/agent-runs/op-123/output/manifest.json" };
  await app.register(remoteAgentRoutes, {
    prefix: "/admin",
    adminApiKey: "admin-key",
    frontendApiKeys: new Set(["frontend-key"]),
    registry: {} as ProviderRegistry,
    manager: { getTask: () => ({ id: "ragent-123", status: "completed", exitCode: 0 }), getHandoffAcknowledgement: () => handoff } as unknown as RemoteAgentManager,
  });
  try {
    const response = await app.inject({ method: "GET", url: "/admin/remote-agent-tasks/ragent-123", headers: { authorization: "Bearer frontend-key" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().id, "ragent-123");
    assert.deepEqual(response.json().handoff, handoff);
    assert.equal(response.json().resultFilesUrl, "/admin/remote-agent-tasks/ragent-123/result-files");
    assert.equal((await app.inject({ method: "GET", url: "/admin/remote-agent-tasks/ragent-123" })).statusCode, 401);
  } finally { await app.close(); }
});

test("remote-agent auth canary body reaches validation without starting a task", async () => {
  const server = createRemoteAgentTestServer();

  try {
    for (const probe of [
      { headers: {}, expectedStatus: 401 },
      { headers: { authorization: "Bearer invalid-key" }, expectedStatus: 401 },
      { headers: { authorization: "Bearer frontend-key" }, expectedStatus: 400 },
    ]) {
      const response = await server.app.inject({
        method: "POST",
        url: "/admin/remote-agent-tasks",
        headers: probe.headers,
        payload: {},
      });

      assert.equal(response.statusCode, probe.expectedStatus);
      if (probe.expectedStatus === 400) {
        assert.match(response.payload, /providerId|targetId|task/);
      }
    }
  } finally {
    await server.close();
  }
});

test("remote agent task starts a provider session and emits reasoning context", async () => {
  const server = createRemoteAgentTestServer();

  try {
    const response = await server.app.inject({
      method: "POST",
      url: "/admin/remote-agent-tasks",
      headers: {
        authorization: "Bearer frontend-key",
      },
      payload: {
        providerId: "gemini-cli",
        targetId: "k3s-prod",
        cwd: "/srv/apps/music-board",
        task: "Update the music board and verify the rollout.",
        adminMode: true,
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      task: { id: string; sessionId: string; streamToken: string; adminMode?: boolean; reasoning: { data: Record<string, unknown> } };
      streamUrl: string;
    };
    assert.match(body.streamUrl, /\/admin\/remote-agent-tasks\/.+\/stream\?token=/);
    assert.equal(body.task.reasoning.data.providerId, "gemini-cli");
    assert.equal(body.task.reasoning.data.targetId, "k3s-prod");
    assert.equal(body.task.reasoning.data.cwd, "/srv/apps/music-board");
    assert.equal(body.task.adminMode, true);
    assert.equal(body.task.reasoning.data.adminMode, true);

    const transcriptBody = await waitForTranscriptOutput(
      server,
      body.task.id,
      /Update the music board and verify the rollout/,
    );
    assert.equal(transcriptBody.data.some((event) => event.type === "reasoning"), true);
    const outputText = transcriptBody.data
      .filter((event) => event.type === "output")
      .map((event) => event.data ?? "")
      .join("");
    assert.match(outputText, /ssh -p 22 deploy@example.com/);
    assert.match(outputText, /REMOTE_AGENT_PROGRESS/);
    assert.match(outputText, /"adminMode":true/);
    assert.match(outputText, /Admin runner mode is enabled/);
    assert.match(outputText, /Update the music board and verify the rollout/);

    const streamResponse = await server.app.inject({
      method: "GET",
      url: `/admin/remote-agent-tasks/${body.task.id}/stream?follow=false&token=${encodeURIComponent(body.task.streamToken)}`,
    });

    assert.equal(streamResponse.statusCode, 200);
    assert.match(streamResponse.payload, /event: reasoning/);
  } finally {
    await server.close();
  }
});

test("remote agent task rejects remote cwd outside target roots", async () => {
  const server = createRemoteAgentTestServer();

  try {
    const response = await server.app.inject({
      method: "POST",
      url: "/admin/remote-agent-tasks",
      headers: {
        authorization: "Bearer frontend-key",
      },
      payload: {
        providerId: "gemini-cli",
        targetId: "k3s-prod",
        cwd: "/etc",
        task: "Inspect files.",
      },
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.payload, /outside target k3s-prod allowed roots/);
  } finally {
    await server.close();
  }
});

test("remote agent stream tokens authorize only the exact GET stream route", async () => {
  const server = createRemoteAgentTestServer();

  try {
    const createResponse = await server.app.inject({
      method: "POST",
      url: "/admin/remote-agent-tasks",
      headers: {
        authorization: "Bearer frontend-key",
      },
      payload: {
        providerId: "gemini-cli",
        targetId: "k3s-prod",
        cwd: "/srv/apps/music-board",
        task: "Verify stream-token endpoint isolation.",
      },
    });
    assert.equal(createResponse.statusCode, 200);
    const body = createResponse.json() as {
      task: { id: string; streamToken: string };
    };
    const smuggledQuery = `x=${encodeURIComponent("/stream")}&token=${encodeURIComponent(body.task.streamToken)}`;

    const taskResponse = await server.app.inject({
      method: "GET",
      url: `/admin/remote-agent-tasks/${body.task.id}?${smuggledQuery}`,
    });
    assert.equal(taskResponse.statusCode, 401);

    const transcriptResponse = await server.app.inject({
      method: "GET",
      url: `/admin/remote-agent-tasks/${body.task.id}/transcript?${smuggledQuery}`,
    });
    assert.equal(transcriptResponse.statusCode, 401);

    const resultFilesResponse = await server.app.inject({
      method: "GET",
      url: `/admin/remote-agent-tasks/${body.task.id}/result-files?${smuggledQuery}`,
    });
    assert.equal(resultFilesResponse.statusCode, 401);

    const cancelResponse = await server.app.inject({
      method: "POST",
      url: `/admin/remote-agent-tasks/${body.task.id}/cancel?${smuggledQuery}`,
    });
    assert.equal(cancelResponse.statusCode, 401);

    const streamResponse = await server.app.inject({
      method: "GET",
      url: `/admin/remote-agent-tasks/${body.task.id}/stream?follow=false&token=${encodeURIComponent(body.task.streamToken)}`,
    });
    assert.equal(streamResponse.statusCode, 200);
  } finally {
    await server.close();
  }
});

test("remote agent task rejects an invalid handoff before starting a provider session", async () => {
  const server = createRemoteAgentTestServer();

  try {
    const response = await server.app.inject({
      method: "POST",
      url: "/admin/remote-agent-tasks",
      headers: {
        authorization: "Bearer frontend-key",
      },
      payload: {
        providerId: "gemini-cli",
        targetId: "k3s-prod",
        cwd: "/srv/apps/music-board",
        task: "Use the selected design.",
        handoff: {
          version: "RemoteAgentHandoff/v0",
        },
      },
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.payload, /handoff\.version/);
  } finally {
    await server.close();
  }
});

test("remote agent task passes a continuation session id into the provider command", async () => {
  const server = createRemoteAgentTestServer();
  const sessionId = "019f6357-10a2-7f61-9bf8-541fa830de18";

  try {
    const response = await server.app.inject({
      method: "POST",
      url: "/admin/remote-agent-tasks",
      headers: {
        authorization: "Bearer frontend-key",
      },
      payload: {
        providerId: "gemini-cli",
        targetId: "k3s-prod",
        cwd: "/srv/apps/music-board",
        task: "Continue the music board rollout.",
        sessionId,
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { task: { id: string } };
    const transcript = await waitForTranscriptOutput(
      server,
      body.task.id,
      new RegExp(`continuation:${sessionId}`),
    );
    const outputText = transcript.data
      .filter((event) => event.type === "output")
      .map((event) => event.data ?? "")
      .join("");
    assert.match(outputText, new RegExp(`continuation:${sessionId}`));
  } finally {
    await server.close();
  }
});

test("remote task receives explicit effort in its child environment and reports wrapper acknowledgement", async () => {
  const server = createRemoteAgentTestServer(true);
  try {
    const response = await server.app.inject({ method: "POST", url: "/admin/remote-agent-tasks", headers: { authorization: "Bearer frontend-key" }, payload: { providerId: "gemini-cli", targetId: "k3s-prod", task: "Check only", reasoningEffort: "high" } });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.task.reasoningEffortReceipt.requested, "high");
    await waitForTranscriptOutput(server, body.task.id, /effort:high/);
    const current = await server.app.inject({ method: "GET", url: `/admin/remote-agent-tasks/${body.task.id}`, headers: { authorization: "Bearer frontend-key" } });
    assert.deepEqual(current.json().reasoningEffortReceipt, { requested: "high", applied: "high", status: "applied", appliedTo: "cli-invocation" });
    const transcript = await waitForTranscriptOutput(server, body.task.id, /effort:high/);
    assert.equal(transcript.data.some((event) => event.type === "output" && event.data?.includes("GATEWAY_REMOTE_REASONING_EFFORT_APPLIED=")), false);
  } finally { await server.close(); }
});

test("remote tasks reject unsupported effort before creating a provider session", async () => {
  const server = createRemoteAgentTestServer();
  try {
    for (const reasoningEffort of ["high", "ultra"]) {
      const response = await server.app.inject({ method: "POST", url: "/admin/remote-agent-tasks", headers: { authorization: "Bearer frontend-key" }, payload: { providerId: "gemini-cli", targetId: "k3s-prod", task: "Check only", reasoningEffort } });
      assert.equal(response.statusCode, 400);
    }
  } finally { await server.close(); }
});

test("missing or mismatched wrapper receipts never claim applied effort and nonzero exits remain failed", async () => {
  for (const acknowledgement of ["", "low"]) {
    const server = createRemoteAgentTestServer(true, { acknowledgement, exitCode: 7 });
    try {
      const response = await server.app.inject({ method: "POST", url: "/admin/remote-agent-tasks", headers: { authorization: "Bearer frontend-key" }, payload: { providerId: "gemini-cli", targetId: "k3s-prod", task: "Check only", reasoningEffort: "high" } });
      assert.equal(response.statusCode, 200);
      const id = response.json().task.id;
      await waitForTranscriptOutput(server, id, /effort:high/);
      let current;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        current = (await server.app.inject({ method: "GET", url: `/admin/remote-agent-tasks/${id}`, headers: { authorization: "Bearer frontend-key" } })).json();
        if (current.status === "failed") break;
        await sleep(20);
      }
      assert.equal(current.status, "failed");
      assert.equal(current.exitCode, 7);
      assert.deepEqual(current.reasoningEffortReceipt, { requested: "high", status: "forwarded" });
    } finally { await server.close(); }
  }
});

test("omitted effort does not inherit process defaults and capabilities advertise the known bridge", async () => {
  const previous = process.env.GATEWAY_REMOTE_REASONING_EFFORT;
  process.env.GATEWAY_REMOTE_REASONING_EFFORT = "high";
  const server = createRemoteAgentTestServer(true);
  try {
    const capabilities = await server.app.inject({ method: "GET", url: "/admin/provider-capabilities", headers: { authorization: "Bearer frontend-key" } });
    assert.equal(capabilities.json().data[0].supportsReasoningEffort, true);
    const response = await server.app.inject({ method: "POST", url: "/admin/remote-agent-tasks", headers: { authorization: "Bearer frontend-key" }, payload: { providerId: "gemini-cli", targetId: "k3s-prod", task: "Check only" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().task.reasoningEffortReceipt, undefined);
    const transcript = await waitForTranscriptOutput(server, response.json().task.id, /effort:\n/);
    assert.equal(transcript.data.some((event) => event.type === "output" && event.data?.includes("effort:high")), false);
  } finally {
    await server.close();
    if (previous === undefined) delete process.env.GATEWAY_REMOTE_REASONING_EFFORT;
    else process.env.GATEWAY_REMOTE_REASONING_EFFORT = previous;
  }
});

function createRemoteAgentTestServer(codexSession = false, control: { acknowledgement?: string; exitCode?: number } = {}) {
  const cliConfig: CliProviderConfig = {
    id: "gemini-cli",
    type: "cli",
    description: "Interactive Gemini test provider",
    models: [
      {
        id: "gemini-test",
        providerModel: "gemini-test",
      },
    ],
    responseCommand: {
      executable: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({ output_text: 'ok', finish_reason: 'stop' }))"],
      input: "request_json_stdin",
      output: "json_contract",
      timeoutMs: 1000,
    },
    sessionCommand: {
      executable: process.execPath,
      args: codexSession
        ? ["-e", `const e=process.env.GATEWAY_REMOTE_REASONING_EFFORT; const ack=${JSON.stringify(control.acknowledgement) ?? "e"}; if(ack) process.stdout.write('GATEWAY_REMOTE_REASONING_EFFORT_APPLIED='+ack+'\\n'); process.stdout.write('effort:'+e+'\\n'); process.exitCode=${control.exitCode ?? 0};`, "dist/scripts/remote-agent-session-bridge.js", "--provider", "codex"]
        : ["-e", SESSION_SCRIPT, "{{session_id}}"],
      supportsWorkingDirectory: true,
      idleTimeoutMs: 5000,
      maxLifetimeMs: 30000,
      ptyMode: "pipe",
      closeInputAfterWrite: true,
    },
  };

  const cliProvider: Provider = {
    id: cliConfig.id,
    description: cliConfig.description,
    config: cliConfig,
    models: cliConfig.models,
    async run(): Promise<ProviderResult> {
      return {
        outputText: "ok",
        toolCalls: [],
        finishReason: "stop",
      };
    },
    async *runStream(): AsyncIterable<ProviderStreamEvent> {
      yield { type: "done", finishReason: "stop" };
    },
    supportsStreaming() {
      return true;
    },
    async startLoginJob() {
      throw new Error("not used");
    },
    async checkAuthStatus() {
      return {
        ok: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    },
    async checkRateLimits() {
      return {
        providerId: cliConfig.id,
        status: "healthy" as const,
        limits: [],
      };
    },
  };

  const providers = new Map([[cliProvider.id, cliProvider]]);
  const registry = {
    listModels: () => [
      {
        id: "gemini-test",
        providerId: cliProvider.id,
        providerModel: "gemini-test",
        fallbackModels: [],
      },
    ],
    listProviders: () => [...providers.values()],
    getProvider: (providerId: string) => providers.get(providerId),
    async runModel(_modelId: string, _request: Omit<UnifiedRequest, "model" | "providerModel">) {
      return {
        outputText: "ok",
        toolCalls: [],
        finishReason: "stop",
      };
    },
    canStreamModel: () => false,
    runModelStream: async function* (_modelId: string, _request: Omit<UnifiedRequest, "model" | "providerModel">) {
      return;
    },
  } as unknown as ProviderRegistry;

  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    n8nApiKeys: new Set(["test-key"]),
    adminApiKey: "admin-key",
    frontendApiKeys: new Set(["frontend-key"]),
    frontendAllowedCwds: [process.cwd()],
    codexAgentAllowedWorkspaceRoots: [process.cwd()],
    remoteCliToolAuthScopes: new Set(["frontend", "admin"]),
    providersPath: "config/providers.yaml",
    logLevel: "error",
    maxJobLogLines: 10,
    shutdownTimeoutMs: 1000,
    requestTimeoutMs: 1000,
    rateLimitMax: 100,
    rateLimitWindowMs: 60_000,
    maxRequestBodySize: 1024 * 1024,
    autoRouterBenchmarkOnStart: false,
    autoRouterBenchmarkTimeoutMs: 1000,
    autoRouterBenchmarkMaxModels: 0,
    autoRouterBenchmarkConcurrency: 1,
    autoRouterBenchmarkIntervalMs: 0,
    autoRouterBenchmarkEvaluateQuality: false,
    autoRouterBenchmarkQualityTimeoutMs: 1000,
  };

  const remoteCliTargets: RemoteCliTargetConfig[] = [
    {
      targetId: "k3s-prod",
      description: "K3s production host",
      host: "example.com",
      user: "deploy",
      port: 22,
      allowedCwds: ["/srv/apps"],
      defaultCwd: "/srv/apps/music-board",
    },
  ];

  return buildServer(config, registry, { remoteCliTargets });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTranscriptOutput(
  server: ReturnType<typeof createRemoteAgentTestServer>,
  taskId: string,
  expected: RegExp,
): Promise<{ data: Array<{ type: string; summary?: string; data?: string }> }> {
  const deadline = Date.now() + 3000;
  let transcript = { data: [] as Array<{ type: string; summary?: string; data?: string }> };
  while (Date.now() < deadline) {
    const response = await server.app.inject({
      method: "GET",
      url: `/admin/remote-agent-tasks/${taskId}/transcript`,
      headers: {
        authorization: "Bearer frontend-key",
      },
    });
    assert.equal(response.statusCode, 200);
    transcript = response.json() as typeof transcript;
    const outputText = transcript.data
      .filter((event) => event.type === "output")
      .map((event) => event.data ?? "")
      .join("");
    if (expected.test(outputText)) {
      return transcript;
    }
    await sleep(25);
  }
  return transcript;
}
