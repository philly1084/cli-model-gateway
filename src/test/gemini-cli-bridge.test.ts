import test from "node:test";
import assert from "node:assert/strict";
import { buildGeminiPrompt, parseGeminiStreamJsonOutput } from "../scripts/gemini-cli-bridge.js";

test("Gemini bridge promotes candidate functionCall parts into tool calls", () => {
  const rawOutput = JSON.stringify({
    candidates: [
      {
        content: {
          parts: [
            {
              functionCall: {
                name: "searchDocs",
                args: {
                  query: "oauth",
                },
              },
            },
          ],
        },
      },
    ],
  });

  const parsed = parseGeminiStreamJsonOutput(rawOutput, [
    {
      type: "function",
      function: {
        name: "search_docs",
      },
    },
  ]);

  assert.equal(parsed.output_text, "");
  assert.equal(parsed.finish_reason, "tool_calls");
  assert.deepEqual(parsed.tool_calls, [
    {
      id: "call_1",
      name: "search_docs",
      arguments: '{"query":"oauth"}',
    },
  ]);
});

test("Gemini bridge preserves direct final answers from stream-json text parts", () => {
  const rawOutput = JSON.stringify({
    candidates: [
      {
        content: {
          parts: [
            {
              text: "The provider is healthy again.",
            },
          ],
        },
      },
    ],
  });

  const parsed = parseGeminiStreamJsonOutput(rawOutput, []);

  assert.equal(parsed.output_text, "The provider is healthy again.");
  assert.equal(parsed.finish_reason, "stop");
  assert.equal(parsed.tool_calls, undefined);
});

test("Gemini bridge rejects malformed string arguments", () => {
  const output=JSON.stringify({type:"message",role:"assistant",content:JSON.stringify({tool_calls:[{id:"call_status",name:"check_status",arguments:'{"service":"api",}'}],finish_reason:"tool_calls"})});
  assert.throws(() => parseGeminiStreamJsonOutput(output, [{type:"function",function:{name:"check_status"}}]), /arguments_invalid_json/);
});

test("Gemini bridge prompt includes forced tool choice guidance", () => {
  const prompt = buildGeminiPrompt({
    messages: [
      {
        role: "user",
        content: "Check the status.",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "check_status",
          description: "Checks status.",
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

  assert.match(prompt, /MUST call exactly this function name: check_status/i);
  assert.match(prompt, /AVAILABLE_TOOL_NAMES:\ncheck_status/);
});
