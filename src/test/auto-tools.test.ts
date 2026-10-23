import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { ProviderRegistry } from "../providers/registry.js";
import { openAiRoutes } from "../routes/openai.js";
import { RequestCapabilityError } from "../utils/request-capability.js";
import type { ExecutionReceipt } from "../utils/execution-policy.js";
import type { ModelCapability, UnifiedRequest } from "../types.js";
import { Writable } from "node:stream";
import { installRequestCompletionLogging } from "../utils/request-completion.js";

const weather = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Get weather for a city",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};
const call = { id: "weather-call", name: "get_weather", arguments: '{"city":"Halifax"}' };
const messages = [{ role: "user" as const, content: "What's the weather in Halifax? Use the tool." }];

async function fixture(options: { api?: boolean; cliCapabilities?: ModelCapability[]; modelId?: string } = {}) {
  const registry = await ProviderRegistry.create([
    {
      id: "cli-fixture", type: "cli",
      models: [{ id: options.modelId ?? "gpt-5.6-luna", capabilities: options.cliCapabilities }],
      responseCommand: { executable: process.execPath, args: [], input: "request_json_stdin", output: "json_contract", timeoutMs: 1000 },
    },
    ...(options.api === false ? [] : [{
      id: "api-fixture", type: "openai" as const, baseUrl: "https://router.example.com/v1",
      apiKeyEnv: "AUTO_TOOLS_DUMMY_KEY", discovery: { enabled: false },
      models: [{ id: "gemini-3.5-flash" }],
    }]),
  ]);
  const seen: string[] = [];
  const receipts: ExecutionReceipt[] = [];
  registry.getProvider("cli-fixture")!.run = async request => {
    seen.push(request.model);
    request.execution?.dispatch();
    if (request.tools.length) {
      throw Object.assign(new Error("Provider execution stopped; remote outcome is uncertain"), { uncertain: true });
    }
    return { outputText: "pong", toolCalls: [], finishReason: "stop" };
  };
  if (options.api !== false) registry.getProvider("api-fixture")!.run = async request => {
    seen.push(request.model);
    assert.deepEqual(request.tools, [weather]);
    request.execution?.dispatch();
    return { outputText: "", toolCalls: [call], finishReason: "tool_calls" };
  };
  const logs: Record<string, any>[] = [];
  const sink = new Writable({ write(chunk, _encoding, done) {
    logs.push(JSON.parse(String(chunk)));
    done();
  } });
  const app = Fastify({ disableRequestLogging: true, logger: { level: "info", stream: sink } });
  installRequestCompletionLogging(app);
  await app.register(openAiRoutes, { prefix: "/v1", registry, n8nApiKeys: new Set(["dummy-key-for-tests"]) });
  const inject = (payload: Record<string, unknown>, url = "/v1/chat/completions") => app.inject({
    method: "POST", url, headers: { authorization: "Bearer dummy-key-for-tests" }, payload,
  });
  const request = { requestId: "auto-tools", messages, tools: [weather], requestKind: "chat_completions" as const, receipt: (value: ExecutionReceipt) => receipts.push(value) };
  return { registry, app, inject, seen, receipts, request, logs };
}

for (const modelId of ["fixture:free", "fixture/free", "fixture-paid"]) {
  for (const stream of [false, true]) test(`auto selection warning for ${modelId} (stream=${stream})`, async () => {
    const f = await fixture({ api: false, modelId });
    try {
      const response = await f.inject({ model: "auto", messages, stream });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(f.seen, [modelId]);
      const warnings = f.logs.filter(log => log.msg === "auto_selected_free_model");
      assert.equal(warnings.length, modelId === "fixture-paid" ? 0 : 1);
      if (warnings.length) {
        assert.equal(warnings[0]!.level, 40);
        assert.equal(warnings[0]!.selectedModel, modelId);
      }
      const completion = f.logs.find(log => log.msg === "request completed")!;
      if (stream) {
        assert.equal(completion.outcome, "ok");
        assert.equal(completion.requestedModel, "auto");
        assert.equal(completion.selectedModel, modelId);
        assert.equal(completion.bytesSent, Buffer.byteLength(response.body));
        assert.match(response.body, /data: \[DONE\]/);
      }
      await f.inject({ model: modelId, messages, stream });
      assert.equal(f.logs.filter(log => log.msg === "auto_selected_free_model").length, warnings.length);
    } finally { await f.app.close(); }
  });
}

test("reproduces the old optimistic CLI contract: uncertain execution prevents tool-capable fallback", async () => {
  const f = await fixture({ cliCapabilities: ["chat", "responses", "tools"] });
  try {
    await assert.rejects(f.registry.runModel("auto", f.request), /remote outcome is uncertain/);
    assert.deepEqual(f.seen, ["gpt-5.6-luna"]);
    const terminal = f.receipts.find(value => value.type === "gateway.execution.terminal");
    assert.equal(terminal?.attempts, 1);
    assert.equal(terminal?.providerOutcome, "unknown");
    assert.equal(terminal?.replaySafe, false);
  } finally { await f.app.close(); }
});

for (const stream of [false, true]) test(`auto + tools selects the API model and returns tool_calls (stream=${stream})`, async () => {
  const f = await fixture();
  try {
    const response = await f.inject({ model: "auto", messages, tools: [weather], tool_choice: "auto", max_tokens: 200, stream });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(f.seen, ["gemini-3.5-flash"]);
    const payload = stream
      ? JSON.parse(response.body.split("\n").find(line => line.startsWith("data: {"))!.slice(6))
      : response.json();
    assert.equal(payload.model, "gemini-3.5-flash");
    assert.equal(payload.choices[0].finish_reason, "tool_calls");
    assert.deepEqual((stream ? payload.choices[0].delta : payload.choices[0].message).tool_calls[0].function, { name: call.name, arguments: call.arguments });
    if (stream) assert.match(response.body, /data: \[DONE\]/);
    const decision = f.registry.explainAutoRouting(f.request);
    assert.equal(decision.selectedModelId, "gemini-3.5-flash");
    assert.deepEqual(decision.filteredCandidates, [{ modelId: "gpt-5.6-luna", providerId: "cli-fixture", reason: "filtered: tools unsupported" }]);
  } finally { await f.app.close(); }
});

for (const stream of [false, true]) test(`no tool-capable candidate returns 400 before dispatch (stream=${stream})`, async () => {
  const f = await fixture({ api: false });
  try {
    const response = await f.inject({ model: "auto", messages, tools: [weather], tool_choice: "auto", stream });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.type, "invalid_request_error");
    assert.equal(response.json().error.code, "no_tool_capable_model");
    assert.deepEqual(f.seen, []);
    await assert.rejects(f.registry.runModel("auto", f.request), RequestCapabilityError);
    assert.equal(f.receipts.at(-1)?.attempts, 0);
    assert.equal(f.receipts.at(-1)?.providerOutcome, "not_started");
    assert.equal(f.receipts.at(-1)?.replaySafe, true);
  } finally { await f.app.close(); }
});

test("auto without tools and pinned API selection are unchanged; pinned unsupported CLI is a 400", async () => {
  const f = await fixture();
  try {
    const plain = await f.inject({ model: "auto", messages: [{ role: "user", content: "Reply pong" }] });
    assert.equal(plain.statusCode, 200);
    assert.equal(plain.json().model, "gpt-5.6-luna");
    assert.equal(plain.json().choices[0].message.content, "pong");
    const pinned = await f.inject({ model: "gemini-3.5-flash", messages, tools: [weather] });
    assert.equal(pinned.statusCode, 200);
    assert.equal(pinned.json().choices[0].finish_reason, "tool_calls");
    const mismatch = await f.inject({ model: "gpt-5.6-luna", messages, tools: [weather] });
    assert.equal(mismatch.statusCode, 400);
    assert.equal(mismatch.json().error.code, "model_capability_mismatch");
    assert.deepEqual(f.seen, ["gpt-5.6-luna", "gemini-3.5-flash"]);
  } finally { await f.app.close(); }
});

test("legacy functions, required/named tool choices and responses use tool-aware selection", async () => {
  const f = await fixture();
  try {
    const legacy = await f.inject({ model: "auto", messages, functions: [weather.function], function_call: "auto" });
    assert.equal(legacy.statusCode, 200);
    assert.equal(legacy.json().model, "gemini-3.5-flash");
    const responses = await f.inject({ model: "auto", input: messages[0]!.content, tools: [weather] }, "/v1/responses");
    assert.equal(responses.statusCode, 200);
    for (const metadata of [{ tool_choice: "required" }, { tool_choice: { type: "function", function: { name: call.name } } }, { function_call: { name: call.name } }]) {
      assert.equal(f.registry.explainAutoRouting({ ...f.request, tools: [], metadata }).selectedModelId, "gemini-3.5-flash");
    }
  } finally { await f.app.close(); }
});

test("explicit CLI tool support is honored and a definitive local rejection can fall back", async () => {
  const f = await fixture({ cliCapabilities: ["chat", "responses", "tools"] });
  try {
    const provider = f.registry.getProvider("cli-fixture")!;
    provider.run = async request => {
      f.seen.push(request.model);
      // Rejected locally: no dispatch or provider output occurred.
      throw new RequestCapabilityError("Fixture tool contract unavailable.");
    };
    const result = await f.registry.runModel("auto", f.request);
    assert.equal(result.resolvedModel, "gemini-3.5-flash");
    assert.deepEqual(f.seen, ["gpt-5.6-luna", "gemini-3.5-flash"]);
    assert.equal(f.receipts.at(-1)?.attempts, 2);
    f.seen.length = 0;
    provider.run = async (request: UnifiedRequest) => {
      f.seen.push(request.model);
      return { outputText: "", toolCalls: [call], finishReason: "tool_calls" };
    };
    assert.equal((await f.registry.runModel("auto", f.request)).resolvedModel, "gpt-5.6-luna");
    assert.deepEqual(f.seen, ["gpt-5.6-luna"]);
  } finally { await f.app.close(); }
});
