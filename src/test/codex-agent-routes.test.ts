import test from "node:test";
import assert from "node:assert/strict";
import type {
  AppConfig,
  ProviderResult,
  ProviderStreamEvent,
  UnifiedRequest,
} from "../types";
import type { ProviderRegistry } from "../providers/registry";
import { buildServer } from "../server";
import { DEFAULT_CODEX_AGENT_MODEL } from "../jobs/codex-agent-manager";

test("codex agent defaults to the verified GPT-5.6 Codex model", () => {
  assert.equal(DEFAULT_CODEX_AGENT_MODEL, "gpt-5.6-sol");
});

test("codex agent run rejects workspaces outside allowed roots", async () => {
  const server = createCodexAgentTestServer();

  try {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/codex-agent/run",
      headers: {
        authorization: "Bearer frontend-key",
      },
      payload: {
        workspacePath: "C:\\tmp\\outside\\KIMI-123",
        issue: {
          identifier: "KIMI-123",
          title: "Fix login redirect",
        },
        prompt: "Rendered WORKFLOW.md prompt",
        config: {
          approvalPolicy: "never",
          threadSandbox: "workspace-write",
          turnTimeoutMs: 3600000,
          stallTimeoutMs: 300000,
        },
      },
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.payload, /outside the allowed workspace roots/);
  } finally {
    await server.close();
  }
});

test("codex agent endpoints require frontend or admin auth", async () => {
  const server = createCodexAgentTestServer();

  try {
    const response = await server.app.inject({
      method: "GET",
      url: "/api/codex-agent/runs/run_missing",
    });

    assert.equal(response.statusCode, 401);
  } finally {
    await server.close();
  }
});

function createCodexAgentTestServer() {
  const registry = {
    listModels: () => [],
    listProviders: () => [],
    getProvider: () => undefined,
    async runModel(_modelId: string, _request: Omit<UnifiedRequest, "model" | "providerModel">): Promise<ProviderResult> {
      return {
        outputText: "ok",
        toolCalls: [],
        finishReason: "stop",
      };
    },
    canStreamModel: () => false,
    runModelStream: async function* (_modelId: string, _request: Omit<UnifiedRequest, "model" | "providerModel">): AsyncIterable<ProviderStreamEvent> {
      return;
    },
  } as unknown as ProviderRegistry;

  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    n8nApiKeys: new Set(["test-key"]),
    adminApiKey: "admin-key",
    frontendApiKeys: new Set(["frontend-key"]),
    frontendAllowedCwds: ["C:\\tmp\\frontend"],
    codexAgentAllowedWorkspaceRoots: ["C:\\tmp\\symphony_workspaces"],
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

  return buildServer(config, registry);
}
