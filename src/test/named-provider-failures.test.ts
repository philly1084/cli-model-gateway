import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { Writable } from "node:stream";
import { ProviderRegistry } from "../providers/registry.js";
import { openAiRoutes } from "../routes/openai.js";
import { installRequestCompletionLogging } from "../utils/request-completion.js";
import { safeFinishReason } from "../utils/provider-failure.js";

const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {}, additionalProperties: false } } }];
const call = { id: "call_lookup", type: "function", function: { name: "lookup", arguments: "{}" } };
const completion = (content: string | null, finish_reason = "stop", tool_calls?: unknown[]) => new Response(JSON.stringify({
  model: "deepseek-v4-pro", choices: [{ message: { role: "assistant", content, tool_calls }, finish_reason }],
  usage: { prompt_tokens: 31, completion_tokens: 47 },
}));
async function fixture(fetcher: typeof fetch, timeoutMs = 1000, baseUrl = "https://api.deepseek.com/v1") {
  const original = globalThis.fetch, previous = process.env.NAMED_FAILURE_FIXTURE;
  globalThis.fetch = fetcher; process.env.NAMED_FAILURE_FIXTURE = "synthetic";
  const registry = await ProviderRegistry.create([{ id: "deepseek-api", type: "openai", baseUrl,
    apiKeyEnv: "NAMED_FAILURE_FIXTURE", timeoutMs, discovery: { enabled: false }, models: [{ id: "deepseek-v4-pro", capabilities: ["chat", "tools"] }] }]);
  const logs: Record<string, unknown>[] = [];
  const app = Fastify({ disableRequestLogging: true, logger: { stream: new Writable({ write(data, _encoding, next) { logs.push(JSON.parse(String(data))); next(); } }) } });
  installRequestCompletionLogging(app);
  await app.register(openAiRoutes, { prefix: "/v1", registry, n8nApiKeys: new Set(["fixture"]) });
  return { logs, inject: (extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer fixture" },
    payload: { model: "deepseek-v4-pro", messages: [{ role: "user", content: "PRIVATE_CONTENT_MUST_NOT_BE_LOGGED" }], max_tokens: 16000,
      gateway_policy: { operationId: "named-failure-operation", allowFallback: false, maxAttempts: 1, maxLatencyMs: 10000 }, ...extra } }),
    close: async () => { await app.close(); globalThis.fetch = original; if (previous === undefined) delete process.env.NAMED_FAILURE_FIXTURE; else process.env.NAMED_FAILURE_FIXTURE = previous; } };
}

for (const row of [
  { name: "empty", response: () => completion(null), code: "empty_completion", finish: "stop" },
  { name: "truncated text", response: () => completion("PRIVATE_PARTIAL_OUTPUT", "length"), code: "output_truncated", finish: "length" },
  { name: "truncated tool arguments", response: () => completion(null, "length", [{ ...call, function: { name: "lookup", arguments: '{"broken":' } }]), code: "output_truncated", finish: "length" },
]) test(`named failure for ${row.name} has one content-free correlated receipt`, async () => {
  const f = await fixture(async () => row.response());
  try {
    const response = await f.inject({ tools, thinking: "disabled" });
    assert.equal(response.statusCode, 502); assert.equal(response.json().error.code, row.code);
    const failures = f.logs.filter(x => x.type === "gateway.request.failure/v1"); assert.equal(failures.length, 1);
    assert.deepEqual(Object.fromEntries(["operationId", "provider", "model", "finish_reason", "prompt_tokens", "completion_tokens", "code", "httpStatus"].map(k => [k, failures[0]?.[k]])), {
      operationId: "named-failure-operation", provider: "deepseek-api", model: "deepseek-v4-pro", finish_reason: row.finish, prompt_tokens: 31, completion_tokens: 47, code: row.code, httpStatus: 502 });
    assert.equal(typeof failures[0]?.latencyMs, "number"); assert.equal(typeof failures[0]?.reqId, "string");
    assert.doesNotMatch(JSON.stringify(f.logs)+response.body, /PRIVATE_CONTENT|PRIVATE_PARTIAL|broken/);
  } finally { await f.close(); }
});

test("provider timer and broken fetch/body return safe distinct uncertain failures", async () => {
  const cases: Array<{ fetcher: typeof fetch; code: string; status: number }> = [
    { fetcher: async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("PRIVATE_TIMEOUT", "AbortError")), { once: true })), code: "upstream_timeout", status: 504 },
    { fetcher: async () => { throw new TypeError("PRIVATE_FETCH_BODY"); }, code: "upstream_transport", status: 502 },
    { fetcher: async () => new Response(new ReadableStream({ start(c) { c.error(new TypeError("PRIVATE_TERMINATED")); } })), code: "upstream_transport", status: 502 },
  ];
  for (const row of cases) {
    let calls = 0; const f = await fixture(async (...args) => { calls++; return row.fetcher(...args); }, 10);
    try {
      const response = await f.inject(); assert.equal(response.statusCode, row.status); assert.equal(response.json().error.code, row.code); assert.equal(calls, 1);
      const failures = f.logs.filter(x => x.type === "gateway.request.failure/v1"); assert.equal(failures.length, 1); assert.equal(failures[0]?.code, row.code);
      assert.doesNotMatch(JSON.stringify(f.logs)+response.body, /PRIVATE_/);
    } finally { await f.close(); }
  }
});

for (const thinking of ["disabled", { type: "disabled" }]) test(`DeepSeek continuation without stored reasoning works with ${JSON.stringify(thinking)}`, async () => {
  const bodies: Record<string, unknown>[] = [];
  const f = await fixture(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return bodies.length === 1 ? completion(null, "tool_calls", [call]) : completion("observed result"); });
  try {
    const first = await f.inject({ tools, thinking }); assert.equal(first.statusCode, 200);
    const second = await f.inject({ tools, thinking, messages: [{ role: "user", content: "look up" }, first.json().choices[0].message, { role: "tool", tool_call_id: "call_lookup", content: "observed result" }] });
    assert.equal(second.statusCode, 200); assert.equal(second.json().choices[0].message.content, "observed result");
    assert.equal(bodies.length, 2); assert.ok(bodies.every(b => b.max_tokens === 16000)); assert.ok(bodies.every(b => JSON.stringify(b.thinking) === '{"type":"disabled"}'));
    assert.doesNotMatch(JSON.stringify(bodies), /reasoning_content/); assert.equal(f.logs.filter(x => x.type === "gateway.request.failure/v1").length, 0);
  } finally { await f.close(); }
});

test("thinking continuation without reasoning is a named400 without dispatch", async () => {
  let calls = 0; const f = await fixture(async () => { calls++; return completion("unexpected"); });
  try {
    const response = await f.inject({ tools, thinking: { type: "enabled" }, messages: [{ role: "user", content: "look up" }, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: "call_lookup", content: "result" }] });
    assert.equal(response.statusCode, 400); assert.equal(response.json().error.code, "reasoning_content_required"); assert.equal(calls, 0);
    assert.equal(f.logs.filter(x => x.type === "gateway.request.failure/v1").length, 1);
  } finally { await f.close(); }
});

test("finish reasons are closed and content filter remains a valid terminal", async () => {
  assert.equal(safeFinishReason(undefined), "absent"); assert.equal(safeFinishReason("PRIVATE_REASON"), "other");
  const f = await fixture(async () => completion(null, "content_filter"));
  try { assert.equal((await f.inject()).statusCode, 200); } finally { await f.close(); }
});

test("Anthropic reasoning-only output and exhausted budget have named content-free errors", async () => {
  for (const stop_reason of ["end_turn", "max_tokens"]) {
    const f=await fixture(async()=>new Response(JSON.stringify({model:"deepseek-v4-pro",stop_reason,content:[{type:"thinking",thinking:"PRIVATE_REASONING"}],usage:{input_tokens:11,output_tokens:4096}})),1000,"https://api.kimi.com/coding/v1");
    try {
      const response=await f.inject();assert.equal(response.statusCode,502);assert.equal(response.json().error.code,stop_reason==='max_tokens'?'output_truncated':'empty_completion');
      const failure=f.logs.find(x=>x.type==='gateway.request.failure/v1');assert.equal(failure?.completion_tokens,4096);assert.doesNotMatch(JSON.stringify(f.logs)+response.body,/PRIVATE_REASONING/);
    } finally {await f.close();}
  }
});
