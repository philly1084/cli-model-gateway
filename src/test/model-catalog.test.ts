import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import type { CliProviderConfig, ProviderModelConfig } from "../types";
import { ProviderRegistry } from "../providers/registry";

type CatalogProvider = { id: string; description?: string; models: ProviderModelConfig[] };
const baseline = JSON.parse(readFileSync("src/test/fixtures/catalog-routing-baseline.json", "utf8")) as {
  providers: CatalogProvider[];
};
const reference = JSON.parse(readFileSync("docs/models-opt-in-2026-10-13.json", "utf8"));
const newIds: string[] = reference.providers.flatMap((p: { models: ProviderModelConfig[] }) => p.models.map(m => m.id));

function rancherProviders(): CatalogProvider[] {
  const docs = YAML.parseAllDocuments(readFileSync("kubernetes/rancher-install.yaml", "utf8"));
  for (const doc of docs) assert.deepEqual(doc.errors, []);
  const config = docs.map(doc => doc.toJSON()).find(doc => doc?.kind === "ConfigMap" && doc.data?.["providers.yaml"]);
  return YAML.parse(config.data["providers.yaml"]).providers;
}

function offlineProviders(providers: CatalogProvider[]): CliProviderConfig[] {
  // Preserve all ranking inputs but replace execution/discovery with inert CLI adapters.
  return providers.map(provider => ({ ...provider, type: "cli", responseCommand: {
    executable: "offline-test-must-not-execute", args: [], input: "request_json_stdin",
    output: "json_contract", timeoutMs: 1,
  } }));
}

test("verified reference selectors are exposed only as manual models", () => {
  assert.equal(reference.status, "reference-only-not-loaded");
  assert.deepEqual(newIds, ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "deepseek-flash"]);
  for (const provider of reference.providers) for (const model of provider.models) {
    assert.equal(model.autoEligible, false);
    assert.equal(model.providerModel, model.id);
  }
  for (const providers of [rancherProviders(), YAML.parse(readFileSync("config/providers.example.yaml", "utf8")).providers]) {
    for (const id of newIds) {
      const model = providers.flatMap((p: CatalogProvider) => p.models).find((m: ProviderModelConfig) => m.id === id);
      assert.ok(model, id); assert.equal(model.manualOnly, true); assert.equal(model.autoEligible, false);
    }
  }
});

test("existing routing positions, scores and selections match the pinned baseline", async () => {
  const current = rancherProviders();
  const routingShape = (providers: CatalogProvider[]) => providers.map(p => ({
    id: p.id, models: p.models.filter(m => !m.manualOnly).map(({ description: _description, ...model }) => model),
  })).filter(p => p.models.length > 0);
  assert.deepEqual(routingShape(current), routingShape(baseline.providers));
  const before = await ProviderRegistry.create(offlineProviders(baseline.providers));
  const after = await ProviderRegistry.create(offlineProviders(current));
  const prompts = ["Hello", "Compare the deployment options and plan the rollout.",
    "Debug and refactor this multi-step TypeScript API architecture.", "Analyze ".repeat(1800)];
  for (const measured of [false, true]) {
    if (measured) {
      // Near-tie measurements expose accidental changes to the positional penalty.
      for (const [index, model] of before.listModels().filter(m => m.id !== "auto").entries()) {
        for (const registry of [before, after]) registry.recordModelBenchmark({
          modelId: model.id, providerId: model.providerId, providerModel: model.providerModel,
          status: "succeeded", score: 10 + index * 0.01,
          taskScores: { overall: 10 + index * 0.01, quick: 10 + index * 0.01, medium: 10 + index * 0.01, reasoningHigh: 10 + index * 0.01 },
        });
      }
    }
    for (const content of prompts) for (const reasoningEffort of [undefined, "high"] as const) {
      const request = { messages: [{ role: "user" as const, content }], tools: [], requestKind: "chat_completions", reasoningEffort };
      assert.deepEqual(after.explainAutoRouting(request), before.explainAutoRouting(request));
    }
  }
});

test("all-provider evidence covers every configured surface without enabling candidates", () => {
  const inventory = JSON.parse(readFileSync("docs/provider-inventory-2026-10-13.json", "utf8"));
  const candidates = JSON.parse(readFileSync("docs/provider-candidates-2026-10-13.json", "utf8"));
  const openrouter = JSON.parse(readFileSync("docs/openrouter-discovery-2026-10-13.json", "utf8"));
  assert.equal(candidates.status, "reference-only-not-loaded");
  const covered = new Set(inventory.providers.map((p: { id: string }) => p.id));
  const example = YAML.parse(readFileSync("config/providers.example.yaml", "utf8")).providers;
  for (const p of [...example, ...rancherProviders()]) assert.ok(covered.has(p.id), p.id);
  assert.equal(covered.size, 18);
  const keys = new Set<string>();
  for (const m of candidates.models) {
    assert.ok(covered.has(m.providerId));
    assert.equal(m.autoEligible, false);
    assert.match(m.source, /^https:\/\//);
    const key = `${m.providerId}:${m.id}`;
    assert.ok(!keys.has(key)); keys.add(key);
    if (m.providerId === "openrouter-free") {
      const evidence = openrouter.models.find((e: { id: string }) => e.id === m.providerModel);
      assert.ok(evidence, m.providerModel);
      assert.equal(evidence.pricing.prompt, "0");
      assert.equal(evidence.pricing.completion, "0");
      assert.ok(evidence.supported_parameters.includes("tools"));
      assert.equal(m.contextTokens, evidence.context_length);
      assert.ok(!m.providerModel.endsWith(":batch"));
    }
  }
  const code = inventory.providers.find((p: { id: string }) => p.id === "kimi-code-api").discovery;
  assert.equal(code.httpStatus, 200);
  for (const m of candidates.models.filter((m: { providerId: string }) => m.providerId === "kimi-code-api")) {
    assert.ok(code.models.some((e: { id: string }) => e.id === m.providerModel));
  }
});
