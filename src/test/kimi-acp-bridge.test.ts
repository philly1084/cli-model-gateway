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

test("Kimi bridge leaves direct function examples as ordinary text", () => {
  assert.equal(parseJsonContractFromText('{"type":"function","name":"update_notes_page","parameters":{"value":"example"}}'), null);
});

test("Kimi bridge rejects malformed arguments instead of repairing them", () => {
  assert.throws(() => normalizeToolCallsFromContract([{id:"call_search",name:"searchDocs",arguments:'{"query":"oauth",}'}]), /arguments_invalid_json/);
  assert.deepEqual(normalizeToolCallsFromContract([{id:"call_search",name:"searchDocs",arguments:{query:"oauth"}}]), [{id:"call_search",name:"searchDocs",arguments:'{"query":"oauth"}'}]);
});

test("Kimi bridge preserves outer text authority and exact explicit calls", () => {
  const call = {id:"original-id",name:"search_docs",arguments:'{ "query": "oauth" }'};
  const nested = JSON.stringify({output_text:"",tool_calls:[call],finish_reason:"tool_calls"});
  assert.deepEqual(parseJsonContractFromText(JSON.stringify({output_text:nested,finish_reason:"stop"})), {
    output_text:nested,tool_calls:undefined,finish_reason:"stop"
  });
  assert.deepEqual(parseJsonContractFromText(nested)?.tool_calls,[call]);
  assert.equal(parseJsonContractFromText('Example: '+nested),null);
  assert.equal(parseJsonContractFromText('```json\n'+nested+'\n```'),null);
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
