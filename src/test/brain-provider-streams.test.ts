import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { Writable } from "node:stream";
import { ProviderRegistry } from "../providers/registry.js";
import { openAiRoutes } from "../routes/openai.js";
import { installRequestCompletionLogging } from "../utils/request-completion.js";
import type { ExecutionReceipt } from "../utils/execution-policy.js";
import type { UnifiedRequest } from "../types.js";

const sse = (value: unknown) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\r\n\r\n`;
const chunk = (content: string, finish_reason: string | null = null) => ({ model: "upstream", choices: [{ index: 0, delta: { content }, finish_reason }] });
const stream = (source = sse(chunk("answer", "stop")) + sse("[DONE]")) => {
  const bytes = new TextEncoder().encode(source);
  let offset = 0;
  return new Response(new ReadableStream({ pull(c) {
    if (offset === bytes.length) { c.close(); return; }
    c.enqueue(bytes.slice(offset, offset = Math.min(offset + 3, bytes.length)));
  } }), { headers: { "content-type": "text/event-stream" } });
};
const buffered = () => new Response(JSON.stringify({ choices: [{ message: { content: "answer", extra_content: { google: { thought_signature: "opaque" } } }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
const messages: UnifiedRequest["messages"] = [{ role: "system", content: "Be helpful" }, { role: "user", content: "Hello" }];

async function fixture(upstream: typeof fetch, baseUrl = "https://openrouter.invalid/api/v1") {
  const original = globalThis.fetch;
  globalThis.fetch = upstream;
  // Use an existing synthetic environment value, restoring it after every test.
  const previous = process.env.BRAIN_STREAM_FIXTURE;
  process.env.BRAIN_STREAM_FIXTURE = "synthetic";
  const registry = await ProviderRegistry.create([
    { id: "api", type: "openai", baseUrl, apiKeyEnv: "BRAIN_STREAM_FIXTURE", discovery: { enabled: false }, models: [{ id: "chosen", fallbackModels: ["same-provider", "gpt-5.6-luna"] }, { id: "same-provider", fallbackModels: ["gpt-5.6-luna"] }] },
    { id: "codex-fixture", type: "cli", models: [{ id: "gpt-5.6-luna" }], responseCommand: { executable: process.execPath, args: [], timeoutMs: 1000, input: "request_json_stdin", output: "json_contract" } },
  ]);
  let fallbackCalls = 0;
  const fallback = registry.getProvider("codex-fixture")!;
  fallback.supportsStreaming = () => false;
  fallback.run = async () => { fallbackCalls++; return { outputText: "fallback answer", toolCalls: [], finishReason: "stop" }; };
  const logs: Record<string, unknown>[] = [];
  const app = Fastify({ disableRequestLogging: true, logger: { level: "info", stream: new Writable({ write(value, _encoding, done) { logs.push(JSON.parse(String(value))); done(); } }) } });
  installRequestCompletionLogging(app);
  await app.register(openAiRoutes, { prefix: "/v1", registry, n8nApiKeys: new Set(["fixture"]) });
  return { registry, logs, fallbackCalls: () => fallbackCalls,
    inject: (extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer fixture" }, payload: { model: "chosen", stream: true, max_tokens: 4096, messages, ...extra } }),
    close: async () => { await app.close(); globalThis.fetch = original; if (previous === undefined) delete process.env.BRAIN_STREAM_FIXTURE; else process.env.BRAIN_STREAM_FIXTURE = previous; },
  };
}

function brainText(body: string): string {
  const lines = body.split("\n").filter(line => line.startsWith("data:"));
  assert.equal(lines.at(-1)?.trim(), "data: [DONE]");
  return lines.slice(0, -1).map(line => {
    const event = JSON.parse(line.slice(5));
    assert.equal(event.error, undefined);
    assert.equal(["error", "length", "tool_calls"].includes(event.choices?.[0]?.finish_reason), false);
    return event.choices?.[0]?.delta?.content ?? "";
  }).join("");
}

test("Brain OpenRouter SSE ignores vendor extensions, keepalives and empty/usage chunks", async () => {
  const source = ': OPENROUTER PROCESSING\r\n\r\n' + sse({ choices: [] })
    + sse({ ...chunk("Hello "), provider: "OpenInference", choices: [{ index: 0, delta: { role: "assistant", content: "Hello ", reasoning: { opaque: true }, reasoning_details: [{ type: "ignored" }], extra_content: {} }, finish_reason: null }] })
    + ': keepalive\r\n\r\n' + sse({ ...chunk("world", "stop"), native_finish_reason: "completed" })
    + sse({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }) + 'data: [DONE]';
  const f = await fixture((async () => stream(source)) as typeof fetch);
  try { const reply = await f.inject(); assert.equal(brainText(reply.body), "Hello world"); assert.doesNotMatch(reply.body, /reasoning_details|opaque|OpenInference/); assert.equal(f.fallbackCalls(), 0); }
  finally { await f.close(); }
});

for (const base of ["https://generativelanguage.googleapis.com/v1beta/openai", "https://api.deepseek.com/v1", "https://api.moonshot.ai/v1"]) {
  for (const json of [false, true]) test(`Brain parses ${base} ${json ? "buffered JSON" : "SSE"} upstream`, async () => {
    const f = await fixture((async () => json ? buffered() : stream()) as typeof fetch, base);
    try {
      assert.equal(brainText((await f.inject()).body), "answer");
      if (json) assert.equal((await f.inject({ stream: false })).json().choices[0].message.content, "answer");
    } finally { await f.close(); }
  });
}

for (const streamed of [false, true]) for (const status of [401, 403, 404, 429, 503]) {
  test(`Brain ${streamed ? "streamed" : "buffered"} HTTP ${status} classifies and recovers before output`, async () => {
    const seen: string[] = [];
    const f = await fixture((async (_url, init) => {
      const body = JSON.parse(String(init?.body)); seen.push(body.model);
      assert.equal(body.max_tokens, 4096);
      return new Response(JSON.stringify([{ error: { code: status, status: status === 503 ? "UNAVAILABLE" : "UNKNOWN", message: "sensitive upstream text" } }]), { status });
    }) as typeof fetch);
    try {
      const reply = await f.inject({ stream: streamed });
      assert.equal(reply.statusCode, 200);
      assert.equal(streamed ? brainText(reply.body) : reply.json().choices[0].message.content, "fallback answer");
      assert.deepEqual(seen, status === 401 || status === 403 ? ["chosen"] : status === 429 || status === 503 ? ["chosen", "chosen", "same-provider", "same-provider"] : ["chosen", "same-provider"]);
      const failure = f.logs.find(log => log.msg === "Upstream request failed");
      assert.equal(failure?.upstreamStatus, status);
      assert.equal(failure?.errorCode, status < 404 ? "auth" : status === 404 ? "model_unavailable" : status === 429 ? "rate_limited" : "capacity_exhausted");
      assert.doesNotMatch(JSON.stringify(f.logs), /sensitive upstream text|synthetic/);
    } finally { await f.close(); }
  });
}

test("Brain transient retry can succeed without substituting the model", async () => {
  let count = 0;
  const f = await fixture((async () => ++count === 1 ? new Response('[{"error":{"status":"UNAVAILABLE"}}]', { status: 503 }) : stream()) as typeof fetch);
  try { assert.equal(brainText((await f.inject()).body), "answer"); assert.equal(count, 2); assert.equal(f.fallbackCalls(), 0); }
  finally { await f.close(); }
});

for (const partial of [false, true]) test(`OpenRouter error chunk is terminal and sanitized (partial=${partial})`, async () => {
  let count = 0;
  const source = (partial ? sse(chunk("partial")) : "") + sse({ error: { code: 401, message: "sensitive upstream text" }, choices: [{ finish_reason: "error" }] });
  const f = await fixture((async () => { count++; return stream(source); }) as typeof fetch);
  try {
    const reply = await f.inject();
    if (partial) { assert.match(reply.body, /"code":"auth"/); assert.doesNotMatch(reply.body, /\[DONE\]|sensitive upstream text/); assert.equal(f.fallbackCalls(), 0); }
    else { assert.equal(brainText(reply.body), "fallback answer"); assert.equal(f.fallbackCalls(), 1); }
    assert.equal(count, 1);
  } finally { await f.close(); }
});

for (const state of [{ tools: [{ type: "function", function: { name: "calculate", parameters: { type: "object" } } }] }, { metadata: { session_id: "fixture-session" } }]) {
  test(`stateful/tool chat never automatically replays (${Object.keys(state)})`, async () => {
    let count = 0;
    const f = await fixture((async () => { count++; return new Response('', { status: 503 }); }) as typeof fetch);
    try { const reply = await f.inject(state); assert.doesNotMatch(reply.body, /\[DONE\]/); assert.equal(count, 1); assert.equal(f.fallbackCalls(), 0); }
    finally { await f.close(); }
  });
}

test("stream retry/fallback obeys attempt budgets and records one terminal receipt", async () => {
  let count = 0;
  const f = await fixture((async () => { count++; return new Response('', { status: 503 }); }) as typeof fetch);
  try {
    const receipts: ExecutionReceipt[] = [];
    await assert.rejects(async () => { for await (const _ of f.registry.runModelStream("chosen", { requestId: "budget", messages, tools: [], receipt: r => receipts.push(r), metadata: { gateway_policy: { operationId: "budget", allowFallback: true, maxAttempts: 1, maxLatencyMs: 1000 } } })) { /* consume */ } });
    assert.equal(count, 1); assert.equal(f.fallbackCalls(), 0);
    assert.equal(receipts.filter(r => r.type === "gateway.execution.terminal").length, 1);
  } finally { await f.close(); }
});

test("stream transport loss stays uncertain and is not replayed", async () => {
  let count = 0;
  const f = await fixture((async () => { count++; throw TypeError("mock connection lost"); }) as typeof fetch);
  try { const reply = await f.inject(); assert.doesNotMatch(reply.body, /\[DONE\]/); assert.equal(count, 1); assert.equal(f.fallbackCalls(), 0); }
  finally { await f.close(); }
});

for (const ending of ["", sse({ choices: [{ delta: {}, finish_reason: "error" }] }), 'event: error\ndata: {"error":{"code":503}}\n\n']) {
  test(`partial upstream ${ending ? "terminal error" : "truncation"} never becomes a completed chat`, async () => {
    let count = 0;
    const f = await fixture((async () => { count++; return stream(sse(chunk("partial")) + ending); }) as typeof fetch);
    try { const reply = await f.inject(); assert.match(reply.body, /"error":/); assert.doesNotMatch(reply.body, /\[DONE\]/); assert.equal(count, 1); assert.equal(f.fallbackCalls(), 0); }
    finally { await f.close(); }
  });
}

test("length finish remains visible to Brain rather than becoming a false success", async () => {
  const f = await fixture((async () => stream(sse(chunk("truncated", "length")) + sse("[DONE]"))) as typeof fetch);
  try { assert.match((await f.inject()).body, /"finish_reason":"length"/); assert.equal(f.fallbackCalls(), 0); }
  finally { await f.close(); }
});
