import test from "node:test";
import assert from "node:assert/strict";
import { readOutputLimit, kimiOutputEnvironment } from "../utils/output-limit.js";
import { OpenAiCompatibleProvider } from "../providers/openai-compatible-provider.js";
import type { UnifiedRequest } from "../types";
import { chatCompletionsRequestSchema, responsesRequestSchema } from "../validation.js";
import { ExecutionPolicy } from "../utils/execution-policy.js";

test("invalid limits fail at both public schemas and internal execution before fallback or dispatch", () => {
  for (const metadata of [{ max_tokens: 128, max_output_tokens: 512 }, { max_output_tokens: 0 }, { max_completion_tokens: "512" }]) {
    assert.equal(chatCompletionsRequestSchema.safeParse({ model: "fixture", messages: [{ role: "user", content: "x" }], ...metadata }).success, false);
    assert.equal(responsesRequestSchema.safeParse({ model: "fixture", input: "x", ...metadata }).success, false);
    let receipts = 0;
    assert.throws(() => new ExecutionPolicy({ metadata, requestId: "fixture", model: "fixture", receipt: () => receipts++ }));
    assert.equal(receipts, 0);
  }
});

test("output ceilings reject invalid/conflicting aliases rather than silently using defaults", () => {
  assert.equal(readOutputLimit(), undefined);
  for (const key of ["max_tokens", "max_output_tokens", "max_completion_tokens"]) {
    for (const value of [0, -1, 1.5, "512", null, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => readOutputLimit({ [key]: value }), /positive safe integer/);
    }
    assert.equal(readOutputLimit({ [key]: 512 }), 512);
  }
  assert.equal(readOutputLimit({ max_tokens: 512, max_output_tokens: 512 }), 512);
  assert.throws(() => readOutputLimit({ max_tokens: 128, max_output_tokens: 512 }), /Conflicting/);
});

test("Kimi 1.52 generation cap is request scoped and preserves stricter inherited limits", () => {
  const inherited = { KIMI_MODEL_MAX_COMPLETION_TOKENS: "256", KIMI_MODEL_MAX_TOKENS: "128", FIXTURE: "unchanged" };
  const env = kimiOutputEnvironment({ max_output_tokens: 512 }, inherited);
  assert.equal(env.KIMI_MODEL_MAX_COMPLETION_TOKENS, "128");
  assert.equal(inherited.KIMI_MODEL_MAX_COMPLETION_TOKENS, "256");
  assert.equal(env.FIXTURE, "unchanged");
  assert.deepEqual(kimiOutputEnvironment(undefined, inherited), inherited);
  assert.equal(kimiOutputEnvironment({ max_tokens: 512 }, {}).KIMI_MODEL_MAX_COMPLETION_TOKENS, "512");
  assert.equal(kimiOutputEnvironment({ max_tokens: 512 }, { KIMI_MODEL_MAX_COMPLETION_TOKENS: "0" }).KIMI_MODEL_MAX_COMPLETION_TOKENS, "512");
  assert.throws(() => kimiOutputEnvironment({ max_tokens: 512, max_output_tokens: 1024 }, inherited), /Conflicting/);
});

for (const profile of ["generic", "gemini", "moonshot", "kimi-code"] as const) {
  for (const stream of (profile === "kimi-code" ? [false] : [false, true])) test(`${profile} ${stream ? "stream" : "buffered"} forwards validated output ceilings before fetch`, async () => {
    const oldFetch = globalThis.fetch, oldKey = process.env.OUTPUT_LIMIT_FIXTURE_KEY;
    process.env.OUTPUT_LIMIT_FIXTURE_KEY = "synthetic";
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      if (profile === "kimi-code") return Response.json({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
      const result = { choices: [{ message: { content: "ok" }, delta: { content: "ok" }, finish_reason: "stop" }] };
      return body.stream ? new Response(`data: ${JSON.stringify(result)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }) : Response.json(result);
    }) as typeof fetch;
    try {
      const baseUrl = { generic: "https://example.invalid/v1", gemini: "https://generativelanguage.googleapis.com/v1beta/openai", moonshot: "https://api.moonshot.ai/v1", "kimi-code": "https://api.kimi.com/coding/v1" }[profile];
      const provider = await OpenAiCompatibleProvider.create({ id: "fixture", type: "openai", baseUrl, apiKeyEnv: "OUTPUT_LIMIT_FIXTURE_KEY", models: [{ id: "fixture" }] });
      const request: UnifiedRequest = { requestId: "fixture", model: "fixture", providerModel: profile === "moonshot" ? "kimi-k2.6" : "fixture", messages: [{ role: "user", content: "fixture" }], tools: [] };
      const run = async (metadata: Record<string, unknown>) => {
        if (stream) { for await (const _ of provider.runStream({ ...request, metadata })) { /* consume */ } }
        else await provider.run({ ...request, metadata });
      };
      for (const key of ["max_tokens", "max_output_tokens", "max_completion_tokens"]) {
        await run({ [key]: 512 });
        const wireKey = profile !== "kimi-code" && key === "max_completion_tokens" ? key : "max_tokens";
        assert.equal(bodies.at(-1)?.[wireKey], 512);
        assert.equal(bodies.at(-1)?.max_output_tokens, undefined);
      }
      for (const metadata of [{ max_tokens: 128, max_output_tokens: 512 }, { max_output_tokens: 0 }, { max_completion_tokens: "512" }]) {
        const before = bodies.length;
        await assert.rejects(run(metadata)); assert.equal(bodies.length, before, "invalid budget must never reach provider fetch");
      }
    } finally {
      globalThis.fetch = oldFetch;
      if (oldKey === undefined) delete process.env.OUTPUT_LIMIT_FIXTURE_KEY; else process.env.OUTPUT_LIMIT_FIXTURE_KEY = oldKey;
    }
  });
}
