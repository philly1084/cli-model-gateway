import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import YAML from "yaml";
import { loadProvidersFile } from "../config.js";
import { loadProviderProfiles, providerProfileSchema, resolveProviderProfile, prepareProfileRequest } from "../provider-profiles.js";
import { ProviderRegistry } from "../providers/registry.js";
import { openAiRoutes } from "../routes/openai.js";
import { ContentNormalizer, normalizeContent, normalizeFinishReason, stripProviderFields, completeUsage } from "../utils/output-normalization.js";
import type { ProviderConfig, UnifiedRequest } from "../types.js";

const profiles = loadProviderProfiles();
const messages: UnifiedRequest["messages"] = [{ role: "system", content: "Use uppercase" }, { role: "user", content: "ZZTEST pong" }];
const data = (value: unknown) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
const chunk = (delta: unknown, finish_reason: string | null = null) => ({ model: "chosen", provider: "vendor", service_tier: null,
  choices: [{ index: 0, delta, finish_reason, native_finish_reason: finish_reason }] });
const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
const events = (body: string): any[] => body.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)));

function config(id: string): ProviderConfig {
  const profile = profiles.get(id)!;
  const common = { id, type: profile.type, profile: id, models: [{ id: "chosen" }] };
  return profile.type === "cli" ? { ...common, type: "cli", responseCommand: {
    executable: process.execPath, args: ["-e", `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const r=JSON.parse(input);const result={output_text:'<think>hidden</think>PONG',reasoning_content:'hidden',finish_reason:'stop'};process.stdout.write(JSON.stringify(r.stream?{type:'done',...result}:result)+'\\n')})`],
    input: "request_json_stdin", output: "json_contract", timeoutMs: 5000,
  } } : { ...common, type: "openai", baseUrl: profile.baseUrl!, apiKeyEnv: "PATH", discovery: { enabled: false } };
}

async function fixture(configs: ProviderConfig[], fetcher?: typeof fetch) {
  const original = globalThis.fetch;
  // Never dispatch an unmocked request from this suite, including discovery.
  globalThis.fetch = fetcher ?? (async () => { throw Error("Unexpected upstream request"); });
  const registry = await ProviderRegistry.create(configs);
  const app = Fastify();
  await app.register(openAiRoutes, { prefix: "/v1", registry, n8nApiKeys: new Set(["fixture"]) });
  return { registry, app, post: (body: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/v1/chat/completions",
    headers: { authorization: "Bearer fixture" }, payload: { model: "chosen", messages, ...body } }),
    close: async () => { await app.close(); globalThis.fetch = original; } };
}

test("all seven profile YAMLs and example provider config validate", () => {
  assert.deepEqual([...profiles.keys()].sort(), ["codex-cli", "deepseek", "gemini-api", "kimi-api", "kimi-code-api", "kimi-code-cli", "openrouter"]);
  const example = loadProvidersFile(path.resolve("config/providers.example.yaml"));
  const kimi = example.providers.find(provider => provider.id === "kimi-api");
  assert.ok(kimi?.type === "openai");
  assert.equal(kimi.baseUrl, "https://api.kimi.com/coding/v1");
  assert.equal(profiles.get("kimi-api")!.baseUrl, kimi.baseUrl);
  for (const profile of profiles.values()) {
    assert.throws(() => providerProfileSchema.parse({ ...profile, unknown: true }));
    assert.throws(() => providerProfileSchema.parse({ ...profile, quirks: { ...profile.quirks, unknown: true } }));
    assert.throws(() => providerProfileSchema.parse({ ...profile, auth: { env: "INVALID-NAME" } }));
    assert.throws(() => providerProfileSchema.parse({ ...profile, normalization: { ...profile.normalization, typo: true } }));
  }
  const codex = profiles.get("codex-cli")!;
  assert.throws(() => providerProfileSchema.parse({ ...codex, quirks: { ...codex.quirks, unsupported_model_patterns: ["["] } }));
});

test("profile-only provider config expands defaults and rejects unknown references/type mismatch", () => {
  mkdirSync(path.resolve(".scratch"), { recursive: true });
  const directory = mkdtempSync(path.resolve(".scratch/profile-config-"));
  const file = path.join(directory, "providers.yaml");
  try {
    for (const profile of profiles.values()) {
      writeFileSync(file, YAML.stringify({ providers: [{ id: "fixture", type: profile.type, profile: profile.id, models: [{ id: "chosen" }] }] }));
      const provider = loadProvidersFile(file).providers[0]!;
      if (provider.type === "openai") { assert.equal(provider.baseUrl, profile.baseUrl); assert.equal(provider.apiKeyEnv, profile.auth.env); }
      else assert.deepEqual(provider.responseCommand.args, profile.command!.args);
    }
    writeFileSync(file, YAML.stringify({ providers: [{ id: "fixture", type: "cli", profile: "unknown", models: [{ id: "chosen" }] }] }));
    assert.throws(() => loadProvidersFile(file), /Unknown provider profile/);
    assert.throws(() => resolveProviderProfile({ ...config("codex-cli"), profile: "deepseek" }), /type mismatch/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("inference preserves explicit legacy endpoints, commands and capability behavior", () => {
  const legacy = { ...config("kimi-api"), profile: undefined };
  if (legacy.type !== "openai") assert.fail();
  legacy.baseUrl = "https://api.moonshot.ai/v1";
  assert.equal(resolveProviderProfile(legacy)?.id, "kimi-api");
  assert.equal(legacy.baseUrl, "https://api.moonshot.ai/v1");
  const cli = config("codex-cli");
  const request: UnifiedRequest = { requestId: "fixture", model: "chosen", providerModel: "chosen", messages, tools: [{ type: "function", function: { name: "weather" } }] };
  assert.throws(() => prepareProfileRequest(cli, request), /does not support tools/);
  assert.equal(prepareProfileRequest({ ...cli, profile: undefined }, request), request);
});

for (const id of profiles.keys()) for (const streamed of [false, true]) {
  test(`${id}: ${streamed ? "client stream" : "buffered"} baseline shape normalizes through route`, async () => {
    const profile = profiles.get(id)!;
    const upstreamBodies: any[] = [];
    const f = await fixture([config(id)], (async (_url, init) => {
      const body = JSON.parse(String(init?.body)); upstreamBodies.push(body);
      if (profile.stream_format === "anthropic-json") return new Response(JSON.stringify({ type: "message", role: "assistant", stop_reason: "end_turn",
        content: [{ type: "text", text: "<think>hidden</think>PONG" }], usage: { input_tokens: 7, output_tokens: 3 } }));
      if (!body.stream) return new Response(JSON.stringify({ choices: [{ message: { content: "<think>hidden</think>PONG", reasoning_content: "hidden", reasoning: null }, finish_reason: "stop" }], ...(id === "gemini-api" ? {} : { usage }) }));
      // Delimiters and UTF8 arrive in separate transport fragments, as in the probe.
      const source = data(chunk({ role: "assistant", content: "<thi", reasoning_content: "hidden", reasoning_details: [] }))
        + data(chunk({ content: "nk>hidden</think>PONG" }, "stop"))
        + (id === "openrouter" ? data({ ...chunk({ content: "", reasoning: null }, "stop"), usage }) : "")
        + (id === "gemini-api" ? "" : data({ choices: [], usage })) + data("[DONE]");
      return new Response(source, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch);
    try {
      const response = await f.post({ stream: streamed, stream_options: { include_usage: true } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers["x-gateway-served-model"], "chosen");
      assert.equal(response.headers["x-gateway-fallback"], "false");
      assert.doesNotMatch(response.body, /hidden|reasoning_content|reasoning_details|native_finish_reason|service_tier/);
      if (streamed) {
        const parsed = events(response.body);
        assert.equal(parsed[0].choices[0].delta.role, "assistant");
        assert.equal(parsed.map(event => event.choices?.[0]?.delta.content ?? "").join(""), "PONG");
        assert.equal(parsed.filter(event => event.choices?.[0]?.finish_reason).length, 1);
        assert.deepEqual(parsed.at(-1).choices, []);
        assert.ok(parsed.at(-1).usage.total_tokens > 0);
        const finishes = parsed.filter(event => event.choices?.[0]?.finish_reason);
        assert.deepEqual(finishes[0].usage, parsed.at(-1).usage);
        assert.equal(parsed.filter(event => event.usage).length, 2);
        assert.ok(parsed.slice(0, -2).every(event => !event.usage));
        if (profile.type === "cli" || id === "gemini-api") assert.equal(finishes[0].usage.estimated, true);
        else for (const [key, value] of Object.entries(usage)) assert.equal(finishes[0].usage[key], value);
        assert.equal((response.body.match(/data: \[DONE\]/g) ?? []).length, 1);
      } else {
        const body = response.json();
        assert.equal(body.choices[0].message.role, "assistant");
        assert.equal(body.choices[0].message.content, "PONG");
        assert.ok(body.usage.total_tokens > 0);
        if (profile.type === "cli" || id === "gemini-api") assert.equal(body.usage.estimated, true);
        else for (const [key, value] of Object.entries(usage)) assert.equal(body.usage[key], value);
      }
      for (const stream_options of [undefined, { include_usage: false }]) {
        const withoutTrailer = await f.post({ stream: true, stream_options });
        const parsed = events(withoutTrailer.body);
        const finishes = parsed.filter(event => event.choices?.[0]?.finish_reason);
        assert.equal(finishes.length, 1);
        assert.equal(parsed.at(-1), finishes[0]);
        assert.equal(parsed.filter(event => event.usage).length, 1);
        assert.ok(finishes[0].usage.total_tokens > 0);
        if (profile.type === "cli" || id === "gemini-api") assert.equal(finishes[0].usage.estimated, true);
        else for (const [key, value] of Object.entries(usage)) assert.equal(finishes[0].usage[key], value);
        assert.equal((withoutTrailer.body.match(/data: \[DONE\]/g) ?? []).length, 1);
      }
      if (profile.type === "openai") assert.ok(upstreamBodies.every(body => body.messages?.some((message: any) => message.role === "user")));
    } finally { await f.close(); }
  });
}

test("Codex JSONL mock streams through its actual CLI parser with estimated usage", async () => {
  const c = config("codex-cli");
  assert.ok(c.type === "cli");
  const fixtureEvents = [{ type: "output_text_delta", delta: "PONG" }, { type: "done", finish_reason: "stop" }];
  c.responseCommand.args = ["-e", `process.stdout.write(${JSON.stringify(fixtureEvents.map(event => JSON.stringify(event)).join("\n") + "\n")})`];
  const f = await fixture([c]);
  f.registry.getProvider("codex-cli")!.supportsStreaming = () => true;
  try {
    const response = await f.post({ stream: true, stream_options: { include_usage: true } });
    assert.equal(response.statusCode, 200);
    const parsed = events(response.body);
    assert.equal(parsed.map(event => event.choices?.[0]?.delta.content ?? "").join(""), "PONG");
    assert.equal(parsed.at(-1).usage.estimated, true);
  } finally { await f.close(); }
});

for (const streamed of [false, true]) test(`fallback identity is explicit before output (stream=${streamed})`, async () => {
  const primary = config("gemini-api");
  primary.models = [{ id: "chosen", fallbackModels: ["backup"] }];
  const backup = config("codex-cli"); backup.models = [{ id: "backup" }];
  const f = await fixture([primary, backup], (async () => new Response(JSON.stringify([{ error: { code: 404, status: "NOT_FOUND" } }]), { status: 404 })) as typeof fetch);
  try {
    const response = await f.post({ stream: streamed });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["x-gateway-served-model"], "backup");
    assert.equal(response.headers["x-gateway-fallback"], "true");
    const first = streamed ? events(response.body)[0] : response.json();
    assert.equal(first.model, "backup"); assert.equal(first.gateway_fallback, true);
  } finally { await f.close(); }
});

for (const mode of ["buffered", "native-stream", "buffered-stream"]) for (const fallback of [false, true]) {
  test(`fallback uses configured route rather than upstream model (${mode}, fallback=${fallback})`, async () => {
    const primary = config("openrouter");
    primary.models = [{ id: "openrouter-free", fallbackModels: fallback ? ["backup"] : [] }];
    const backup = config("deepseek"); backup.models = [{ id: "backup" }];
    const upstreamModel = fallback ? "minimax/model:free" : "openrouter/free";
    const attempted: string[] = [];
    const f = await fixture([primary, backup], (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      attempted.push(body.model);
      if (fallback && body.model === "openrouter-free") return new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 });
      return body.stream
        ? new Response(data({ ...chunk({ content: "PONG" }, "stop"), model: upstreamModel }) + data("[DONE]"), { headers: { "content-type": "text/event-stream" } })
        : new Response(JSON.stringify({ model: upstreamModel, choices: [{ message: { content: "PONG" }, finish_reason: "stop" }] }));
    }) as typeof fetch);
    if (mode === "buffered-stream") f.registry.canStreamModel = () => false;
    try {
      const response = await f.post({ model: "openrouter-free", stream: mode !== "buffered" });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(attempted, fallback ? ["openrouter-free", "backup"] : ["openrouter-free"]);
      assert.equal(response.headers["x-gateway-served-model"], fallback ? "backup" : "openrouter-free");
      assert.equal(response.headers["x-gateway-fallback"], String(fallback));
      const first = mode === "buffered" ? response.json() : events(response.body)[0];
      assert.equal(first.model, upstreamModel);
      assert.equal(first.gateway_fallback, fallback);
    } finally { await f.close(); }
  });
}

for (const status of [401, 403, 404, 429, 503]) test(`Gemini array HTTP ${status} maps to a standard error without fallback`, async () => {
  let calls = 0;
  const f = await fixture([config("gemini-api")], (async () => { calls++; return new Response(JSON.stringify([{ error: { code: status } }]), { status }); }) as typeof fetch);
  try {
    const response = await f.post({ gateway_policy: { operationId: "fixture", maxAttempts: 1, maxLatencyMs: 5000, allowFallback: false } });
    assert.equal(response.statusCode, status === 403 ? 401 : status);
    assert.deepEqual(Object.keys(response.json().error).sort(), ["code", "message", "param", "type"]);
    assert.equal(response.json().error.param, null); assert.equal(calls, 1);
  } finally { await f.close(); }
});

test("partial SSE error emits one sanitized terminal error then DONE", async () => {
  const f = await fixture([config("deepseek")], (async () => new Response(data(chunk({ content: "partial" })) + data({ error: { code: 503, message: "private upstream diagnostic" } }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch);
  try {
    const response = await f.post({ stream: true });
    const parsed = events(response.body);
    assert.equal(parsed.filter(event => event.error).length, 1);
    assert.equal(parsed.at(-1).error.param, null);
    assert.equal(parsed.filter(event => event.choices?.[0]?.finish_reason).length, 0);
    assert.doesNotMatch(response.body, /private upstream diagnostic/);
    assert.match(response.body, /data: \[DONE\]\n\n$/);
  } finally { await f.close(); }
});

test("Codex unsupported tools and unsupported-model CLI errors use standard envelopes", async () => {
  const c = config("codex-cli"); assert.ok(c.type === "cli");
  c.responseCommand.args = ["-e", "process.stderr.write('ERROR: model fixture is not supported\\n');process.exitCode=1"];
  const f = await fixture([c]);
  try {
    const tools = await f.post({ tools: [{ type: "function", function: { name: "weather" } }] });
    assert.equal(tools.statusCode, 400); assert.equal(tools.json().error.code, "model_capability_mismatch"); assert.equal(tools.json().error.param, null);
    const unsupported = await f.post();
    assert.equal(unsupported.statusCode, 404); assert.equal(unsupported.json().error.code, "model_unavailable");
    assert.deepEqual(Object.keys(unsupported.json().error).sort(), ["code", "message", "param", "type"]);
  } finally { await f.close(); }
});

test("content policy handles arbitrary delimiter splits and preserves fences by default", () => {
  const text = "before<think>hidden</think>after";
  for (let at = 0; at <= text.length; at++) {
    const normalizer = new ContentNormalizer();
    assert.equal(normalizer.push(text.slice(0, at)) + normalizer.push(text.slice(at)) + normalizer.push("", true), "beforeafter");
  }
  const fenced = '```json\n{"answer":"pong"}\n```';
  assert.equal(normalizeContent(fenced), fenced);
  assert.equal(normalizeContent(fenced, { strip_think: true, strip_fence: true }), '{"answer":"pong"}');
  assert.equal(normalizeContent(text, { strip_think: false, strip_fence: false }), text);
  const normalizer = new ContentNormalizer({ strip_think: true, strip_fence: true });
  assert.equal(normalizer.push(fenced.slice(0, 4)), "");
  assert.equal(normalizer.push(fenced.slice(4), true), '{"answer":"pong"}');
  assert.equal(normalizeFinishReason("content_filter"), "content_filter");
  assert.equal(normalizeFinishReason("unknown"), "stop");
  assert.equal(normalizeFinishReason("stop", true), "tool_calls");
  assert.deepEqual(stripProviderFields({ reasoning: null, reasoning_content: "private", extra_content: {}, content: "PONG" }, false), { content: "PONG" });
  assert.equal(stripProviderFields({ reasoning_content: "visible" }, true).reasoning_content, "visible");
  assert.deepEqual(completeUsage({ promptTokens: 7 }, messages, "PONG"), { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8, estimated: true });
});

for (const id of ["kimi-api", "kimi-code-api", "openrouter", "deepseek", "gemini-api"]) {
  for (const streamed of [false, true]) test(`${id}: tools preserve arguments and normalize finish (stream=${streamed})`, async () => {
    const call = { id: "weather-call", type: "function", function: { name: "zz_get_weather", arguments: '{"city":"Halifax","provider":"literal"}' } };
    const f = await fixture([config(id)], (async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      if (profiles.get(id)!.stream_format === "anthropic-json") return new Response(JSON.stringify({ type: "message", stop_reason: "tool_use",
        content: [{ type: "tool_use", id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) }], usage: { input_tokens: 7, output_tokens: 3 } }));
      if (!request.stream) return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call], reasoning_content: null }, finish_reason: "stop" }], usage }));
      return new Response(data(chunk({ tool_calls: [{ index: 0, ...call }] }, "stop")) + data({ choices: [], usage }) + data("[DONE]"), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch);
    try {
      const response = await f.post({ stream: streamed, tools: [{ type: "function", function: { name: "zz_get_weather", parameters: { type: "object" } } }], tool_choice: "auto" });
      assert.equal(response.statusCode, 200, response.body);
      const parsed = streamed ? events(response.body) : [];
      const tool = streamed ? parsed.flatMap(event => event.choices?.[0]?.delta.tool_calls ?? [])[0] : response.json().choices[0].message.tool_calls[0];
      assert.equal(tool.id, call.id);
      assert.equal(tool.function.arguments, call.function.arguments);
      assert.equal(streamed ? parsed.at(-1).choices[0].finish_reason : response.json().choices[0].finish_reason, "tool_calls");
      assert.doesNotMatch(response.body, /reasoning_content|extra_content/);
    } finally { await f.close(); }
  });
  test(`${id}: declarative transient retry recovers before output`, async () => {
    let calls = 0;
    const f = await fixture([config(id)], (async () => {
      if (++calls === 1) return new Response(JSON.stringify([{ error: { code: 503 } }]), { status: 503 });
      return new Response(JSON.stringify(profiles.get(id)!.stream_format === "anthropic-json"
        ? { type: "message", stop_reason: "end_turn", content: [{ type: "text", text: "PONG" }] }
        : { choices: [{ message: { content: "PONG" }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch);
    try {
      const response = await f.post({ stream: true, gateway_policy: { operationId: "retry-fixture", maxAttempts: 2, maxLatencyMs: 5000, allowFallback: true } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(calls, 2);
      assert.equal(response.headers["x-gateway-fallback"], "false");
      assert.equal(events(response.body).filter(event => event.choices?.[0]?.finish_reason).length, 1);
    } finally { await f.close(); }
  });
}

test("explicit JSON/system handling forwards API format and preserves ordinary safety refusals", async () => {
  const seen: any[] = [];
  const f = await fixture([config("gemini-api")], (async (_url, init) => {
    seen.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: "I cannot help with that request." }, finish_reason: "stop" }] }));
  }) as typeof fetch);
  try {
    const response = await f.post({ response_format: { type: "json_object" } });
    assert.deepEqual(seen[0].response_format, { type: "json_object" });
    assert.equal(seen[0].messages[0].role, "system");
    assert.equal(seen[0].messages[0].content, "Use uppercase");
    assert.equal(response.json().choices[0].message.content, "I cannot help with that request.");
    assert.equal(response.json().choices[0].finish_reason, "stop");
  } finally { await f.close(); }
});

test("system prepend and disabled JSON capabilities apply only on explicit profiles", () => {
  const profile = { ...profiles.get("deepseek")!, capabilities: { tools: true, json_mode: false, system_prompt: "prepend_to_user" as const } };
  const request: UnifiedRequest = { requestId: "fixture", model: "chosen", providerModel: "chosen", messages, tools: [] };
  const custom = new Map([["deepseek", profile]]);
  const result = prepareProfileRequest(config("deepseek"), request, custom);
  assert.deepEqual(result.messages, [{ role: "user", content: "Use uppercase\n\nZZTEST pong" }]);
  assert.equal(request.messages[0]?.role, "system");
  assert.throws(() => prepareProfileRequest(config("deepseek"), { ...request, metadata: { response_format: { type: "json_object" } } }, custom), /does not support JSON/);
});

test("reasoning opt-in streams each summary fragment once", async () => {
  const f = await fixture([config("deepseek")], (async () => new Response(
    data(chunk({ reasoning_content: "summary " })) + data(chunk({ reasoning_content: "fragment", content: "PONG" }, "stop")) + data("[DONE]"),
    { headers: { "content-type": "text/event-stream" } },
  )) as typeof fetch);
  try {
    const response = await f.post({ stream: true, include_reasoning: true });
    assert.equal(events(response.body).map(event => event.choices?.[0]?.delta.reasoning_content ?? "").join(""), "summary fragment");
  } finally { await f.close(); }
});

test("profile first-token deadline cancels a stalled mock upstream", async () => {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => original(callback, delay === 60000 ? 25 : delay, ...args)) as typeof setTimeout;
  let cancelled = false;
  const f = await fixture([config("gemini-api")], (async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch);
  try {
    const response = await f.post({ stream: true });
    assert.equal(cancelled, true);
    assert.equal(events(response.body).filter(event => event.error).length, 1);
    assert.match(response.body, /data: \[DONE\]\n\n$/);
  } finally { await f.close(); globalThis.setTimeout = original; }
});

for (const streamed of [false, true]) test(`content_filter and upstream model identity remain visible (stream=${streamed})`, async () => {
  const f = await fixture([config("deepseek")], (async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    return request.stream
      ? new Response(data({ ...chunk({}, "content_filter"), model: "served-version" }) + data("[DONE]"), { headers: { "content-type": "text/event-stream" } })
      : new Response(JSON.stringify({ model: "served-version", choices: [{ message: { content: "" }, finish_reason: "content_filter" }] }));
  }) as typeof fetch);
  try {
    const response = await f.post({ stream: streamed });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["x-gateway-served-model"], "chosen");
    assert.equal(response.headers["x-gateway-fallback"], "false");
    const parsed = streamed ? events(response.body) : [];
    const first = streamed ? parsed[0] : response.json();
    assert.equal(first.model, "served-version");
    assert.equal(first.gateway_fallback, false);
    assert.equal(streamed ? parsed.at(-1).choices[0].finish_reason : response.json().choices[0].finish_reason, "content_filter");
  } finally { await f.close(); }
});
