import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { OpenAiCompatibleProvider } from "../providers/openai-compatible-provider";
import { routeTable, modelRoute, normalizeRouteEffort } from "../utils/route-table.js";
import type { ProviderModelConfig, UnifiedRequest } from "../types";

type CatalogProvider = { id: string; models?: ProviderModelConfig[] };

function loadExample(): CatalogProvider[] {
  return YAML.parse(readFileSync("config/providers.example.yaml", "utf8")).providers;
}

function loadRancher(): CatalogProvider[] {
  const docs = YAML.parseAllDocuments(readFileSync("kubernetes/rancher-install.yaml", "utf8"));
  for (const doc of docs) assert.deepEqual(doc.errors, []);
  const config = docs.map((doc) => doc.toJSON()).find((doc) => doc?.kind === "ConfigMap" && doc.data?.["providers.yaml"]);
  return YAML.parse(config.data["providers.yaml"]).providers;
}

function geminiApiModels(providers: CatalogProvider[], id: string): ProviderModelConfig[] {
  return providers.filter((p) => p.id === "gemini-api").flatMap((p) => p.models ?? []).filter((m) => m.id === id);
}

const catalogIds = ["gemini-4-hydrogen", "gemini-4-neon"] as const;

test("hydrogen and neon are manual-only gemini-api catalog entries with tools and no fallbacks", () => {
  for (const providers of [loadExample(), loadRancher()]) {
    for (const id of catalogIds) {
      const matches = geminiApiModels(providers, id);
      assert.equal(matches.length, 1, id);
      const model = matches[0]!;
      assert.equal(model.providerModel, id);
      assert.equal(model.manualOnly, true);
      assert.equal(model.autoEligible, false);
      assert.equal((model.fallbackModels ?? []).length, 0);
      assert.ok(model.capabilities?.includes("chat"));
      assert.ok(model.capabilities?.includes("responses"));
      assert.ok(model.capabilities?.includes("tools"));
      assert.ok(model.capabilities?.includes("reasoning"));
      assert.ok(model.capabilities?.includes("structured_outputs"));
    }
  }
});

test("route table lists hydrogen and neon for explicit selection without changing work classes", () => {
  const expectedWork = {
    planner: { model: "gpt-6-luna", effort: "medium" },
    intent: { model: "gpt-6-luna", effort: "medium" },
    plan: { model: "gpt-6-luna", effort: "medium" },
    research: { model: "gpt-6-luna", effort: "medium" },
    critique: { model: "gpt-6-luna", effort: "medium" },
    choreography: { model: "gpt-6-luna", effort: "medium" },
    audio: { model: "gpt-6-luna", effort: "medium" },
    animation: { model: "gpt-6-luna", effort: "high" },
    layout: { model: "gpt-6-luna", effort: "high" },
    builder: { model: "gpt-6-luna", effort: "high" },
    "builder-code": { model: "gpt-6-luna", effort: "high" },
    hardest: { model: "gpt-6-luna", effort: "xhigh" },
    actor: { model: "deepseek-v4-pro", effort: "disabled" },
    materials: { model: "deepseek-v4-pro", effort: "disabled" },
    reviewer: { model: "kimi-k3", effort: "provider-default" },
    critic: { model: "kimi-k3", effort: "provider-default" },
    "reviewer-astra": { model: "gpt-6-luna", effort: "high" },
    "reviewer-sol": { model: "gpt-6-luna", effort: "medium" },
    msi: { model: "gpt-6-luna", effort: "medium" },
    "chat-quick": { model: "gpt-6-luna", effort: "medium" },
  };
  assert.deepEqual(routeTable.workClasses, expectedWork);
  for (const id of catalogIds) {
    const route = modelRoute(id);
    assert.equal(route.providerId, "gemini-api");
    assert.equal(route.providerModel, id);
    assert.equal(route.manualOnly, true);
    assert.equal(route.autoEligible, false);
    assert.equal(route.capabilities.tools, true);
    assert.equal(route.capabilities.reasoning, true);
    assert.equal(route.capabilities.knowledge, false);
    assert.equal(route.admission.actorPreview, false);
    assert.equal(route.admission.reviewerImages, false);
    assert.deepEqual(route.allowedEfforts, ["low", "medium", "high", "xhigh"]);
    assert.equal(route.defaultEffort, "high");
    assert.equal(normalizeRouteEffort(id), "high");
    assert.equal(normalizeRouteEffort(id, "none"), "low");
    assert.equal(normalizeRouteEffort(id, "minimal"), "low");
    assert.equal(normalizeRouteEffort(id, "max"), "xhigh");
    assert.throws(() => normalizeRouteEffort(id, "ultra"));
  }
  assert.match(modelRoute("gemini-4-neon").availabilityNotes, /PAID TIER ONLY/);
  assert.match(modelRoute("gemini-4-hydrogen").availabilityNotes, /Free and paid/);
  assert.equal(Object.values(routeTable.workClasses).some((row) => catalogIds.includes(row.model as typeof catalogIds[number])), false);
});

type CapturedBody = {
  model?: string;
  reasoning_effort?: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  max_output_tokens?: number;
  tools?: unknown[];
  messages?: Array<{ tool_calls?: Array<{ extra_content?: unknown }> }>;
};

async function withGeminiProvider(
  model: string,
  fn: (provider: OpenAiCompatibleProvider, bodies: CapturedBody[]) => Promise<void>,
  respond?: (body: CapturedBody, requestIndex: number) => Response,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI4_TEST_KEY;
  const bodies: CapturedBody[] = [];
  process.env.GEMINI4_TEST_KEY = "test-key";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as CapturedBody;
    bodies.push(body);
    if (respond) return respond(body, bodies.length);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const provider = await OpenAiCompatibleProvider.create({
      id: "gemini-api",
      type: "openai",
      profile: "gemini-api",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKeyEnv: "GEMINI4_TEST_KEY",
      models: catalogIds.map((id) => ({ id, providerModel: id, manualOnly: true, autoEligible: false, capabilities: ["chat", "responses", "tools"] })),
    });
    await fn(provider, bodies);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI4_TEST_KEY;
    else process.env.GEMINI4_TEST_KEY = originalKey;
  }
}

function request(model: string, overrides: Partial<UnifiedRequest> = {}): UnifiedRequest {
  return {
    requestId: "gemini4-fixture",
    requestKind: "chat_completions",
    model,
    providerModel: model,
    messages: [{ role: "user", content: "Synthetic fixture" }],
    tools: [],
    ...overrides,
  };
}

test("Gemini 4 maps reasoning_effort to thinking levels, defaults 64K output, and strips illegal sampling", async () => {
  await withGeminiProvider("gemini-4-hydrogen", async (provider, bodies) => {
    for (const model of catalogIds) {
      bodies.length = 0;
      await provider.run(request(model, {
        reasoningEffort: "xhigh",
        metadata: { temperature: 0, top_p: 0.1, top_k: 8, presence_penalty: 0.2, frequency_penalty: 0.3, max_tokens: 128000 },
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      }));
      assert.equal(bodies.length, 1);
      const body = bodies[0]!;
      assert.equal(body.model, model);
      assert.equal(body.reasoning_effort, "xhigh");
      assert.equal(body.temperature, undefined);
      assert.equal(body.top_p, undefined);
      assert.equal(body.top_k, undefined);
      assert.equal(body.presence_penalty, undefined);
      assert.equal(body.frequency_penalty, undefined);
      assert.equal(body.max_tokens, 65536);
      assert.ok(Array.isArray(body.tools) && body.tools.length === 1);
    }

    bodies.length = 0;
    await provider.run(request("gemini-4-hydrogen", { reasoningEffort: "none" }));
    assert.equal(bodies[0]?.reasoning_effort, "low");
    assert.equal(bodies[0]?.max_tokens, 65536);

    bodies.length = 0;
    await provider.run(request("gemini-4-hydrogen", { reasoningEffort: "minimal", metadata: { max_tokens: 1024 } }));
    assert.equal(bodies[0]?.reasoning_effort, "low");
    assert.equal(bodies[0]?.max_tokens, 1024);

    bodies.length = 0;
    await provider.run(request("gemini-4-hydrogen"));
    assert.equal(bodies[0]?.reasoning_effort, undefined);
    assert.equal(bodies[0]?.max_tokens, 65536);

    await assert.rejects(() => provider.run(request("gemini-4-hydrogen", { reasoningEffort: "ultra" as UnifiedRequest["reasoningEffort"] })), /MODEL_EFFORT_UNSUPPORTED/);
  });
});

test("buffered Gemini 4 tool calls replay thought_signature and hide it from the client", async () => {
  await withGeminiProvider("gemini-4-hydrogen", async (provider, bodies) => {
    const first = await provider.run(request("gemini-4-hydrogen", {
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    }));
    assert.equal(JSON.stringify(first).includes("opaque-test-signature"), false);
    assert.equal(first.toolCalls[0]?.id, "signed-call");
    await provider.run(request("gemini-4-hydrogen", {
      messages: [
        { role: "user", content: "Synthetic fixture" },
        { role: "assistant", content: "\n\nTOOL_CALLS:\n" + JSON.stringify([first.toolCalls[0]]) },
        { role: "tool", tool_call_id: "signed-call", content: "42" },
      ],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    }));
    assert.equal(bodies.length, 2);
    const assistant = bodies[1]!.messages?.find((message) => message.tool_calls?.length);
    assert.deepEqual(assistant?.tool_calls?.[0]?.extra_content, { google: { thought_signature: "opaque-test-signature" } });
  }, (_body, index) => {
    if (index === 1) {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "signed-call",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
              extra_content: { google: { thought_signature: "opaque-test-signature" } },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "42" }, finish_reason: "stop" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
});
