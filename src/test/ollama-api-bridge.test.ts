import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOllamaChatRequest,
  buildOllamaMessages,
  parseOllamaChatResponse,
} from "../scripts/ollama-api-bridge.js";

test("Ollama bridge converts assistant TOOL_CALLS history and tool results", () => {
  const messages = buildOllamaMessages([
    {
      role: "user",
      content: "Check provider health.",
    },
    {
      role: "assistant",
      content:
        'Calling the health check.\n\nTOOL_CALLS:\n[{"id":"call_health","name":"check_status","arguments":"{\\"provider\\":\\"ollama\\"}"}]',
    },
    {
      role: "tool",
      tool_call_id: "call_health",
      content: '{"ok":true}',
    },
  ]);

  assert.deepEqual(messages, [
    {
      role: "user",
      content: "Check provider health.",
    },
    {
      role: "assistant",
      content: "Calling the health check.",
      tool_calls: [
        {
          function: {
            name: "check_status",
            arguments: {
              provider: "ollama",
            },
          },
        },
      ],
    },
    {
      role: "tool",
      tool_name: "check_status",
      content: '{"ok":true}',
    },
  ]);
});

test("Ollama bridge maps request metadata into native chat options", () => {
  const originalNumCtx = process.env.OLLAMA_NUM_CTX;
  const originalKeepAlive = process.env.OLLAMA_KEEP_ALIVE;

  process.env.OLLAMA_NUM_CTX = "8192";
  process.env.OLLAMA_KEEP_ALIVE = "30m";

  try {
    const body = buildOllamaChatRequest(
      {
        messages: [
          {
            role: "user",
            content: "Summarize this.",
          },
        ],
        reasoningEffort: "high",
        metadata: {
          max_tokens: 256,
          temperature: 0.2,
        },
      },
      "llama3.2",
    );

    assert.equal(body.model, "llama3.2");
    assert.equal(body.keep_alive, "30m");
    assert.equal(body.think, true);
    assert.deepEqual(body.options, {
      num_ctx: 8192,
      num_predict: 256,
      temperature: 0.2,
    });
  } finally {
    if (originalNumCtx === undefined) {
      delete process.env.OLLAMA_NUM_CTX;
    } else {
      process.env.OLLAMA_NUM_CTX = originalNumCtx;
    }

    if (originalKeepAlive === undefined) {
      delete process.env.OLLAMA_KEEP_ALIVE;
    } else {
      process.env.OLLAMA_KEEP_ALIVE = originalKeepAlive;
    }
  }
});

test("Ollama bridge normalizes native tool calls back into gateway contract", () => {
  const parsed = parseOllamaChatResponse(
    {
      message: {
        content: "",
        tool_calls: [
          {
            function: {
              name: "checkStatus",
              arguments: {
                provider: "ollama",
              },
            },
          },
        ],
      },
      done_reason: "stop",
    },
    [
      {
        type: "function",
        function: {
          name: "check_status",
        },
      },
    ],
  );

  assert.deepEqual(parsed, {
    output_text: "",
    tool_calls: [
      {
        id: "call_1",
        name: "check_status",
        arguments: '{"provider":"ollama"}',
      },
    ],
    finish_reason: "tool_calls",
  });
});
