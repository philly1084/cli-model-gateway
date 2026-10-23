import test from "node:test";
import assert from "node:assert/strict";
import { loadAppConfig, loadEmbeddingsConfig } from "../config.js";
import { buildServer } from "../server.js";
import { ProviderRegistry } from "../providers/registry.js";

const publicId = "sentence-transformers/all-MiniLM-L6-v2";
const headers = { authorization: "Bearer dummy-key-for-tests" };

function withEnv(values: Record<string, string | undefined>, action: () => void) {
  const previous = { ...process.env };
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    action();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

async function fixture(t: test.TestContext, enabled = true, fake?: typeof fetch) {
  let config!: ReturnType<typeof loadAppConfig>;
  withEnv({
    N8N_API_KEY: "dummy-key-for-tests", N8N_API_KEYS: undefined, ADMIN_API_KEY: "dummy-admin-for-tests",
    EMBEDDINGS_UPSTREAM_URL: enabled ? "http://embeddings.example.svc:11434/v1/" : undefined,
    EMBEDDINGS_MODELS: undefined, EMBEDDINGS_UPSTREAM_API_KEY: "dummy-upstream-for-tests",
    EMBEDDINGS_TIMEOUT_MS: "20", LOG_LEVEL: "fatal",
  }, () => { config = loadAppConfig(); });
  const registry = await ProviderRegistry.create([{
    id: "dummy-chat", type: "cli", models: [{ id: "dummy-chat-model" }],
    responseCommand: { executable: "REPLACE_ME", args: [], timeoutMs: 1000,
      input: "request_json_stdin", output: "json_contract" },
  }]);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFake: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (fake) return fake(url, init);
    const body = JSON.parse(String(init?.body));
    const inputs = typeof body.input === "string" ? [body.input] : body.input;
    return Response.json({ data: inputs.map(() => ({ embedding: Array(384).fill(0.25) })) });
  };
  const server = buildServer(config, registry, { embeddingsFetch: fetchFake });
  t.after(() => server.close());
  const post = (payload: unknown, url = "/v1/embeddings") => server.app.inject({
    method: "POST", url, headers, payload: payload as Record<string, unknown>,
  });
  return { ...server, registry, config, calls, post };
}

test("embeddings disabled returns OpenAI 404; discovery stays unchanged", async t => {
  const { app, post, calls } = await fixture(t, false);
  const result = await post({ model: publicId, input: "hello" });
  assert.equal(result.statusCode, 404);
  assert.deepEqual(result.json().error, { message: "Embeddings are not configured.",
    type: "invalid_request_error", code: "embeddings_not_configured" });
  assert.equal((await app.inject({ url: "/v1/embeddings/models", headers })).statusCode, 404);
  assert.equal(calls.length, 0);
});

test("embeddings inherits chat authentication on both prefixes", async t => {
  const { app } = await fixture(t);
  const chat = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: {} });
  for (const prefix of ["/v1", "/openai/v1"]) {
    const result = await app.inject({ method: "POST", url: `${prefix}/embeddings`, payload: {} });
    assert.equal(result.statusCode, 401);
    assert.deepEqual(result.json(), chat.json());
    assert.equal((await app.inject({ url: `${prefix}/embeddings/models` })).statusCode, 401);
  }
});

for (const input of ["hello", ["hello", "world"]]) {
  test(`embeddings accepts ${typeof input === "string" ? "string" : "array"} and alias with canonical response`, async t => {
    const { post, calls } = await fixture(t);
    const result = await post({ model: "all-minilm-l6-v2", input, dimensions: 384,
      encoding_format: "float", user: "ignored" }, "/openai/v1/embeddings");
    assert.equal(result.statusCode, 200);
    const body = result.json();
    assert.equal(body.model, publicId);
    assert.equal(body.object, "list");
    assert.equal(body.data.length, typeof input === "string" ? 1 : 2);
    body.data.forEach((item: { index: number; embedding: number[]; object: string }, index: number) => {
      assert.equal(item.index, index);
      assert.equal(item.object, "embedding");
      assert.deepEqual(item.embedding, Array(384).fill(0.25));
    });
    assert.deepEqual(body.usage, { prompt_tokens: typeof input === "string" ? 2 : 3,
      total_tokens: typeof input === "string" ? 2 : 3 });
    assert.equal(calls[0]?.url, "http://embeddings.example.svc:11434/v1/embeddings");
    assert.equal(calls[0]?.init?.redirect, "error");
    assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Bearer dummy-upstream-for-tests");
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { model: "all-minilm:l6-v2", input });
  });
}

for (const [name, payload] of Object.entries({
  unknown: { model: "unknown", input: "hello" },
  auto: { model: "auto", input: "hello" },
  chat: { model: "gpt-dummy", input: "hello" },
  configuredChat: { model: "dummy-chat-model", input: "hello" },
  missingModel: { input: "hello" },
  base64: { model: publicId, input: "hello", encoding_format: "base64" },
  dimensions: { model: publicId, input: "hello", dimensions: 12 },
  tooMany: { model: publicId, input: Array(257).fill("a") },
  tooLong: { model: publicId, input: "a".repeat(8193) },
  empty: { model: publicId, input: "" },
  whitespace: { model: publicId, input: " " },
  emptyArray: { model: publicId, input: [] },
  tokens: { model: publicId, input: [1, 2] },
  nestedTokens: { model: publicId, input: [[1, 2]] },
})) {
  test(`embeddings rejects ${name}`, async t => {
    const { post, calls } = await fixture(t);
    assert.equal((await post(payload)).statusCode, 400);
    assert.equal(calls.length, 0);
  });
}

test("embeddings enforces total body bytes including ignored fields", async t => {
  const { post, calls } = await fixture(t);
  assert.equal((await post({ model: publicId, input: "a", user: "a".repeat(512 * 1024) })).statusCode, 413);
  assert.equal(calls.length, 0);
});

test("embeddings rejects malformed JSON without echoing input", async t => {
  const { app, calls } = await fixture(t);
  const result = await app.inject({ method: "POST", url: "/v1/embeddings",
    headers: { ...headers, "content-type": "application/json" }, payload: '{"input":"dummy-private-input"' });
  assert.equal(result.statusCode, 400);
  assert.ok(!result.body.includes("dummy-private-input"));
  assert.equal(calls.length, 0);
});

test("embeddings cancels upstream on client disconnect", async t => {
  let aborted = false;
  let disconnect: (() => void) | undefined;
  const { app, post } = await fixture(t, true, async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("dummy-error")); }, { once: true });
    disconnect?.();
  }));
  app.addHook("onRequest", async (_request, reply) => {
    disconnect = () => { reply.raw.emit("close"); };
  });
  await assert.rejects(post({ model: publicId, input: "hello" }), { code: "LIGHT_ECONNRESET" });
  assert.equal(aborted, true);
});

test("embeddings configuration rejects chat model name collisions", async t => {
  const { config, registry } = await fixture(t);
  assert.ok(config.embeddings);
  config.embeddings.models[0]!.aliases.push("dummy-chat-model");
  assert.throws(() => buildServer(config, registry), /must not overlap chat model ids/);
});

for (const [name, value] of Object.entries({
  wrongDimensions: { data: [{ embedding: [0] }] },
  wrongCount: { data: [] },
  nonNumeric: { data: [{ embedding: Array(384).fill("0") }] },
  infinite: { data: [{ embedding: Array(384).fill(Infinity) }] },
  malformedUsage: { data: [{ embedding: Array(384).fill(0) }], usage: { prompt_tokens: -1, total_tokens: 0 } },
})) {
  test(`embeddings validates upstream ${name}`, async t => {
    const { post } = await fixture(t, true, async () => Response.json(value));
    const result = await post({ model: publicId, input: "hello" });
    assert.equal(result.statusCode, 502);
    assert.equal(result.json().error.code, "upstream_invalid_response");
  });
}

test("embeddings upstream errors and invalid JSON do not echo upstream content", async t => {
  for (const status of [200, 500]) {
    const { post } = await fixture(t, true, async () => new Response("dummy-private-upstream-content", { status }));
    const result = await post({ model: publicId, input: "hello" });
    assert.equal(result.statusCode, 502);
    assert.ok(!result.body.includes("dummy-private-upstream-content"));
  }
});

test("embeddings timeout aborts upstream and returns 504", async t => {
  let aborted = false;
  const { post } = await fixture(t, true, async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("dummy-error")); }, { once: true });
  }));
  const result = await post({ model: publicId, input: "hello" });
  assert.equal(result.statusCode, 504);
  assert.equal(result.json().error.code, "upstream_timeout");
  assert.equal(aborted, true);
});

test("embeddings preserves upstream usage", async t => {
  const usage = { prompt_tokens: 7, total_tokens: 7 };
  const { post } = await fixture(t, true, async () => Response.json({
    data: [{ embedding: Array(384).fill(0) }], usage,
  }));
  assert.deepEqual((await post({ model: publicId, input: "hello" })).json().usage, usage);
});

test("embedding catalog stays separate from chat discovery and auto selection", async t => {
  const enabled = await fixture(t);
  const disabled = await fixture(t, false);
  const models = await enabled.app.inject({ url: "/v1/models", headers });
  assert.deepEqual(models.json(), (await disabled.app.inject({ url: "/v1/models", headers })).json());
  assert.deepEqual((await enabled.app.inject({ url: "/v1/embeddings/models", headers })).json(), {
    object: "list", data: [{ id: publicId, object: "model", type: "embedding", dimensions: 384 }],
  });
  const chat = await enabled.app.inject({ method: "POST", url: "/v1/chat/completions", headers,
    payload: { model: publicId, messages: [{ role: "user", content: "hello" }] } });
  assert.ok(chat.statusCode >= 400);
  assert.equal(enabled.calls.length, 0);
  const decision = enabled.registry.explainAutoRouting({
    messages: [{ role: "user", content: "hello" }], tools: [],
  });
  assert.equal(decision.selectedModelId, "dummy-chat-model");
  assert.ok(decision.candidates.every(candidate => candidate.modelId !== publicId));
});

test("embeddings config defaults and validation are safe", () => {
  withEnv({ EMBEDDINGS_UPSTREAM_URL: undefined, EMBEDDINGS_MODELS: "bad" }, () => {
    assert.equal(loadEmbeddingsConfig(), undefined);
  });
  for (const url of ["file:///dummy", "http://dummy:dummy@router.example.com/v1", "http://router.example.com/v1?q=dummy", "http://router.example.com/v1#dummy", "bad"]) {
    withEnv({ EMBEDDINGS_UPSTREAM_URL: url }, () => {
      assert.throws(loadEmbeddingsConfig, /^Error: Invalid EMBEDDINGS_UPSTREAM_URL:/);
    });
  }
  for (const raw of ["bad", "[]", '[{"id":"auto","upstreamModel":"dummy","dimensions":384}]',
    '[{"id":"dummy","aliases":["dummy"],"upstreamModel":"dummy","dimensions":384}]',
    '[{"id":"dummy","upstreamModel":"dummy","dimensions":0}]']) {
    withEnv({ EMBEDDINGS_UPSTREAM_URL: "http://embeddings.example.svc/v1", EMBEDDINGS_MODELS: raw }, () => {
      assert.throws(loadEmbeddingsConfig, /^Error: Invalid EMBEDDINGS_MODELS:/);
    });
  }
  withEnv({ EMBEDDINGS_UPSTREAM_URL: "https://router.example.com/v1/", EMBEDDINGS_MODELS: undefined,
    EMBEDDINGS_TIMEOUT_MS: undefined, EMBEDDINGS_UPSTREAM_API_KEY: undefined }, () => {
    const config = loadEmbeddingsConfig();
    assert.equal(config?.timeoutMs, 15000);
    assert.equal(config?.models[0]?.dimensions, 384);
    assert.equal(config?.upstreamUrl, "https://router.example.com/v1");
    assert.equal(config?.apiKey, undefined);
  });
});

test("embeddings config supports a custom catalog and validates timeout", () => {
  withEnv({ EMBEDDINGS_UPSTREAM_URL: "http://embeddings.example.svc/v1",
    EMBEDDINGS_MODELS: '[{"id":"dummy-embedding","upstreamModel":"dummy-upstream","dimensions":2}]',
    EMBEDDINGS_TIMEOUT_MS: "1234" }, () => {
    assert.deepEqual(loadEmbeddingsConfig()?.models, [{ id: "dummy-embedding", aliases: [],
      upstreamModel: "dummy-upstream", dimensions: 2 }]);
    assert.equal(loadEmbeddingsConfig()?.timeoutMs, 1234);
    for (const timeout of ["0", "-1", "1.5", "bad"]) {
      process.env.EMBEDDINGS_TIMEOUT_MS = timeout;
      assert.throws(loadEmbeddingsConfig, /Invalid EMBEDDINGS_TIMEOUT_MS/);
    }
  });
});
