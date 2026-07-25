import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPrompt,
  extractKimiAgentTextChunk,
  findSafeModeValue,
  mergeKimiAgentTextChunks,
  normalizeToolCallsFromContract,
  parseJsonContractFromText,
} from "../scripts/kimi-acp-bridge.js";

test("Kimi bridge parses direct function payloads as tool calls", () => {
  const parsed = parseJsonContractFromText(
    '{"type":"function","name":"update_notes_page","parameters":{"notes_page_update":"Done"}}',
  );

  assert.deepEqual(parsed, {
    output_text: "",
    tool_calls: [
      {
        id: "call_1",
        name: "update_notes_page",
        arguments: '{"notes_page_update":"Done"}',
      },
    ],
    finish_reason: "tool_calls",
  });
});

test("Kimi bridge normalizes complex tool call shapes and repairs malformed arguments", () => {
  const calls = normalizeToolCallsFromContract([
    {
      functionCall: {
        name: "searchDocs",
        arguments: '{"query":"oauth",}',
      },
      call_id: "call_search",
    },
  ]);

  assert.deepEqual(calls, [
    {
      id: "call_search",
      name: "searchDocs",
      arguments: '{"query":"oauth"}',
    },
  ]);
});

test("Kimi bridge recovers nested tool contracts from assistant text", () => {
  const parsed = parseJsonContractFromText(
    '{"output_text":"{\\"output_text\\":\\"\\",\\"tool_calls\\":[{\\"id\\":\\"call_1\\",\\"name\\":\\"search_docs\\",\\"arguments\\":{\\"query\\":\\"oauth\\"}}],\\"finish_reason\\":\\"tool_calls\\"}","finish_reason":"stop"}',
  );

  assert.deepEqual(parsed, {
    output_text: "",
    tool_calls: [
      {
        id: "call_1",
        name: "search_docs",
        arguments: '{"query":"oauth"}',
      },
    ],
    finish_reason: "tool_calls",
  });
});

test("Kimi bridge prompt includes explicit available tool names and tool choice guidance", () => {
  const prompt = buildPrompt({
    messages: [
      {
        role: "user",
        content: "Check status",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "check_status",
          description: "Checks status",
        },
      },
    ],
    metadata: {
      tool_choice: {
        type: "function",
        function: {
          name: "check_status",
        },
      },
    },
  });

  assert.match(prompt, /AVAILABLE_TOOL_NAMES:\ncheck_status/);
  assert.match(prompt, /MUST call exactly this function name: check_status/i);
  assert.match(prompt, /Do not request local permissions/i);
});

test("Kimi bridge prefers chat mode over ask mode when both are available", () => {
  const selected = findSafeModeValue([
    {
      id: "mode",
      category: "mode",
      options: [
        { value: "ask", name: "Ask" },
        { value: "chat", name: "Chat" },
      ],
    },
  ]);

  assert.deepEqual(selected, {
    id: "mode",
    value: "chat",
  });
});

test("Kimi bridge concatenates ACP message chunks without inserting line breaks", () => {
  const updates = [
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "K" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "3" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "_CLI" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " " } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } },
  ];

  const chunks = updates.map(extractKimiAgentTextChunk);

  assert.equal(mergeKimiAgentTextChunks(chunks), "K3_CLI OK");
  assert.equal(
    extractKimiAgentTextChunk({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "internal reasoning" },
    }),
    "",
  );
});
