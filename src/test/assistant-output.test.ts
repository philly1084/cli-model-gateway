import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderResult } from "../types";
import {
  isSyntheticAssistantOutputText,
  normalizeAssistantResult,
  parseAssistantPayloadText,
} from "../utils/assistant-output";

test("unwraps leaked output_text JSON into plain assistant text", () => {
  const result: ProviderResult = {
    outputText: '{"output_text":"Hey there! How can I help you today?","finish_reason":"stop"}',
    toolCalls: [],
    finishReason: "stop",
  };

  const normalized = normalizeAssistantResult(result);
  assert.equal(normalized.outputText, "Hey there! How can I help you today?");
  assert.deepEqual(normalized.toolCalls, []);
  assert.equal(normalized.finishReason, "stop");
});

test("rejects leaked function payloads without a provider call identity", () => {
  assert.throws(() => normalizeAssistantResult({outputText:'{"type":"function","name":"update_notes_page","parameters":{"value":"example"}}',toolCalls:[],finishReason:"stop"}), /call_id_missing/);
});

test("treats assistant placeholder output as synthetic", () => {
  const parsed = parseAssistantPayloadText("<assistant reply>");
  assert.equal(parsed.outputText, "");
  assert.equal(parsed.synthetic, true);
  assert.equal(isSyntheticAssistantOutputText("<assistant reply>"), true);
  assert.equal(isSyntheticAssistantOutputText("Reply to the user directly."), true);
  assert.equal(
    isSyntheticAssistantOutputText("Provide your actual helpful response here."),
    true,
  );
});

test("treats Groq synthesis-failure text as synthetic", () => {
  assert.equal(
    isSyntheticAssistantOutputText(
      'I completed the request, but the final answer could not be synthesized from the model response.',
    ),
    true,
  );
});
