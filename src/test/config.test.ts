import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAppConfig, loadProvidersFile, loadRemoteCliTargetsFile } from "../config";

test("loadProvidersFile parses remoteCliTargets", () => {
  const providersPath = writeTempProvidersFile(`
providers:
  - id: demo
    type: cli
    models:
      - id: demo-model
    responseCommand:
      executable: node
      args: []
      input: request_json_stdin
      output: json_contract
      timeoutMs: 1000
remoteCliTargets:
  - targetId: prod
    host: prod.example.com
    user: deploy
    port: 2222
    allowedCwds:
      - /srv/apps
    defaultCwd: /srv/apps/repo
    defaultModel: openai/gpt-5.4
    timeoutMs: 600000
`);

  const parsed = loadProvidersFile(providersPath);
  assert.equal(parsed.remoteCliTargets?.length, 1);
  assert.equal(parsed.remoteCliTargets?.[0]?.targetId, "prod");
  assert.equal(parsed.remoteCliTargets?.[0]?.allowedCwds[0], "/srv/apps");
});

test("loadProvidersFile rejects remote targets without allowed roots", () => {
  const providersPath = writeTempProvidersFile(`
providers:
  - id: demo
    type: cli
    models:
      - id: demo-model
    responseCommand:
      executable: node
      args: []
      input: request_json_stdin
      output: json_contract
      timeoutMs: 1000
remoteCliTargets:
  - targetId: prod
    host: prod.example.com
    allowedCwds: []
`);

  assert.throws(() => loadProvidersFile(providersPath), /remoteCliTargets/);
});

test("loadRemoteCliTargetsFile keeps target inventory separate from providers", () => {
  const targetsPath = writeTempProvidersFile(`
remoteCliTargets:
  - targetId: remote-prod
    host: remote.example.com
    user: deploy
    allowedCwds:
      - /opt/apps
    defaultCwd: /opt/apps/demo
`);

  const targets = loadRemoteCliTargetsFile(targetsPath);
  assert.equal(targets?.length, 1);
  assert.equal(targets?.[0]?.targetId, "remote-prod");
  assert.equal(targets?.[0]?.defaultCwd, "/opt/apps/demo");
});

test("loadRemoteCliTargetsFile allows an absent optional target inventory", () => {
  assert.equal(loadRemoteCliTargetsFile(path.join(tmpdir(), "missing-targets.yaml")), undefined);
});

test("loadAppConfig defaults remote CLI tool auth to frontend and admin", () => {
  const previous = snapshotEnv();
  try {
    process.env.N8N_API_KEY = "n8n";
    process.env.ADMIN_API_KEY = "admin";
    delete process.env.REMOTE_CLI_TOOL_AUTH_SCOPES;

    const config = loadAppConfig();
    assert.deepEqual([...config.remoteCliToolAuthScopes].sort(), ["admin", "frontend"]);
  } finally {
    restoreEnv(previous);
  }
});

test("loadAppConfig parses explicit remote CLI tool auth scopes", () => {
  const previous = snapshotEnv();
  try {
    process.env.N8N_API_KEY = "n8n";
    process.env.ADMIN_API_KEY = "admin";
    process.env.REMOTE_CLI_TOOL_AUTH_SCOPES = "n8n,frontend,admin";

    const config = loadAppConfig();
    assert.deepEqual([...config.remoteCliToolAuthScopes].sort(), ["admin", "frontend", "n8n"]);
  } finally {
    restoreEnv(previous);
  }
});

test("loadAppConfig parses request timeout", () => {
  const previous = snapshotEnv();
  try {
    process.env.N8N_API_KEY = "n8n";
    process.env.ADMIN_API_KEY = "admin";
    process.env.REQUEST_TIMEOUT_MS = "1200000";

    const config = loadAppConfig();
    assert.equal(config.requestTimeoutMs, 1_200_000);
  } finally {
    restoreEnv(previous);
  }
});

test("loadAppConfig parses auto router benchmark settings", () => {
  const previous = snapshotEnv();
  try {
    process.env.N8N_API_KEY = "n8n";
    process.env.ADMIN_API_KEY = "admin";
    process.env.AUTO_ROUTER_BENCHMARK_ON_START = "false";
    process.env.AUTO_ROUTER_BENCHMARK_TIMEOUT_MS = "5000";
    process.env.AUTO_ROUTER_BENCHMARK_MAX_MODELS = "3";
    process.env.AUTO_ROUTER_BENCHMARK_CONCURRENCY = "2";
    process.env.AUTO_ROUTER_BENCHMARK_INTERVAL_MS = "3600000";
    process.env.AUTO_ROUTER_BENCHMARK_EVALUATE_QUALITY = "false";
    process.env.AUTO_ROUTER_BENCHMARK_EVALUATOR_MODEL = "gpt-5.5";
    process.env.AUTO_ROUTER_BENCHMARK_QUALITY_TIMEOUT_MS = "7000";

    const config = loadAppConfig();
    assert.equal(config.autoRouterBenchmarkOnStart, false);
    assert.equal(config.autoRouterBenchmarkTimeoutMs, 5000);
    assert.equal(config.autoRouterBenchmarkMaxModels, 3);
    assert.equal(config.autoRouterBenchmarkConcurrency, 2);
    assert.equal(config.autoRouterBenchmarkIntervalMs, 3_600_000);
    assert.equal(config.autoRouterBenchmarkEvaluateQuality, false);
    assert.equal(config.autoRouterBenchmarkEvaluatorModel, "gpt-5.5");
    assert.equal(config.autoRouterBenchmarkQualityTimeoutMs, 7000);
  } finally {
    restoreEnv(previous);
  }
});

function writeTempProvidersFile(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gateway-config-test-"));
  const file = path.join(dir, "providers.yaml");
  writeFileSync(file, contents.trimStart(), "utf8");
  return file;
}

function snapshotEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function restoreEnv(previous: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
