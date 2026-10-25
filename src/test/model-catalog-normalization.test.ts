import test from "node:test";
import assert from "node:assert/strict";
import { OpenAiCompatibleProvider } from "../providers/openai-compatible-provider.js";

test("Google resource names match configured routes without losing their policy", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.CATALOG_TEST_KEY;
  process.env.CATALOG_TEST_KEY = "synthetic-test-key";
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [
    { id: "models/gemini-test" }, { id: "gemini-test" },
    { id: "models/retired", active: false }, { id: "models/preview-tts" },
  ] }), { headers: { "content-type": "application/json" } });
  try {
    const configured = { id: "chat-test", providerModel: "gemini-test", autoEligible: false, fallbackModels: ["existing-fallback"] };
    const provider = await OpenAiCompatibleProvider.create({
      id: "gemini-api", type: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKeyEnv: "CATALOG_TEST_KEY", models: [configured], discovery: { enabled: true, include: ["gemini-test", "retired", "preview-tts"] },
    });
    assert.deepEqual(provider.models, [configured]);
    const other = await OpenAiCompatibleProvider.create({
      id: "other", type: "openai", baseUrl: "https://example.invalid/v1", apiKeyEnv: "CATALOG_TEST_KEY",
      discovery: { enabled: true, include: ["models/gemini-test"] },
    });
    assert.deepEqual(other.models, [{ id: "models/gemini-test", providerModel: "models/gemini-test" }]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.CATALOG_TEST_KEY;
    else process.env.CATALOG_TEST_KEY = previousKey;
  }
});
