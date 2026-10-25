import test from "node:test";
import assert from "node:assert/strict";
import { loadProvidersFile } from "../config.js";

const file = loadProvidersFile("config/providers.example.yaml");
const kimiCode = file.providers.find(p => p.id === "kimi-code-api");

test("Kimi K3.1 Pro lanes use Kimi Code endpoint model ids", () => {
  assert.ok(kimiCode, "kimi-code-api provider missing");
  const pro = kimiCode?.models?.find(m => m.id === "kimi-k3.1-pro");
  const fast = kimiCode?.models?.find(m => m.id === "kimi-k3.1-pro-highspeed");
  assert.equal(pro?.providerModel, "k3.1-pro");
  assert.equal(fast?.providerModel, "k3.1-pro-highspeed");
  assert.deepEqual(fast?.fallbackModels, ["kimi-k3.1-pro", "kimi-k3"]);
});

test("Kimi K3.1 Pro lanes are additive and never auto-routed", () => {
  for (const id of ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"]) {
    const model = kimiCode?.models?.find(m => m.id === id) as Record<string, unknown> | undefined;
    assert.equal(model?.manualOnly, true, `${id} manualOnly`);
    assert.equal(model?.autoEligible, false, `${id} autoEligible`);
  }
  const k3 = kimiCode?.models?.find(m => m.id === "kimi-k3");
  assert.equal(k3?.providerModel, "k3", "existing kimi-k3 lane unchanged");
});

test("Kimi K3.1 Pro model ids are unique across providers", () => {
  const ids = file.providers.flatMap(p => (p.models ?? []).map(m => m.id));
  for (const id of ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"]) {
    assert.equal(ids.filter(x => x === id).length, 1, id);
  }
});
