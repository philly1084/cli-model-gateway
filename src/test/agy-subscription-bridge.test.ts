import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  buildAgyArgv,
  buildAgyPrompt,
  buildLocalLaunch,
  buildSshLaunch,
  completeRequest,
  defaultAgySettings,
  extractJsonObject,
  isTruthyEnv,
  loadAgySubscriptionConfig,
  parseAgyJsonOutput,
  parseBridgeArgs,
  readStatus,
  resolveAgyModel,
  sanitizeDiagnostic,
} from "../scripts/agy-subscription-bridge.js";
import { loadWorkerListenConfig as loadListenConfig } from "../scripts/agy-subscription-worker.js";

test("subscription models and prompts stay narrow", () => {
  assert.equal(resolveAgyModel("gemini-4-neon"), "gemini-4-neon");
  assert.equal(resolveAgyModel("gemini-4-hydrogen"), "gemini-4-hydrogen");
  assert.throws(() => resolveAgyModel("gemini-4-carbon"), /Unsupported/);
  assert.equal(buildAgyPrompt({ prompt: "  Reply with 391 only  " }), "Reply with 391 only");
  assert.equal(
    buildAgyPrompt({ messages: [{ role: "user", content: "Name a color." }] }),
    "USER:\nName a color.",
  );
  assert.throws(() => buildAgyPrompt({ messages: [] }), /empty prompt/);
});

test("agy argv uses print mode, sandbox, and session-only denies", () => {
  const args = buildAgyArgv({
    model: "gemini-4-neon",
    prompt: "Reply with the number 391 only",
    effort: "high",
    settings: defaultAgySettings(),
  });
  assert.deepEqual(args.slice(0, 8), [
    "-p",
    "Reply with the number 391 only",
    "--model",
    "gemini-4-neon",
    "--output-format",
    "json",
    "--print-timeout",
    "10m",
  ]);
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("--effort"));
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  const settingsIndex = args.indexOf("--settings");
  const rawSettings = settingsIndex >= 0 ? args[settingsIndex + 1] : undefined;
  assert.ok(rawSettings);
  const settings = JSON.parse(rawSettings);
  assert.equal(settings.agentMode, "default");
  assert.deepEqual(settings.permissions.deny, ["command", "write_file"]);
});

test("provider stays off unless the enable flag is a truthy value", () => {
  assert.equal(isTruthyEnv(undefined), false);
  assert.equal(isTruthyEnv("false"), false);
  assert.equal(isTruthyEnv("true"), true);
  const disabled = loadAgySubscriptionConfig({ AGY_SUBSCRIPTION_MODE: "http" });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.mode, "http");
  const enabled = loadAgySubscriptionConfig({
    AGY_SUBSCRIPTION_ENABLED: "true",
    AGY_SUBSCRIPTION_MODE: "local",
    AGY_SUBSCRIPTION_EXECUTABLE: "C:\\Users\\phill\\AppData\\Local\\agy\\bin\\agy.exe",
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.mode, "local");
});

test("json envelopes and worker contracts both parse", () => {
  assert.deepEqual(
    parseAgyJsonOutput(JSON.stringify({
      conversation_id: "abc",
      status: "SUCCESS",
      response: "391\n",
      usage: { output_tokens: 1 },
    })),
    { output_text: "391", finish_reason: "stop" },
  );
  assert.deepEqual(
    parseAgyJsonOutput(JSON.stringify({ output_text: "391", finish_reason: "stop" })),
    { output_text: "391", finish_reason: "stop" },
  );
  assert.throws(
    () => parseAgyJsonOutput(JSON.stringify({ status: "ERROR", error: "authentication required" })),
    /authentication required/,
  );
  assert.equal(extractJsonObject("noise\n{\"status\":\"SUCCESS\",\"response\":\"ok\"}\n")?.response, "ok");
});

test("http completion posts to the worker and never requires a local agy binary", async () => {
  const calls: Array<{ url: string; tokenPresent: boolean; body: unknown }> = [];
  const result = await completeRequest(
    loadAgySubscriptionConfig({
      AGY_SUBSCRIPTION_ENABLED: "true",
      AGY_SUBSCRIPTION_MODE: "http",
      AGY_SUBSCRIPTION_URL: "http://100.90.0.2:8787",
      AGY_SUBSCRIPTION_TOKEN: "secret-token",
    }),
    "gemini-4-neon",
    { prompt: "Reply with the number 391 only" },
    {
      fetchFn: async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push({
          url,
          tokenPresent: headers.get("authorization") === "Bearer secret-token",
          body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify({ output_text: "391", finish_reason: "stop" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  assert.deepEqual(result, { output_text: "391", finish_reason: "stop" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://100.90.0.2:8787/v1/complete");
  assert.equal(calls[0]?.tokenPresent, true);
  assert.deepEqual(calls[0]?.body, {
    model: "gemini-4-neon",
    prompt: "Reply with the number 391 only",
    printTimeout: "10m",
  });
});

test("disabled or unauthenticated status fails closed", async () => {
  const disabled = await readStatus(loadAgySubscriptionConfig({}));
  assert.equal(disabled.ok, false);
  const missingUrl = await readStatus(loadAgySubscriptionConfig({
    AGY_SUBSCRIPTION_ENABLED: "true",
    AGY_SUBSCRIPTION_MODE: "http",
    AGY_SUBSCRIPTION_TOKEN: "secret-token",
  }));
  assert.equal(missingUrl.ok, false);
});

test("local and ssh launches keep the prompt in argv rather than a shell string template", () => {
  const local = buildLocalLaunch(
    loadAgySubscriptionConfig({
      AGY_SUBSCRIPTION_ENABLED: "true",
      AGY_SUBSCRIPTION_MODE: "local",
      AGY_SUBSCRIPTION_EXECUTABLE: "agy.exe",
      AGY_SUBSCRIPTION_WORKDIR: "C:\\Users\\phill\\AppData\\Local\\agy\\gateway-workspace",
    }),
    { model: "gemini-4-hydrogen", prompt: "ping" },
  );
  assert.equal(local.executable, "agy.exe");
  assert.equal(local.args[0], "-p");
  assert.equal(local.args[1], "ping");
  const ssh = buildSshLaunch(
    loadAgySubscriptionConfig({
      AGY_SUBSCRIPTION_ENABLED: "true",
      AGY_SUBSCRIPTION_MODE: "ssh",
      AGY_SUBSCRIPTION_SSH_HOST: "100.90.0.2",
      AGY_SUBSCRIPTION_SSH_USER: "phill",
      AGY_SUBSCRIPTION_EXECUTABLE: "C:\\Users\\phill\\AppData\\Local\\agy\\bin\\agy.exe",
    }),
    { model: "gemini-4-neon", prompt: "ping" },
  );
  assert.equal(ssh.executable, "ssh");
  assert.ok(ssh.args.includes("phill@100.90.0.2"));
  assert.ok(ssh.args.at(-1)?.includes("agy.exe"));
});

test("diagnostics redact bearer tokens", () => {
  assert.equal(
    sanitizeDiagnostic("stderr: Bearer super-secret-token failed"),
    "stderr: Bearer [redacted] failed",
  );
});

test("worker refuses wildcard binds and missing tokens", () => {
  assert.throws(
    () => loadListenConfig({ AGY_SUBSCRIPTION_TOKEN: "secret", AGY_SUBSCRIPTION_BIND: "0.0.0.0" }),
    /wildcard/,
  );
  assert.throws(() => loadListenConfig({}), /TOKEN is required/);
  const config = loadListenConfig({
    AGY_SUBSCRIPTION_TOKEN: "secret",
    AGY_SUBSCRIPTION_BIND: "100.90.0.2",
    AGY_SUBSCRIPTION_PORT: "8787",
  });
  assert.equal(config.bind, "100.90.0.2");
  assert.equal(config.port, 8787);
});

test("parseBridgeArgs understands status and model flags", () => {
  assert.deepEqual(parseBridgeArgs(["--status"]), { model: "", status: true });
  assert.deepEqual(parseBridgeArgs(["--model", "gemini-4-neon"]), { model: "gemini-4-neon", status: false });
});
