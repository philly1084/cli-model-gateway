import test from "node:test";
import assert from "node:assert/strict";
import { OpenAiCompatibleProvider } from "../providers/openai-compatible-provider";

type CapturedRequestBody = {
  session_id?: string;
  thread_id?: string;
  clientSurface?: string;
  taskType?: string;
  metadata?: Record<string, unknown>;
  model?: string;
  messages?: Array<Record<string, unknown>>;
  tools?: unknown[];
  tool_choice?: unknown;
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  thinking?: Record<string, unknown>;
  reasoning_effort?: string;
  reasoning_format?: string;
  include_reasoning?: boolean;
  prompt?: string;
  n?: number;
  size?: string;
  quality?: string;
  style?: string;
};

test("OpenAiCompatibleProvider forwards remote session metadata and approval flags", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TEST_REMOTE_API_KEY;
  let capturedBody: CapturedRequestBody = {};
  let didCaptureBody = false;

  process.env.TEST_REMOTE_API_KEY = "test-key";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body ?? "{}")) as CapturedRequestBody;
    didCaptureBody = true;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "ok",
            },
            finish_reason: "stop",
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }) as typeof fetch;

  try {
    const provider = await OpenAiCompatibleProvider.create({
      id: "remote-router",
      type: "openai",
      baseUrl: "https://example.invalid",
      apiKeyEnv: "TEST_REMOTE_API_KEY",
      models: [
        {
          id: "gpt-remote",
        },
      ],
    });

    const result = await provider.run({
      requestId: "req_1",
      model: "gpt-remote",
      providerModel: "gpt-remote",
      messages: [
        {
          role: "user",
          content: "you can use remote command",
        },
      ],
      tools: [],
      metadata: {
        session_id: "session-123",
        clientSurface: "chatgpt",
        taskType: "remote-build",
        metadata: {
          thread_id: "thread-456",
          remoteBuildAutonomyApproved: true,
        },
      },
    });

    assert.equal(result.outputText, "ok");
    if (!didCaptureBody) {
      throw new Error("Expected provider request body to be captured.");
    }
    assert.equal(capturedBody.session_id, "session-123");
    assert.equal(capturedBody.thread_id, "thread-456");
    assert.equal(capturedBody.clientSurface, "chatgpt");
    assert.equal(capturedBody.taskType, "remote-build");
    assert.deepStrictEqual(capturedBody.metadata, {
      session_id: "session-123",
      thread_id: "thread-456",
      clientSurface: "chatgpt",
      taskType: "remote-build",
      remoteBuildAutonomyApproved: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.TEST_REMOTE_API_KEY;
    } else {
      process.env.TEST_REMOTE_API_KEY = originalApiKey;
    }
  }
});

test("OpenAiCompatibleProvider rejects DeepSeek thinking tool turns without reasoning_content round-trip", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TEST_REMOTE_API_KEY;
  let providerCalled = false;

  process.env.TEST_REMOTE_API_KEY = "test-key";
  globalThis.fetch = (async () => {
    providerCalled = true;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_status",
                  type: "function",
                  function: {
                    name: "check_status",
                    arguments: "{\"service\":\"api\"}",
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }) as typeof fetch;

  try {
    const provider = await OpenAiCompatibleProvider.create({
      id: "deepseek-api",
      type: "openai",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "TEST_REMOTE_API_KEY",
      models: [
        {
          id: "deepseek-reasoner",
          providerModel: "deepseek-reasoner",
        },
      ],
    });

    await assert.rejects(
      provider.run({
        requestId: "req_2",
        model: "deepseek-reasoner",
        providerModel: "deepseek-reasoner",
        messages: [
          {
            role: "user",
            content: "Use the tool if needed.",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "check_status",
            },
          },
        ],
        metadata: {
          session_id: "session-123",
          reasoning_format: "parsed",
          include_reasoning: true,
        },
      }),
      /requires reasoning_content round-tripping/i,
    );
    assert.equal(providerCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.TEST_REMOTE_API_KEY;
    } else {
      process.env.TEST_REMOTE_API_KEY = originalApiKey;
    }
  }
});

test("OpenAiCompatibleProvider forwards Groq local tool calls for chat models", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TEST_REMOTE_API_KEY;
  let capturedBody: CapturedRequestBody = {};

  process.env.TEST_REMOTE_API_KEY = "test-key";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body ?? "{}")) as CapturedRequestBody;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              reasoning: "Chose the status lookup tool.",
              tool_calls: [
                {
                  id: "call_status",
                  type: "function",
                  function: {
                    name: "check_status",
                    arguments: "{\"service\":\"api\"}",
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }) as typeof fetch;

  try {
    const provider = await OpenAiCompatibleProvider.create({
      id: "groq-api",
      type: "openai",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKeyEnv: "TEST_REMOTE_API_KEY",
      models: [
        {
          id: "openai/gpt-oss-20b",
          providerModel: "openai/gpt-oss-20b",
        },
      ],
      discovery: {
        enabled: false,
      },
    });

    const result = await provider.run({
      requestId: "req_groq_1",
      model: "openai/gpt-oss-20b",
      providerModel: "openai/gpt-oss-20b",
      messages: [
        {
          role: "user",
          content: "Use the tool if needed.",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "check_status",
          },
        },
      ],
      reasoningEffort: "xhigh",
      metadata: {
        session_id: "session-123",
        reasoning_format: "raw",
        include_reasoning: true,
      },
    });

    assert.equal(capturedBody.model, "openai/gpt-oss-20b");
    assert.equal(capturedBody.reasoning_effort, "high");
    assert.equal(capturedBody.include_reasoning, true);
    assert.equal(capturedBody.reasoning_format, undefined);
    assert.equal(capturedBody.session_id, undefined);
    assert.equal(capturedBody.metadata, undefined);
    assert.equal(capturedBody.tools?.length, 1);
    assert.equal(result.finishReason, "tool_calls");
    assert.equal(result.reasoningText, "Chose the status lookup tool.");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.TEST_REMOTE_API_KEY;
    } else {
      process.env.TEST_REMOTE_API_KEY = originalApiKey;
    }
  }
});

test("OpenAiCompatibleProvider normalizes Kimi K2 request knobs", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TEST_REMOTE_API_KEY;
  let capturedBody: CapturedRequestBody = {};

  process.env.TEST_REMOTE_API_KEY = "test-key";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body ?? "{}")) as CapturedRequestBody;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "ok",
            },
            finish_reason: "stop",
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }) as typeof fetch;

  try {
    const provider = await OpenAiCompatibleProvider.create({
      id: "kimi-api",
      type: "openai",
      baseUrl: "https://api.moonshot.ai/v1",
      apiKeyEnv: "TEST_REMOTE_API_KEY",
      models: [
        {
          id: "kimi-k2.6",
          providerModel: "kimi-k2.6",
        },
      ],
      discovery: {
        enabled: false,
      },
    });

    await provider.run({
      requestId: "req_kimi_1",
      model: "kimi-k2.6",
      providerModel: "kimi-k2.6",
      messages: [
        {
          role: "user",
          content: "Use the tool if needed.",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "check_status",
          },
        },
      ],
      metadata: {
        temperature: 0.2,
        top_p: 0.5,
        presence_penalty: 0.5,
        frequency_penalty: 0.5,
        max_completion_tokens: 512,
        include_reasoning: true,
        reasoning_format: "raw",
        thinking: { type: "disabled" },
        tool_choice: {
          type: "function",
          function: { name: "check_status" },
        },
      },
    });

    assert.equal(capturedBody.model, "kimi-k2.6");
    assert.equal(capturedBody.temperature, undefined);
    assert.equal(capturedBody.top_p, undefined);
    assert.equal(capturedBody.presence_penalty, undefined);
    assert.equal(capturedBody.frequency_penalty, undefined);
    assert.equal(capturedBody.max_completion_tokens, 512);
    assert.equal(capturedBody.max_tokens, undefined);
    assert.equal(capturedBody.include_reasoning, undefined);
    assert.equal(capturedBody.reasoning_format, undefined);
    assert.deepEqual(capturedBody.thinking, { type: "disabled" });
    assert.equal(capturedBody.tool_choice, "auto");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.TEST_REMOTE_API_KEY;
    } else {
      process.env.TEST_REMOTE_API_KEY = originalApiKey;
    }
  }
});

test("OpenAiCompatibleProvider rejects Groq compound gateway-managed tool turns", async () => {
  const originalApiKey = process.env.TEST_REMOTE_API_KEY;
  process.env.TEST_REMOTE_API_KEY = "test-key";

  try {
    const provider = await OpenAiCompatibleProvider.create({
      id: "groq-api",
      type: "openai",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKeyEnv: "TEST_REMOTE_API_KEY",
      models: [
        {
          id: "groq/compound",
          providerModel: "groq/compound",
        },
      ],
      discovery: {
        enabled: false,
      },
    });

    await assert.rejects(
      provider.run({
        requestId: "req_groq_2",
        model: "groq/compound",
        providerModel: "groq/compound",
        messages: [
          {
            role: "user",
            content: "Use the tool if needed.",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "check_status",
            },
          },
        ],
      }),
      /does not reliably support gateway-managed tool calling/i,
    );
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.TEST_REMOTE_API_KEY;
    } else {
      process.env.TEST_REMOTE_API_KEY = originalApiKey;
    }
  }
});

test("OpenAiCompatibleProvider maps Groq Qwen reasoning effort", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TEST_REMOTE_API_KEY;
  let capturedBody: CapturedRequestBody = {};

  process.env.TEST_REMOTE_API_KEY = "test-key";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body ?? "{}")) as CapturedRequestBody;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "ok",
            },
            finish_reason: "stop",
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }) as typeof fetch;

  try {
    const provider = await OpenAiCompatibleProvider.create({
      id: "groq-api",
      type: "openai",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKeyEnv: "TEST_REMOTE_API_KEY",
      models: [
        {
          id: "qwen/qwen3-32b",
          providerModel: "qwen/qwen3-32b",
        },
      ],
      discovery: {
        enabled: false,
      },
    });

    await provider.run({
      requestId: "req_groq_qwen",
      model: "qwen/qwen3-32b",
      providerModel: "qwen/qwen3-32b",
      messages: [
        {
          role: "user",
          content: "hi",
        },
      ],
      tools: [],
      reasoningEffort: "minimal",
    });

    assert.equal(capturedBody.reasoning_effort, "none");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.TEST_REMOTE_API_KEY;
    } else {
      process.env.TEST_REMOTE_API_KEY = originalApiKey;
    }
  }
});

test("OpenAiCompatibleProvider normalizes reasoning_content into reasoningText", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TEST_REMOTE_API_KEY;

  process.env.TEST_REMOTE_API_KEY = "test-key";
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "ok",
              reasoning_content: [
                {
                  type: "summary_text",
                  text: "Checked the provider payload before answering.",
                },
              ],
            },
            finish_reason: "stop",
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }) as typeof fetch;

  try {
    const provider = await OpenAiCompatibleProvider.create({
      id: "remote-router",
      type: "openai",
      baseUrl: "https://example.invalid",
      apiKeyEnv: "TEST_REMOTE_API_KEY",
      models: [
        {
          id: "gpt-remote",
        },
      ],
    });

    const result = await provider.run({
      requestId: "req_reasoning_1",
      model: "gpt-remote",
      providerModel: "gpt-remote",
      messages: [
        {
          role: "user",
          content: "hi",
        },
      ],
      tools: [],
    });

    assert.equal(result.outputText, "ok");
    assert.equal(result.reasoningText, "Checked the provider payload before answering.");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.TEST_REMOTE_API_KEY;
    } else {
      process.env.TEST_REMOTE_API_KEY = originalApiKey;
    }
  }
});

test("OpenAiCompatibleProvider routes image generation requests to /images/generations", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TEST_REMOTE_API_KEY;
  let capturedUrl = "";
  let capturedBody: CapturedRequestBody = {};

  process.env.TEST_REMOTE_API_KEY = "test-key";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedBody = JSON.parse(String(init?.body ?? "{}")) as CapturedRequestBody;
    return new Response(
      JSON.stringify({
        created: 1,
        data: [
          {
            b64_json: "abc123",
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }) as typeof fetch;

  try {
    const provider = await OpenAiCompatibleProvider.create({
      id: "openai-image-api",
      type: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "TEST_REMOTE_API_KEY",
      models: [
        {
          id: "gpt-image-1.5",
          providerModel: "gpt-image-1.5",
        },
      ],
    });

    const result = await provider.run({
      requestId: "req_img_1",
      model: "gpt-image-1.5",
      providerModel: "gpt-image-1.5",
      messages: [
        {
          role: "user",
          content: "Generate a modern product hero image.",
        },
      ],
      tools: [],
      requestKind: "images_generations",
      metadata: {
        prompt: "Generate a modern product hero image.",
        n: 2,
        size: "1024x1024",
        quality: "high",
        style: "vivid",
      },
    });

    assert.match(capturedUrl, /\/images\/generations$/);
    assert.equal(capturedBody.model, "gpt-image-1.5");
    assert.equal(capturedBody.prompt, "Generate a modern product hero image.");
    assert.equal(capturedBody.n, 2);
    assert.equal(capturedBody.size, "1024x1024");
    assert.equal(capturedBody.quality, "high");
    assert.equal(capturedBody.style, "vivid");
    assert.equal(result.outputText, "");
    assert.deepStrictEqual(result.raw, {
      created: 1,
      data: [
        {
          b64_json: "abc123",
        },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.TEST_REMOTE_API_KEY;
    } else {
      process.env.TEST_REMOTE_API_KEY = originalApiKey;
    }
  }
});
