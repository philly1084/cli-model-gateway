import test from "node:test";
import assert from "node:assert/strict";
import { ModelStatsTracker } from "../stats/model-stats";

test("missing provider API key failures are treated as config cooldowns", () => {
  const tracker = new ModelStatsTracker();
  tracker.registerModel({
    modelId: "kimi-k2.6",
    providerId: "kimi-api",
    providerModel: "kimi-k2.6",
    fallbackModels: ["gpt-5.5"],
  });

  const kind = tracker.recordFailure({
    modelId: "kimi-k2.6",
    requestedModelId: "kimi-k2.6",
    providerId: "kimi-api",
    providerModel: "kimi-k2.6",
    attemptIndex: 0,
    durationMs: 1,
    error: new Error("MOONSHOT_API_KEY is not set."),
  });

  const snapshot = tracker.snapshotModel("kimi-k2.6");

  assert.equal(kind, "config");
  assert.equal(snapshot?.lastFailureKind, "config");
  assert.equal(snapshot?.suggestedState, "cooldown");
  assert.ok((snapshot?.suggestedCooldownSeconds ?? 0) > 0);
});

test("three consecutive provider failures mark a model degraded", () => {
  const tracker = new ModelStatsTracker();
  tracker.registerModel({
    modelId: "gemini-3.5-flash",
    providerId: "gemini-cli",
    providerModel: "gemini-3.5-flash",
    fallbackModels: ["gpt-5.5"],
  });

  for (let attemptIndex = 0; attemptIndex < 3; attemptIndex += 1) {
    tracker.recordAttempt({
      modelId: "gemini-3.5-flash",
      requestedModelId: "gemini-3.5-flash",
      providerId: "gemini-cli",
      providerModel: "gemini-3.5-flash",
      attemptIndex,
    });
    tracker.recordFailure({
      modelId: "gemini-3.5-flash",
      requestedModelId: "gemini-3.5-flash",
      providerId: "gemini-cli",
      providerModel: "gemini-3.5-flash",
      attemptIndex,
      durationMs: 100,
      error: new Error("Provider command exited with code 1."),
    });
  }

  const snapshot = tracker.snapshotModel("gemini-3.5-flash");

  assert.equal(snapshot?.lastFailureKind, "provider_exit");
  assert.equal(snapshot?.suggestedState, "degraded");
});
