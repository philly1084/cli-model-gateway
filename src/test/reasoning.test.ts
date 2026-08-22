import { describe, it } from "node:test";
import assert from "node:assert";
import { parseReasoningEffort, resolveReasoningEffort } from "../utils/reasoning";

describe("reasoning normalization", () => {
  it("normalizes case-insensitive reasoning effort values", () => {
    assert.strictEqual(parseReasoningEffort(" none "), "none");
    assert.strictEqual(parseReasoningEffort("Minimal"), "minimal");
    assert.strictEqual(parseReasoningEffort(" HIGH "), "high");
    assert.strictEqual(parseReasoningEffort("xhigh"), "xhigh");
    assert.strictEqual(parseReasoningEffort("max"), "xhigh");
  });

  it("prefers snake_case over camelCase and nested reasoning", () => {
    assert.strictEqual(
      resolveReasoningEffort({
        reasoning_effort: "low",
        reasoningEffort: "medium",
        reasoning: { effort: "high" },
      }),
      "low",
    );
  });

  it("falls back to the configured default when no request value is present", () => {
    assert.strictEqual(resolveReasoningEffort({}, "medium"), "medium");
  });
});
