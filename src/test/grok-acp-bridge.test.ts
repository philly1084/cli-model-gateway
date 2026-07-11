import test from "node:test";
import assert from "node:assert/strict";
import {
  extractGrokAgentText,
  selectGrokAuthMethod,
} from "../scripts/grok-acp-bridge.js";

test("Grok bridge prefers API-key auth when XAI_API_KEY is available", () => {
  const selected = selectGrokAuthMethod(
    {
      authMethods: [{ id: "cached_token" }, { id: "xai.api_key" }],
    },
    true,
  );

  assert.equal(selected, "xai.api_key");
});

test("Grok bridge falls back to the cached login token", () => {
  const selected = selectGrokAuthMethod(
    {
      authMethods: [{ id: "cached_token" }, { id: "xai.api_key" }],
    },
    false,
  );

  assert.equal(selected, "cached_token");
});

test("Grok bridge extracts ACP assistant message chunks", () => {
  const text = extractGrokAgentText({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello from Grok" },
      },
    },
  });

  assert.equal(text, "Hello from Grok");
});

test("Grok bridge ignores non-assistant ACP updates", () => {
  assert.equal(
    extractGrokAgentText({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          content: { text: "should not escape" },
        },
      },
    }),
    "",
  );
});
