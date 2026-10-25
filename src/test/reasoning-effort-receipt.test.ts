import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { openAiRoutes } from "../routes/openai.js";
import { ProviderRegistry } from "../providers/registry.js";
import { CliProvider } from "../providers/cli-provider.js";
import { buildReasoningEffortReceipt, confirmedReasoningEffort, normalizeModelReasoningEffort } from "../utils/reasoning.js";

test("ZZTEST receipt normalization and confirmation", () => {
  for (const effort of ["none", "minimal"] as const) {
    assert.equal(normalizeModelReasoningEffort("openai/gpt-6.1-sol", effort), "low");
    assert.deepEqual(buildReasoningEffortReceipt(effort, "low", "gpt-6.1-sol", "ZZTEST"), {
      requested: effort, forwarded: "low", applied: "unconfirmed", model: "gpt-6.1-sol", providerId: "ZZTEST", normalizedFrom: effort,
    });
  }
  assert.equal(normalizeModelReasoningEffort("o3", "xhigh"), "high");
  assert.equal(normalizeModelReasoningEffort("gpt-6.1-sol", "medium"), "medium");
  assert.equal(buildReasoningEffortReceipt(undefined, "medium", "ZZTEST", "ZZTEST"), undefined);
  assert.equal(confirmedReasoningEffort({ reasoningEffort: "low" }, "low"), true);
  assert.equal(confirmedReasoningEffort({ reasoning_effort: "high" }, "low"), false);
  assert.equal(confirmedReasoningEffort({ output_text: '{"reasoning_effort":"low"}' }, "low"), "unconfirmed");
  assert.equal(buildReasoningEffortReceipt("low", null, "ZZTEST", "ZZTEST", false)?.applied, false);
});

test("ZZTEST Codex contract confirmation survives CLI parsing in both modes", async () => {
  for (const confirmed of [undefined, "low", "high"]) {
    const code = `process.stdin.resume(); process.stdin.on('end', () => {
      const request = JSON.parse(input); const effort = ${JSON.stringify(confirmed) ?? "undefined"};
      const out = request.stream ? {type:'done', output_text:'ZZTEST', finish_reason:'stop', reasoning_effort:effort}
        : {output_text:'ZZTEST', finish_reason:'stop', reasoning_effort:effort};
      process.stdout.write(JSON.stringify(out)+'\\n');
    }); let input=''; process.stdin.on('data', chunk => input+=chunk);`;
    const provider = new CliProvider({ id: "ZZTEST", type: "cli", models: [{ id: "gpt-6.1-sol" }],
      responseCommand: { executable: process.execPath, args: ["-e", code, "dist/scripts/codex-appserver-bridge.js"],
        input: "request_json_stdin", output: "json_contract", timeoutMs: 5000 } });
    const request = { requestId: "ZZTEST", model: "gpt-6.1-sol", providerModel: "gpt-6.1-sol", reasoningEffort: "low" as const,
      requestKind: "chat_completions", messages: [{ role: "user" as const, content: "ZZTEST" }], tools: [] };
    const expected = confirmed === undefined ? "unconfirmed" : confirmed === "low";
    assert.equal((await provider.run(request)).reasoningEffortApplied, expected);
    for await (const event of provider.runStream(request)) assert.equal(event.reasoningEffortApplied, expected);
  }
});

test("ZZTEST plain CLI commands do not claim forwarding an unused effort", async () => {
  const provider = new CliProvider({ id: "ZZTEST", type: "cli", models: [{ id: "ZZTEST" }],
    responseCommand: { executable: process.execPath,
      args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('ZZTEST'));"],
      input: "prompt_stdin", output: "text_plain", timeoutMs: 5000 } });
  const result = await provider.run({ requestId: "ZZTEST", model: "ZZTEST", providerModel: "ZZTEST",
    reasoningEffort: "low", messages: [{ role: "user", content: "ZZTEST" }], tools: [] });
  assert.equal(result.reasoningEffortForwarded, null);
});

test("ZZTEST chat/responses receipts use actual provider dispatch, JSON and streaming", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ZZTEST_RECEIPT_KEY;
  process.env.ZZTEST_RECEIPT_KEY = "ZZTEST";
  let confirmation: string | undefined;
  let nativeStream = false;
  let dispatched: Record<string, unknown> = {};
  globalThis.fetch = (async (_url, init) => {
    dispatched = JSON.parse(String(init?.body));
    if (dispatched.model === "ZZTEST-unavailable") return new Response(JSON.stringify({ error: { code: "model_not_found" } }), { status: 404 });
    const payload = { model: "gpt-6.1-sol", reasoning_effort: confirmation,
      choices: [{ message: { content: "ZZTEST" }, finish_reason: "stop" }] };
    if (nativeStream) return new Response(`data: ${JSON.stringify({ ...payload,
      choices: [{ delta: { content: "ZZTEST" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const registry = await ProviderRegistry.create([{
    id: "ZZTEST", type: "openai", baseUrl: "https://zztest.invalid/v1", apiKeyEnv: "ZZTEST_RECEIPT_KEY",
    models: [{ id: "ZZTEST-alias", providerModel: "gpt-6.1-sol" },
      { id: "ZZTEST-fallback", providerModel: "ZZTEST-unavailable", fallbackModels: ["ZZTEST-alias"] }],
  }]);
  const app = Fastify();
  await app.register(openAiRoutes, { prefix: "/v1", registry, n8nApiKeys: new Set(["ZZTEST"]), defaultReasoningEffort: "medium" });
  try {
    for (const endpoint of ["chat/completions", "responses"]) {
      for (const stream of [false, true]) {
        for (const effortFields of [{}, { reasoning_effort: "none" }, { reasoningEffort: "minimal" }, { reasoning: { effort: "medium" } }]) {
          const hasEffort = Object.keys(effortFields).length > 0;
          const response = await app.inject({ method: "POST", url: `/v1/${endpoint}`, headers: { authorization: "Bearer ZZTEST" },
            payload: { model: "ZZTEST-alias", stream, ...effortFields,
              ...(endpoint === "responses" ? { input: "ZZTEST" } : { messages: [{ role: "user", content: "ZZTEST" }] }) } });
          assert.equal(response.statusCode, 200, response.body);
          const header = response.headers["x-reasoning-effort-receipt"];
          assert.equal(Boolean(header), hasEffort);
          if (hasEffort) {
            const receipt = JSON.parse(String(header));
            assert.equal(receipt.forwarded, dispatched.reasoning_effort);
            assert.equal(receipt.applied, "unconfirmed");
            assert.equal(receipt.model, "ZZTEST-alias");
            assert.equal(receipt.providerId, "ZZTEST");
            if (stream) assert.doesNotMatch(response.body, /reasoning_effort_receipt/);
            else assert.deepEqual(response.json().reasoning_effort_receipt, receipt);
          } else if (!stream) assert.equal(response.json().reasoning_effort_receipt, undefined);
        }
      }
    }
    for (confirmation of ["low", "high"]) {
      const response = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer ZZTEST" },
        payload: { model: "ZZTEST-alias", reasoning_effort: "none", messages: [{ role: "user", content: "ZZTEST" }] } });
      assert.equal(response.json().reasoning_effort_receipt.applied, confirmation === "low");
    }
    nativeStream = true;
    for (const endpoint of ["chat/completions", "responses"]) {
      for (confirmation of [undefined, "low", "high"]) {
        const response = await app.inject({ method: "POST", url: `/v1/${endpoint}`, headers: { authorization: "Bearer ZZTEST" },
          payload: { model: "ZZTEST-alias", stream: true, reasoning_effort: "none",
            ...(endpoint === "responses" ? { input: "ZZTEST" } : { messages: [{ role: "user", content: "ZZTEST" }] }) } });
        assert.equal(response.statusCode, 200, response.body);
        const receipt = JSON.parse(String(response.headers["x-reasoning-effort-receipt"]));
        assert.equal(receipt.applied, confirmation === undefined ? "unconfirmed" : confirmation === "low");
        assert.doesNotMatch(response.body, /reasoning_effort_receipt/);
      }
    }
    nativeStream = false;
    confirmation = undefined;
    const fallback = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer ZZTEST" },
      payload: { model: "ZZTEST-fallback", reasoning_effort: "none", messages: [{ role: "user", content: "ZZTEST" }] } });
    assert.equal(fallback.statusCode, 200, fallback.body);
    assert.deepEqual(fallback.json().reasoning_effort_receipt, {
      requested: "none", forwarded: "low", applied: "unconfirmed", model: "ZZTEST-alias", providerId: "ZZTEST", normalizedFrom: "none",
    });
  } finally {
    await app.close();
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ZZTEST_RECEIPT_KEY;
    else process.env.ZZTEST_RECEIPT_KEY = originalKey;
  }
});
