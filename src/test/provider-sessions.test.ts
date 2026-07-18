import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type {
  AppConfig,
  CliProviderConfig,
  ProviderResult,
  ProviderStreamEvent,
  UnifiedRequest,
} from "../types";
import type { Provider } from "../providers/provider";
import type { ProviderRegistry } from "../providers/registry";
import { buildServer } from "../server";

const SESSION_SCRIPT = [
  "process.stdin.setEncoding('utf8');",
  "process.stdout.write('ready\\\\n');",
  "process.stdin.on('data', (chunk) => {",
  "  const parts = chunk.split(/(?<=\\\\n)/);",
  "  let shouldExit = false;",
  "  for (const part of parts) {",
  "    if (!part) continue;",
  "    if (part.includes('exit')) {",
  "      process.stdout.write('bye\\\\n');",
  "      shouldExit = true;",
  "      continue;",
  "    }",
  "    process.stdout.write(`echo:${part}`);",
  "  }",
  "  if (shouldExit) process.exit(0);",
  "});",
].join(" ");

const MODEL_SESSION_SCRIPT = [
  "process.stdout.write(`args:${JSON.stringify(process.argv.slice(1))}\\n`);",
].join(" ");

test("provider capabilities expose session support separately from non-session providers", async () => {
  const server = createProviderSessionTestServer();

  try {
    const response = await server.app.inject({
      method: "GET",
      url: "/admin/provider-capabilities",
      headers: {
        authorization: "Bearer frontend-key",
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { data: Array<Record<string, unknown>> };
    const gemini = body.data.find((entry) => entry.providerId === "gemini-cli");
    const kimi = body.data.find((entry) => entry.providerId === "kimi-code-cli");
    const deepseek = body.data.find((entry) => entry.providerId === "deepseek-api");
    assert.equal(gemini?.supportsSessions, true);
    assert.equal(gemini?.supportsWorkingDirectory, true);
    assert.equal(gemini?.supportsModelSelection, false);
    assert.equal(kimi?.supportsSessions, true);
    assert.equal(kimi?.supportsModelSelection, true);
    assert.equal(deepseek?.supportsSessions, false);
  } finally {
    await server.close();
  }
});

test("Kimi provider sessions pass the K3 provider model through the configured safe model flag", async () => {
  const server = createProviderSessionTestServer();

  try {
    const response = await server.app.inject({
      method: "POST",
      url: "/admin/provider-sessions",
      headers: {
        authorization: "Bearer frontend-key",
      },
      payload: {
        providerId: "kimi-code-cli",
        model: "k3",
        cwd: process.cwd(),
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { session: { id: string; model?: string } };
    assert.equal(body.session.model, "k3");
    await waitForOutput(server, body.session.id, /args:\["--model","k3"\]/, "frontend-key");
  } finally {
    await server.close();
  }
});

test("frontend session lifecycle supports create, input, transcript, and token stream attach", async () => {
  const server = createProviderSessionTestServer();

  try {
    const createResponse = await server.app.inject({
      method: "POST",
      url: "/admin/provider-sessions",
      headers: {
        authorization: "Bearer frontend-key",
      },
      payload: {
        providerId: "gemini-cli",
        cwd: process.cwd(),
        cols: 100,
        rows: 30,
      },
    });

    assert.equal(createResponse.statusCode, 200);
    const createBody = createResponse.json() as {
      session: { id: string; streamToken: string };
      streamUrl: string;
    };
    assert.match(createBody.streamUrl, /\/admin\/provider-sessions\/.+\/stream\?token=/);

    const sessionId = createBody.session.id;

    const inputResponse = await server.app.inject({
      method: "POST",
      url: `/admin/provider-sessions/${sessionId}/input`,
      headers: {
        authorization: "Bearer frontend-key",
      },
      payload: {
        data: "hello\n",
      },
    });

    assert.equal(inputResponse.statusCode, 200);
    await waitForOutput(server, sessionId, /echo:hello/, "frontend-key");

    await server.app.inject({
      method: "POST",
      url: `/admin/provider-sessions/${sessionId}/input`,
      headers: {
        authorization: "Bearer frontend-key",
      },
      payload: {
        data: "exit\n",
      },
    });

    await sleep(150);

    const transcriptResponse = await server.app.inject({
      method: "GET",
      url: `/admin/provider-sessions/${sessionId}/transcript`,
      headers: {
        authorization: "Bearer frontend-key",
      },
    });

    assert.equal(transcriptResponse.statusCode, 200);
    const transcriptBody = transcriptResponse.json() as { data: Array<{ type: string; data?: string }> };
    const outputText = transcriptBody.data
      .filter((event) => event.type === "output")
      .map((event) => event.data ?? "")
      .join("");
    assert.match(outputText, /ready/);
    assert.match(outputText, /echo:hello/);
    assert.match(outputText, /bye/);

    const streamResponse = await server.app.inject({
      method: "GET",
      url: `/admin/provider-sessions/${sessionId}/stream?follow=false&token=${encodeURIComponent(createBody.session.streamToken)}`,
    });

    assert.equal(streamResponse.statusCode, 200);
    assert.match(streamResponse.payload, /event: output/);
    assert.match(streamResponse.payload, /echo:hello/);
  } finally {
    await server.close();
  }
});

test("frontend sessions reject cwd overrides outside configured roots while admin sessions may bypass the root list", async () => {
  const server = createProviderSessionTestServer();
  const parentDir = path.dirname(process.cwd());

  try {
    const frontendResponse = await server.app.inject({
      method: "POST",
      url: "/admin/provider-sessions",
      headers: {
        authorization: "Bearer frontend-key",
      },
      payload: {
        providerId: "gemini-cli",
        cwd: parentDir,
      },
    });

    assert.equal(frontendResponse.statusCode, 400);
    assert.match(frontendResponse.payload, /outside the configured frontend roots/i);

    const adminResponse = await server.app.inject({
      method: "POST",
      url: "/admin/provider-sessions",
      headers: {
        authorization: "Bearer admin-key",
      },
      payload: {
        providerId: "gemini-cli",
        cwd: parentDir,
      },
    });

    assert.equal(adminResponse.statusCode, 200);
    const body = adminResponse.json() as { session: { id: string } };

    await server.app.inject({
      method: "DELETE",
      url: `/admin/provider-sessions/${body.session.id}`,
      headers: {
        authorization: "Bearer admin-key",
      },
    });
  } finally {
    await server.close();
  }
});

function createProviderSessionTestServer() {
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
      args: ["-e", SESSION_SCRIPT],
      supportsWorkingDirectory: true,
      idleTimeoutMs: 5000,
      maxLifetimeMs: 30000,
      ptyMode: "pipe",
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

  const kimiConfig: CliProviderConfig = {
    ...cliConfig,
    id: "kimi-code-cli",
    description: "Kimi CLI test provider",
    models: [
      {
        id: "k3",
        providerModel: "k3",
      },
      {
        id: "kimi-for-coding",
        providerModel: "kimi-for-coding",
      },
    ],
    sessionCommand: {
      executable: process.execPath,
      args: ["-e", MODEL_SESSION_SCRIPT, "--"],
      supportsModelSelection: true,
      modelFlag: "--model",
      supportsWorkingDirectory: true,
      idleTimeoutMs: 5000,
      maxLifetimeMs: 30000,
      ptyMode: "pipe",
    },
  };
  const kimiProvider: Provider = {
    ...cliProvider,
    id: kimiConfig.id,
    description: kimiConfig.description,
    config: kimiConfig,
    models: kimiConfig.models,
  };

  const deepseekProvider: Provider = {
    id: "deepseek-api",
    description: "DeepSeek API",
    config: {
      id: "deepseek-api",
      type: "openai",
      description: "DeepSeek API",
      baseUrl: "https://example.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      timeoutMs: 1000,
      models: [
        {
          id: "deepseek-chat",
          providerModel: "deepseek-chat",
        },
      ],
    },
    models: [
      {
        id: "deepseek-chat",
        providerModel: "deepseek-chat",
      },
    ],
    async run(): Promise<ProviderResult> {
      return {
        outputText: "ok",
        toolCalls: [],
        finishReason: "stop",
      };
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
        providerId: "deepseek-api",
        status: "healthy" as const,
        limits: [],
      };
    },
  };

  const providers = new Map([
    [cliProvider.id, cliProvider],
    [kimiProvider.id, kimiProvider],
    [deepseekProvider.id, deepseekProvider],
  ]);
  const registry = {
    listModels: () => [
      {
        id: "gemini-test",
        providerId: cliProvider.id,
        providerModel: "gemini-test",
        fallbackModels: [],
      },
      {
        id: "k3",
        providerId: kimiProvider.id,
        providerModel: "k3",
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

  return buildServer(config, registry);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOutput(
  server: ReturnType<typeof createProviderSessionTestServer>,
  sessionId: string,
  pattern: RegExp,
  apiKey: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  let outputText = "";
  while (Date.now() < deadline) {
    const transcriptResponse = await server.app.inject({
      method: "GET",
      url: `/admin/provider-sessions/${sessionId}/transcript`,
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
    });
    const transcriptBody = transcriptResponse.json() as { data: Array<{ type: string; data?: string }> };
    outputText = transcriptBody.data
      .filter((event) => event.type === "output")
      .map((event) => event.data ?? "")
      .join("");
    if (pattern.test(outputText)) {
      return;
    }
    await sleep(25);
  }
  assert.match(outputText, pattern, `Timed out waiting for provider session output matching ${pattern}.`);
}
