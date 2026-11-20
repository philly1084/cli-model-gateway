import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { loadProvidersFile } from "../config.js";
import { OpenAiCompatibleProvider } from "../providers/openai-compatible-provider";
import { ProviderRegistry } from "../providers/registry.js";
import { normalizeChatMessages } from "../routes/openai.js";
import { ANTHROPIC_IMAGE_INPUT_FLAG, IMAGE_INPUT_FLAG, imageRequest } from "../utils/image-input.js";
import { routeTable, modelRoute, normalizeRouteEffort } from "../utils/route-table.js";
import type { ProviderModelConfig, UnifiedRequest } from "../types";

type CatalogProvider = { id: string; models?: ProviderModelConfig[] };

function loadExample(): CatalogProvider[] {
  return YAML.parse(readFileSync("config/providers.example.yaml", "utf8")).providers;
}

function rancherDocuments(): any[] {
  const docs = YAML.parseAllDocuments(readFileSync("kubernetes/rancher-install.yaml", "utf8"));
  for (const doc of docs) assert.deepEqual(doc.errors, []);
  return docs.map((doc) => doc.toJSON());
}

function rancherProvidersYaml(): string {
  return rancherDocuments().find((doc) => doc?.kind === "ConfigMap" && doc.data?.["providers.yaml"]).data["providers.yaml"];
}

function loadRancher(): CatalogProvider[] {
  return YAML.parse(rancherProvidersYaml()).providers;
}

const modelId = "claude-fable-5-2";

test("claude-fable-5-2 is a manual-only anthropic-api catalog entry with tools and no fallbacks", () => {
  for (const providers of [loadExample(), loadRancher()]) {
    const matches = providers.filter((provider) => provider.id === "anthropic-api").flatMap((provider) => provider.models ?? []).filter((model) => model.id === modelId);
    assert.equal(matches.length, 1);
    const model = matches[0]!;
    assert.equal(model.providerModel, modelId);
    assert.equal(model.manualOnly, true);
    assert.equal(model.autoEligible, false);
    assert.equal((model.fallbackModels ?? []).length, 0);
    assert.ok(model.capabilities?.includes("chat"));
    assert.ok(model.capabilities?.includes("responses"));
    assert.ok(model.capabilities?.includes("tools"));
    assert.ok(model.capabilities?.includes("reasoning"));
    assert.ok(model.capabilities?.includes("structured_outputs"));
  }
});

test("route table lists claude-fable-5-2 for explicit selection without changing work classes", () => {
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
  const route = modelRoute(modelId);
  assert.equal(route.providerId, "anthropic-api");
  assert.equal(route.providerModel, modelId);
  assert.equal(route.manualOnly, true);
  assert.equal(route.autoEligible, false);
  assert.equal(route.capabilities.tools, true);
  assert.equal(route.capabilities.reasoning, true);
  assert.equal(route.capabilities.images, true);
  assert.equal(route.capabilities.knowledge, false);
  assert.equal(route.admission.actorPreview, false);
  assert.equal(route.admission.reviewerImages, false);
  assert.deepEqual(route.allowedEfforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(route.defaultEffort, "high");
  assert.equal(normalizeRouteEffort(modelId), "high");
  assert.equal(normalizeRouteEffort(modelId, "none"), "low");
  assert.equal(normalizeRouteEffort(modelId, "minimal"), "low");
  assert.equal(normalizeRouteEffort(modelId, "max"), "max");
  assert.equal(normalizeRouteEffort("gemini-4-hydrogen", "max"), "xhigh");
  assert.throws(() => normalizeRouteEffort(modelId, "ultra"));
  assert.match(route.availabilityNotes, /PAID API ONLY/);
  assert.match(route.availabilityNotes, /\$8 input \/ \$40 output/);
  assert.equal(Object.values(routeTable.workClasses).some((row) => row.model === modelId), false);
});

type CapturedBody = {
  model?: string;
  messages?: Array<{ role: string; content: unknown }>;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  thinking?: unknown;
  output_config?: { effort?: string; format?: unknown };
  tools?: unknown[];
  tool_choice?: unknown;
};

async function withAnthropicProvider(
  fn: (provider: OpenAiCompatibleProvider, bodies: CapturedBody[], headers: Headers[], urls: string[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const bodies: CapturedBody[] = [];
  const headers: Headers[] = [];
  const urls: string[] = [];
  process.env.ANTHROPIC_API_KEY = "test-key";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as CapturedBody);
    headers.push(new Headers(init?.headers));
    return new Response(JSON.stringify({
      type: "message",
      role: "assistant",
      model: modelId,
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 3, output_tokens: 1 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const provider = await OpenAiCompatibleProvider.create({
      id: "anthropic-api",
      type: "openai",
      baseUrl: "https://api.anthropic.com/v1",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      models: [{ id: modelId, providerModel: modelId, manualOnly: true, autoEligible: false, capabilities: ["chat", "responses", "tools", "reasoning"] }],
    });
    await fn(provider, bodies, headers, urls);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  }
}

function request(overrides: Partial<UnifiedRequest> = {}): UnifiedRequest {
  return {
    requestId: "fable-fixture",
    requestKind: "chat_completions",
    model: modelId,
    providerModel: modelId,
    messages: [{ role: "user", content: "Synthetic fixture" }],
    tools: [],
    ...overrides,
  };
}

test("Claude Fable 5.2 maps effort, defaults 128K output, and omits illegal sampling and thinking", async () => {
  await withAnthropicProvider(async (provider, bodies, headers, urls) => {
    const result = await provider.run(request({
      reasoningEffort: "xhigh",
      metadata: { temperature: 0, top_p: 0.1, top_k: 8, max_tokens: 200000, thinking: { type: "adaptive" } },
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    }));
    assert.equal(bodies.length, 1);
    const body = bodies[0]!;
    assert.equal(body.model, modelId);
    assert.deepEqual(body.output_config, { effort: "xhigh" });
    assert.equal(body.temperature, undefined);
    assert.equal(body.top_p, undefined);
    assert.equal(body.top_k, undefined);
    assert.equal(body.thinking, undefined);
    assert.equal(body.max_tokens, 128000);
    assert.ok(Array.isArray(body.tools) && body.tools.length === 1);
    assert.equal(result.reasoningEffortForwarded, "xhigh");
    assert.equal(urls[0], "https://api.anthropic.com/v1/messages");
    assert.equal(headers[0]?.get("x-api-key"), "test-key");
    assert.equal(headers[0]?.get("anthropic-version"), "2026-10-21");
    assert.equal(headers[0]?.get("authorization"), null);

    bodies.length = 0;
    await provider.run(request({ reasoningEffort: "none" }));
    assert.deepEqual(bodies[0]?.output_config, { effort: "low" });
    assert.equal(bodies[0]?.max_tokens, 128000);

    bodies.length = 0;
    await provider.run(request({ reasoningEffort: "minimal", metadata: { max_tokens: 1024 } }));
    assert.deepEqual(bodies[0]?.output_config, { effort: "low" });
    assert.equal(bodies[0]?.max_tokens, 1024);

    bodies.length = 0;
    await provider.run(request({ metadata: { reasoning_effort: "max" }, reasoningEffort: "xhigh" }));
    assert.deepEqual(bodies[0]?.output_config, { effort: "max" });

    bodies.length = 0;
    await provider.run(request());
    assert.equal(bodies[0]?.output_config, undefined);
    assert.equal(bodies[0]?.max_tokens, 128000);

    await assert.rejects(() => provider.run(request({ reasoningEffort: "ultra" as UnifiedRequest["reasoningEffort"] })), /MODEL_EFFORT_UNSUPPORTED/);
    await assert.rejects(() => provider.run(request({ metadata: { thinking: { type: "disabled" } } })), /ADAPTIVE_THINKING_REQUIRED/);
    await assert.rejects(() => provider.run(request({ metadata: { thinking: { type: "enabled", budget_tokens: 1024 } } })), /ADAPTIVE_THINKING_REQUIRED/);
    await assert.rejects(
      () => provider.run(request({
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
        metadata: { tool_choice: "any" },
      })),
      /forced tool_choice/,
    );
  });
});

// Synthetic byte fixture for transport tests only.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
const imagePart = { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg}` } };

function withEnv(t: { after(fn: () => void): void }, values: Record<string, string | undefined>): void {
  const prior = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("Anthropic image input is opt-in and sends base64 image blocks before text", async (t) => {
  withEnv(t, { [ANTHROPIC_IMAGE_INPUT_FLAG]: "1", [IMAGE_INPUT_FLAG]: undefined });
  const messages = normalizeChatMessages([{ role: "user", content: [{ type: "text", text: "Inspect" }, imagePart] }]);
  assert.deepEqual(messages, [{ role: "user", content: "Inspect", inputImages: [{ mediaType: "image/jpeg", data: jpeg }] }]);

  const receipts: unknown[] = [];
  const admitted = imageRequest({
    ...request({ messages }),
    receipt: (row) => receipts.push(row),
    metadata: { gateway_policy: { operationId: "fixture", allowFallback: true, maxAttempts: 8, maxLatencyMs: 5000 } },
  }, "anthropic-api", modelId);
  assert.deepEqual(admitted.metadata?.gateway_policy, { operationId: "fixture", allowFallback: false, maxAttempts: 1, maxLatencyMs: 5000 });
  assert.equal((receipts[0] as { images: number }).images, 1);
  assert.equal(JSON.stringify(receipts).includes(jpeg), false);
  assert.throws(() => imageRequest({ ...request({ messages }), stream: true }, "anthropic-api", modelId), /IMAGE_ROUTE_UNSUPPORTED/);
  assert.throws(() => imageRequest({ ...request({ messages }), requestKind: "responses" }, "anthropic-api", modelId), /IMAGE_ROUTE_UNSUPPORTED/);
  // The Anthropic opt-in does not open the Kimi binding or any other provider.
  assert.throws(() => imageRequest(request({ messages }), "kimi-code-api", "kimi-k3"), /IMAGE_INPUT_DISABLED/);
  assert.throws(() => imageRequest(request({ messages }), "deepseek-api", "deepseek-v4-pro"), /IMAGE_ROUTE_UNSUPPORTED/);

  await withAnthropicProvider(async (provider, bodies) => {
    const result = await provider.run(request({ messages, reasoningEffort: "high" }));
    assert.equal(result.outputText, "ok");
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0]?.messages, [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg } },
        { type: "text", text: "Inspect" },
      ],
    }]);
    assert.deepEqual(bodies[0]?.output_config, { effort: "high" });

    // The Kimi opt-in alone does not open the Anthropic adapter.
    process.env[IMAGE_INPUT_FLAG] = "1";
    delete process.env[ANTHROPIC_IMAGE_INPUT_FLAG];
    bodies.length = 0;
    assert.throws(() => imageRequest(request({ messages }), "anthropic-api", modelId), /IMAGE_INPUT_DISABLED/);
    await assert.rejects(() => provider.run(request({ messages })), /IMAGE_ROUTE_UNSUPPORTED/);
    assert.equal(bodies.length, 0);
  });

  delete process.env[IMAGE_INPUT_FLAG];
  assert.throws(() => normalizeChatMessages([{ role: "user", content: [imagePart] }]), /IMAGE_INPUT_DISABLED/);
});

test("Anthropic adapter translates response_format json_schema to output_config.format", async () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, demo_requested: { type: "boolean" } },
    required: ["name", "demo_requested"],
    additionalProperties: false,
  };
  await withAnthropicProvider(async (provider, bodies) => {
    await provider.run(request({
      reasoningEffort: "medium",
      metadata: { response_format: { type: "json_schema", json_schema: { name: "lead", strict: true, schema } } },
    }));
    assert.deepEqual(bodies[0]?.output_config, { effort: "medium", format: { type: "json_schema", schema } });

    bodies.length = 0;
    await provider.run(request({ requestKind: "responses", metadata: { text: { format: { type: "json_schema", name: "lead", schema } } } }));
    assert.deepEqual(bodies[0]?.output_config, { format: { type: "json_schema", schema } });

    bodies.length = 0;
    await provider.run(request({ metadata: { response_format: { type: "text" } } }));
    assert.equal(bodies[0]?.output_config, undefined);

    bodies.length = 0;
    await assert.rejects(() => provider.run(request({ metadata: { response_format: { type: "json_object" } } })), /require a JSON schema/);
    await assert.rejects(() => provider.run(request({ metadata: { response_format: { type: "json_schema", json_schema: { name: "lead" } } } })), /requires a schema object/);
    await assert.rejects(() => provider.run(request({ metadata: { response_format: { type: "grammar" } } })), /Unsupported response_format type/);
    await assert.rejects(() => provider.run(request({ metadata: { response_format: "json" } })), /must be an object/);
    assert.equal(bodies.length, 0);
  });
});

test("Rancher bundle keeps ANTHROPIC_API_KEY optional and the gateway starts without it", async (t) => {
  const deployment = rancherDocuments().find((doc) => doc?.kind === "Deployment");
  const gateway = deployment.spec.template.spec.containers.find((container: { env?: Array<{ name: string }> }) => container.env?.some((entry) => entry.name === "PROVIDERS_CONFIG_PATH"));
  const env = gateway.env.filter((entry: { name: string }) => entry.name === "ANTHROPIC_API_KEY");
  assert.deepEqual(env, [{
    name: "ANTHROPIC_API_KEY",
    valueFrom: { secretKeyRef: { name: "n8n-openai-cli-gateway-secrets", key: "anthropicApiKey", optional: true } },
  }]);
  assert.doesNotMatch(readFileSync("kubernetes/rancher-install.yaml", "utf8"), /sk-ant-/);

  withEnv(t, { ANTHROPIC_API_KEY: undefined });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new TypeError("network disabled in test"); }) as typeof fetch;
  const dir = mkdtempSync(path.join(tmpdir(), "fable-rancher-"));
  t.after(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, "providers.yaml");
  writeFileSync(file, rancherProvidersYaml());
  const registry = await ProviderRegistry.create(loadProvidersFile(file).providers);
  const provider = registry.getProvider("anthropic-api");
  assert.ok(provider);
  assert.equal(calls, 0);
  assert.deepEqual(await provider.checkAuthStatus(), { ok: false, exitCode: 1, stdout: "", stderr: "ANTHROPIC_API_KEY is not set" });
  await assert.rejects(() => provider.run(request()), /ANTHROPIC_API_KEY is not set/);
  assert.equal(calls, 0);
});
