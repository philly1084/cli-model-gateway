import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { Writable } from "node:stream";
import { CliProvider } from "../providers/cli-provider.js";
import { ProviderRegistry } from "../providers/registry.js";
import { UpstreamError } from "../utils/upstream-error.js";
import { openAiRoutes } from "../routes/openai.js";
import type { CliProviderConfig, UnifiedRequest } from "../types.js";

const exactError = `ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account."}}`;
const request = { requestId: "unsupported-fixture", messages: [{ role: "user" as const, content: "Hello" }], tools: [] };
function config(script: string, models: CliProviderConfig["models"] = [{ id: "gpt-5.5" }]): CliProviderConfig {
  return { id: "codex-cli", type: "cli", models, responseCommand: {
    executable: process.execPath, args: ["-e", script], input: "request_json_stdin", output: "json_contract", timeoutMs: 15000,
  } };
}
const fullRequest: UnifiedRequest = { ...request, model: "gpt-5.5", providerModel: "gpt-5.5" };

for (const streamed of [false, true]) for (const stream of ["stderr", "stdout"] as const) {
  test(`CLI rejects the exact Codex error promptly in split ${stream} (stream=${streamed})`, async () => {
    const provider = new CliProvider(config(`const s=${JSON.stringify(exactError)}; process.${stream}.write(s.slice(0, 45)); setTimeout(()=>process.${stream}.write(s.slice(45)),20); setInterval(()=>{},1000);`));
    provider.supportsStreaming = () => true;
    const started = Date.now();
    const run = async () => {
      if (streamed) { for await (const _ of provider.runStream(fullRequest)) assert.fail("error must not yield content"); }
      else await provider.run(fullRequest);
    };
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof UpstreamError);
      assert.equal(error.code, "model_unavailable");
      assert.equal(error.status, 400);
      assert.equal(error.upstreamCode, "invalid_request_error");
      assert.doesNotMatch(error.message, /ChatGPT|gpt-5.5/);
      return true;
    });
    assert.ok(Date.now() - started < 5000, "must terminate before the 15-second CLI timeout");
  });
}

for (const diagnostic of [
  `ERROR: model gpt-5.4-mini not supported for this account`,
  `The 'gpt-5.4' model is not supported for this account`,
  `ERROR: {"status":404,"error":{"code":"model_not_found","message":"synthetic private content"}}`,
]) test(`CLI recognizes unavailable diagnostic ${diagnostic.slice(0, 35)}`, async () => {
  const provider = new CliProvider(config(`process.stderr.write(${JSON.stringify(diagnostic)}); setInterval(()=>{},1000);`));
  await assert.rejects(provider.run({ ...fullRequest, signal: new AbortController().signal }), (error: unknown) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.code, "model_unavailable");
    assert.equal(error.status, diagnostic.includes("404") ? 404 : 400);
    assert.doesNotMatch(error.message, /synthetic private content/);
    return true;
  });
});

test("ordinary assistant text mentioning unsupported models is not a CLI failure", async () => {
  const text = "The model is not supported; choose another model.";
  const provider = new CliProvider(config(`process.stdout.write(${JSON.stringify(JSON.stringify({ output_text: text }))});`));
  assert.equal((await provider.run(fullRequest)).outputText, text);
});

async function fixture(fallbackModels = ["gpt-5.4"]) {
  // Every rejected model runs a local mock CLI; the healthy adapter is also mocked.
  const registry = await ProviderRegistry.create([
    config(`process.stderr.write(${JSON.stringify(exactError + "\n")}); setInterval(()=>{},1000);`, [
      { id: "gpt-5.5", fallbackModels },
      { id: "gpt-5.4", fallbackModels: ["gpt-5.5"] },
    ]),
    { ...config("", [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }]), id: "healthy-cli" },
  ]);
  registry.getProvider("codex-cli")!.supportsStreaming = () => true;
  const calls: string[] = [];
  registry.getProvider("healthy-cli")!.supportsStreaming = () => false;
  registry.getProvider("healthy-cli")!.run = async input => {
    calls.push(input.model);
    return { outputText: "healthy answer", toolCalls: [], finishReason: "stop" };
  };
  return { registry, calls };
}

for (const streamed of [false, true]) test(`configured recovery precedes auto's default (stream=${streamed})`, async () => {
  const { registry, calls } = await fixture(["gpt-5.4", "gpt-6-luna"]);
  if (streamed) { for await (const _ of registry.runModelStream("gpt-5.5", request)) { /* drain */ } }
  else await registry.runModel("gpt-5.5", request);
  assert.deepEqual(calls, ["gpt-6-luna"]);
});

for (const streamed of [false, true]) test(`Brain route exhausts Codex chain then uses auto's healthy choice once (stream=${streamed})`, async () => {
  const { registry, calls } = await fixture();
  const catalog = registry.listModels();
  let autoModel: string | undefined;
  const logs: Record<string, unknown>[] = [];
  const app = Fastify({ logger: { level: "info", stream: new Writable({ write(value, _encoding, done) { logs.push(JSON.parse(String(value))); done(); } }) } });
  await app.register(openAiRoutes, { prefix: "/v1", registry, n8nApiKeys: new Set(["fixture"]) });
  try {
    for (let i = 0; i < 2; i++) {
      const reply = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer fixture" },
        payload: { model: "gpt-5.5", stream: streamed, messages: request.messages } });
      assert.equal(reply.statusCode, 200);
      if (streamed) {
        assert.match(reply.body, /healthy answer/);
        assert.match(reply.body, /data: \[DONE\]/);
        assert.doesNotMatch(reply.body, /upstream_stream_failed/);
      } else assert.equal(reply.json().choices[0].message.content, "healthy answer");
      if (i === 0) {
        autoModel = (await registry.runModel("auto", request)).resolvedModel;
        calls.pop();
      }
    }
    assert.deepEqual(calls, [autoModel, autoModel]);
    for (const model of ["gpt-5.5", "gpt-5.4"]) {
      const stat = registry.getModelStatsById(model)!;
      assert.equal(stat.attempts, 1, "second request must skip cooldown models");
      assert.equal(stat.lastFailureKind, "model_unavailable");
      assert.ok(stat.suggestedCooldownSeconds > 0);
    }
    assert.deepEqual(registry.listModels(), catalog);
    assert.ok(logs.some(log => log.upstreamStatus === 400 && log.errorCode === "model_unavailable"));
    assert.doesNotMatch(JSON.stringify(logs), /ChatGPT account|invalid_request_error.*message/);
  } finally { await app.close(); }
});

for (const streamed of [false, true]) for (const allowFallback of [false, true]) {
  test(`fallback policy stops both configured and emergency attempts (stream=${streamed}, allowFallback=${allowFallback})`, async () => {
    const { registry, calls } = await fixture();
    const input = { ...request, metadata: { gateway_policy: { operationId: "policy", allowFallback, maxAttempts: allowFallback ? 1 : 8, maxLatencyMs: 10000 } } };
    await assert.rejects(async () => {
      if (streamed) { for await (const _ of registry.runModelStream("gpt-5.5", input)) assert.fail(); }
      else await registry.runModel("gpt-5.5", input);
    }, /model_unavailable/);
    assert.deepEqual(calls, []);
    assert.equal(registry.getModelStatsById("gpt-5.4")!.attempts, 0);
  });
}

for (const streamed of [false, true]) test(`emergency recovery has one attempt (stream=${streamed})`, async () => {
  const { registry, calls } = await fixture();
  registry.getProvider("healthy-cli")!.run = async input => { calls.push(input.model); throw new UpstreamError(503); };
  await assert.rejects(async () => {
    if (streamed) { for await (const _ of registry.runModelStream("gpt-5.5", request)) assert.fail(); }
    else await registry.runModel("gpt-5.5", request);
  });
  assert.equal(calls.length, 1);
});

test("partial CLI output and stateful requests never reach emergency recovery", async () => {
  const { registry, calls } = await fixture();
  registry.getProvider("codex-cli")!.runStream = async function* () {
    yield { type: "output_text_delta", delta: "partial" };
    throw new UpstreamError(404);
  };
  const events = [];
  await assert.rejects(async () => { for await (const event of registry.runModelStream("gpt-5.5", request)) events.push(event); });
  assert.equal(events.length, 1);
  assert.deepEqual(calls, []);
  const stateful = await fixture();
  await assert.rejects(stateful.registry.runModel("gpt-5.5", { ...request, metadata: { sessionId: "synthetic" } }));
  assert.deepEqual(stateful.calls, []);
});

