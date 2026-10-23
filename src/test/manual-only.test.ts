import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProvidersFile } from "../config";
import { ProviderRegistry } from "../providers/registry";
import type { CliProviderConfig, ProviderModelConfig, ProviderResult, UnifiedRequest } from "../types";

function provider(models: ProviderModelConfig[]): CliProviderConfig {
  return { id: "offline", type: "cli", models, responseCommand: {
    executable: "must-not-execute", args: [], input: "request_json_stdin",
    output: "json_contract", timeoutMs: 1000,
  } };
}
const request = { requestId: "manual-only-test", messages: [{ role: "user" as const, content: "Hello" }], tools: [] };
type Binding = { modelId: string; provider: { run: (request: UnifiedRequest) => Promise<ProviderResult> } };
type Internals = {
  models: Map<string, Binding>;
  selectBenchmarkCandidates(limit: number): Binding[];
  selectQualityEvaluatorBinding(preferred: string | undefined, tested: string): { binding?: Binding; error?: string };
};
const internal = (registry: ProviderRegistry) => registry as unknown as Internals;

test("manualOnly schema is optional and accepts only booleans", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gateway-manual-only-"));
  const file = path.join(dir, "providers.json");
  try {
    for (const value of [undefined, false, true]) {
      writeFileSync(file, JSON.stringify({ providers: [provider([{ id: "model", ...(value === undefined ? {} : { manualOnly: value }) }])] }));
      const model = loadProvidersFile(file).providers[0]!.models![0]!;
      assert.equal(model.manualOnly ?? false, value ?? false);
    }
    for (const value of ["true", 1, null]) {
      writeFileSync(file, JSON.stringify({ providers: [provider([{ id: "model", manualOnly: value } as unknown as ProviderModelConfig])] }));
      assert.throws(() => loadProvidersFile(file));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("manual insertion preserves legacy ranking positions, scores and selections including near ties", async () => {
  const legacy: ProviderModelConfig[] = [{ id: "alpha" }, { id: "legacy-explicit", autoEligible: false }, { id: "beta" }, { id: "gamma" }];
  const before = await ProviderRegistry.create([provider(legacy)]);
  const after = await ProviderRegistry.create([provider([
    { id: "manual-first", manualOnly: true, autoEligible: true }, ...legacy.slice(0, 2),
    { id: "manual-middle", manualOnly: true }, ...legacy.slice(2),
  ])]);
  assert.ok(after.listModels().some(model => model.id === "manual-first"));
  for (const measured of [false, true]) {
    if (measured) for (const [index, model] of legacy.entries()) for (const registry of [before, after]) {
      registry.recordModelBenchmark({ modelId: model.id, providerId: "offline", providerModel: model.id,
        status: "succeeded", score: 10 + index * 0.01,
        taskScores: { overall: 10 + index * 0.01, quick: 10 + index * 0.01, medium: 10 + index * 0.01, reasoningHigh: 10 + index * 0.01 } });
    }
    for (const content of ["Hello", "Debug this complex TypeScript architecture", "Analyze ".repeat(1800)]) {
      for (const reasoningEffort of [undefined, "high"] as const) {
        const input = { ...request, messages: [{ role: "user" as const, content }], reasoningEffort };
        assert.deepEqual(after.explainAutoRouting(input), before.explainAutoRouting(input));
      }
    }
  }
});

test("manual models never become benchmark candidates or automatic/configured quality judges", async () => {
  const registry = await ProviderRegistry.create([provider([
    { id: "manual", manualOnly: true, autoEligible: true },
    { id: "tested" }, { id: "legacy-judge", autoEligible: false },
  ])]);
  const access = internal(registry);
  for (const limit of [0, 1, 100]) assert.deepEqual(access.selectBenchmarkCandidates(limit).map(b => b.modelId), ["tested"]);
  assert.equal(access.selectQualityEvaluatorBinding(undefined, "tested").binding?.modelId, "legacy-judge");
  assert.equal(access.selectQualityEvaluatorBinding("legacy-judge", "tested").binding?.modelId, "legacy-judge");
  const forbidden = access.selectQualityEvaluatorBinding("manual", "tested");
  assert.equal(forbidden.binding, undefined);
  assert.ok(forbidden.error);
});

test("manual models allow explicit requests but cannot be implicit fallbacks", async () => {
  const registry = await ProviderRegistry.create([provider([
    { id: "primary", fallbackModels: ["manual", "backup"] },
    { id: "manual", manualOnly: true }, { id: "backup" },
  ])]);
  const called: string[] = [];
  // Replace the adapter boundary: no process, network or provider inference runs.
  internal(registry).models.get("primary")!.provider.run = async input => {
    called.push(input.model);
    if (input.model === "primary") throw new Error("offline simulated failure");
    return { outputText: "OK", toolCalls: [], finishReason: "stop" };
  };
  const direct = await registry.runModel("manual", request);
  assert.equal(direct.outputText, "OK");
  assert.deepEqual(called, ["manual"]);
  called.length = 0;
  await registry.runModel("primary", { ...request, requestId: "fallback-test" });
  assert.deepEqual(called, ["primary", "backup"]);
});

test("manual image models require explicit selection", async () => {
  const registry = await ProviderRegistry.create([provider([{ id: "manual-image", manualOnly: true, capabilities: ["image_generation"] }, { id: "legacy-image", capabilities: ["image_generation"] }])]);
  assert.equal(registry.resolvePreferredImageGenerationModel(), "legacy-image");
  assert.equal(registry.resolvePreferredImageGenerationModel("unknown"), "legacy-image");
  assert.equal(registry.resolvePreferredImageGenerationModel("manual-image"), "manual-image");
  const onlyManual = await ProviderRegistry.create([provider([{ id: "manual-image", manualOnly: true, capabilities: ["image_generation"] }])]);
  assert.equal(onlyManual.resolvePreferredImageGenerationModel(), undefined);
});
