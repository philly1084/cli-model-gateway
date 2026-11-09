import test from "node:test";
import assert from "node:assert/strict";
import { imageInput, imageRequest, IMAGE_INPUT_FLAG } from "../utils/image-input.js";
import { normalizeChatMessages } from "../routes/openai.js";
import { OpenAiCompatibleProvider } from "../providers/openai-compatible-provider.js";
import type { UnifiedRequest } from "../types.js";

// Synthetic byte fixture for transport tests only; never visual/autonomy evidence.
const data = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
const image = { type: "image_url", image_url: { url: "data:image/jpeg;base64," + data } };
const input = (): Omit<UnifiedRequest, "model" | "providerModel"> => ({ requestId: "image_fixture", requestKind: "chat_completions", tools: [], messages: [{ role: "user", content: "Fixture", inputImages: [{ mediaType: "image/jpeg", data }] }] });

test("image input is gated, bounded, user-only and data-only", () => {
  assert.throws(() => imageInput([image], "user", false), /IMAGE_INPUT_DISABLED/);
  assert.throws(() => imageInput([image], "assistant", true), /IMAGE_INPUT_INVALID/);
  assert.throws(() => imageInput(Array(4).fill(image), "user", true), /IMAGE_INPUT_INVALID/);
  for (const url of ["https://example.invalid/private", "file:///private", "data:image/png;base64," + data, "data:image/jpeg;base64,AAAA", "data:image/jpeg;base64," + "A".repeat(64004)]) {
    assert.throws(() => imageInput([{ type: "image_url", image_url: { url } }], "user", true), /IMAGE_INPUT_INVALID/);
  }
  assert.deepEqual(imageInput([image], "user", true), [{ mediaType: "image/jpeg", data }]);
});

test("ordinary text remains identical and image normalization fails visibly when closed", t => {
  const prior = process.env[IMAGE_INPUT_FLAG]; delete process.env[IMAGE_INPUT_FLAG];
  t.after(() => { if (prior === undefined) delete process.env[IMAGE_INPUT_FLAG]; else process.env[IMAGE_INPUT_FLAG] = prior; });
  assert.deepEqual(normalizeChatMessages([{ role: "user", content: "Plain text" }]), [{ role: "user", content: "Plain text" }]);
  assert.throws(() => normalizeChatMessages([{ role: "user", content: [image] }]), /IMAGE_INPUT_DISABLED/);
  process.env[IMAGE_INPUT_FLAG] = "1";
  assert.throws(() => normalizeChatMessages([{ role: "assistant", content: [image] }]), /IMAGE_INPUT_INVALID/);
  assert.deepEqual(normalizeChatMessages([{ role: "user", content: [{ type: "text", text: "Inspect" }, image] }]), [{ role: "user", content: "Inspect", inputImages: [{ mediaType: "image/jpeg", data }] }]);
});

test("image route pins the configured provider and one attempt without extending a deadline", t => {
  const prior = process.env[IMAGE_INPUT_FLAG]; process.env[IMAGE_INPUT_FLAG] = "1";
  t.after(() => { if (prior === undefined) delete process.env[IMAGE_INPUT_FLAG]; else process.env[IMAGE_INPUT_FLAG] = prior; });
  assert.throws(() => imageRequest(input(), "other-provider"), /IMAGE_ROUTE_UNSUPPORTED/);
  assert.throws(() => imageRequest({ ...input(), stream: true }, "kimi-code-api"), /IMAGE_ROUTE_UNSUPPORTED/);
  assert.throws(() => imageRequest({ ...input(), requestKind: "responses" }, "kimi-code-api"), /IMAGE_ROUTE_UNSUPPORTED/);
  const events: unknown[] = [];
  const request = imageRequest({ ...input(), receipt: row => events.push(row), metadata: { gateway_policy: { operationId: "fixture", allowFallback: true, maxAttempts: 8, maxLatencyMs: 5000 } } }, "kimi-code-api");
  assert.deepEqual(request.metadata?.gateway_policy, { operationId: "fixture", allowFallback: false, maxAttempts: 1, maxLatencyMs: 5000 });
  assert.doesNotMatch(JSON.stringify(events), new RegExp(data.replace(/[+]/g, "\\+")));
  assert.equal((events[0] as { images: number }).images, 1);
  assert.throws(() => imageRequest({ ...input(), messages: Array(4).fill(input().messages[0]) }, "kimi-code-api"), /IMAGE_INPUT_INVALID/);
});

test("actual Kimi adapter receives identical normalized JPEG bytes in Anthropic image blocks", async t => {
  const prior = process.env[IMAGE_INPUT_FLAG], priorKey = process.env.IMAGE_UNIT_KEY, originalFetch = globalThis.fetch;
  process.env[IMAGE_INPUT_FLAG] = "1"; process.env.IMAGE_UNIT_KEY = "unit-test-only";
  t.after(() => { globalThis.fetch = originalFetch; if (prior === undefined) delete process.env[IMAGE_INPUT_FLAG]; else process.env[IMAGE_INPUT_FLAG] = prior; if (priorKey === undefined) delete process.env.IMAGE_UNIT_KEY; else process.env.IMAGE_UNIT_KEY = priorKey; });
  let captured: Record<string, any> = {}, count = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body)); count++;
    return new Response(JSON.stringify({ type: "message", id: "synthetic", model: "k3", role: "assistant", content: [{ type: "text", text: "Fixture only" }], stop_reason: "end_turn" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const provider = await OpenAiCompatibleProvider.create({ id: "kimi-code-api", type: "openai", baseUrl: "https://api.kimi.com/coding/v1", apiKeyEnv: "IMAGE_UNIT_KEY", models: [{ id: "kimi-k3", providerModel: "k3" }], discovery: { enabled: false } });
  const messages = normalizeChatMessages([{ role: "user", content: [{ type: "text", text: "Inspect" }, image] }]);
  const result = await provider.run({ ...input(), messages, model: "kimi-k3", providerModel: "k3" });
  assert.equal(count, 1); assert.equal(result.outputText, "Fixture only");
  assert.deepEqual(captured.messages[0].content, [{ type: "text", text: "Inspect" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data } }]);
});
