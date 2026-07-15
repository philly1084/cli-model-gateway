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

const SESSION_SCRIPT = [
  "process.stdin.setEncoding('utf8');",
  "process.stdout.write('ready\\\\n');",
  "process.stdout.write(`continuation:${process.argv[1] || 'fresh'}\\\\n`);",
  "process.stdin.on('data', (chunk) => {",
  "  process.stdout.write(`input:${chunk}`);",
  "});",
].join(" ");

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
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      task: { id: string; sessionId: string; streamToken: string; reasoning: { data: Record<string, unknown> } };
      streamUrl: string;
    };
    assert.match(body.streamUrl, /\/admin\/remote-agent-tasks\/.+\/stream\?token=/);
    assert.equal(body.task.reasoning.data.providerId, "gemini-cli");
    assert.equal(body.task.reasoning.data.targetId, "k3s-prod");
    assert.equal(body.task.reasoning.data.cwd, "/srv/apps/music-board");

    await sleep(100);

    const transcriptResponse = await server.app.inject({
      method: "GET",
      url: `/admin/remote-agent-tasks/${body.task.id}/transcript`,
      headers: {
        authorization: "Bearer frontend-key",
      },
    });

    assert.equal(transcriptResponse.statusCode, 200);
    const transcriptBody = transcriptResponse.json() as {
      data: Array<{ type: string; summary?: string; data?: string }>;
    };
    assert.equal(transcriptBody.data.some((event) => event.type === "reasoning"), true);
    const outputText = transcriptBody.data
      .filter((event) => event.type === "output")
      .map((event) => event.data ?? "")
      .join("");
    assert.match(outputText, /ssh -p 22 deploy@example.com/);
    assert.match(outputText, /REMOTE_AGENT_PROGRESS/);
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
    await sleep(100);
    const transcriptResponse = await server.app.inject({
      method: "GET",
      url: `/admin/remote-agent-tasks/${body.task.id}/transcript`,
      headers: {
        authorization: "Bearer frontend-key",
      },
    });
    const transcript = transcriptResponse.json() as { data: Array<{ type: string; data?: string }> };
    const outputText = transcript.data
      .filter((event) => event.type === "output")
      .map((event) => event.data ?? "")
      .join("");
    assert.match(outputText, new RegExp(`continuation:${sessionId}`));
  } finally {
    await server.close();
  }
});

function createRemoteAgentTestServer() {
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
      args: ["-e", SESSION_SCRIPT, "{{session_id}}"],
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
