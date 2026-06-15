import test from "node:test";
import assert from "node:assert/strict";
import { CliProvider } from "../providers/cli-provider";
import type { CliProviderConfig, UnifiedRequest } from "../types";

function createRequest(): UnifiedRequest {
  return {
    requestId: "req_1",
    model: "demo-model",
    providerModel: "demo-model",
    messages: [
      {
        role: "user",
        content: "Check the provider output.",
      },
    ],
    tools: [],
  };
}

function createProvider(script: string): CliProvider {
  const config: CliProviderConfig = {
    id: "demo-cli",
    type: "cli",
    models: [
      {
        id: "demo-model",
        providerModel: "demo-model",
      },
    ],
    responseCommand: {
      executable: process.execPath,
      args: ["-e", script],
      input: "request_json_stdin",
      output: "json_contract",
      timeoutMs: 1000,
    },
  };

  return new CliProvider(config);
}

test("CliProvider preserves top-level summary_text as reasoningText", async () => {
  const provider = createProvider(
    "process.stdout.write(JSON.stringify({ output_text: 'ok', summary_text: 'Checked the prior tool output.', finish_reason: 'stop' }))",
  );

  const result = await provider.run(createRequest());

  assert.equal(result.outputText, "ok");
  assert.equal(result.reasoningText, "Checked the prior tool output.");
});

test("CliProvider preserves top-level reasoning_content arrays as reasoningText", async () => {
  const provider = createProvider(
    "process.stdout.write(JSON.stringify({ output_text: 'ok', reasoning_content: [{ type: 'summary_text', text: 'Planned the next step first.' }], finish_reason: 'stop' }))",
  );

  const result = await provider.run(createRequest());

  assert.equal(result.outputText, "ok");
  assert.equal(result.reasoningText, "Planned the next step first.");
});

test("CliProvider bounds stalled image generation commands", async () => {
  const previous = process.env.CODEX_APPSERVER_IMAGE_NO_PROGRESS_TIMEOUT_MS;
  const previousGrace = process.env.CODEX_APPSERVER_IMAGE_COMMAND_GRACE_MS;
  process.env.CODEX_APPSERVER_IMAGE_NO_PROGRESS_TIMEOUT_MS = "100";
  process.env.CODEX_APPSERVER_IMAGE_COMMAND_GRACE_MS = "15";
  try {
    const provider = createProvider("setTimeout(() => {}, 1000)");
    await assert.rejects(
      provider.run({
        ...createRequest(),
        requestKind: "images_generations",
      }),
      /Provider command timed out after 115ms\./,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.CODEX_APPSERVER_IMAGE_NO_PROGRESS_TIMEOUT_MS;
    } else {
      process.env.CODEX_APPSERVER_IMAGE_NO_PROGRESS_TIMEOUT_MS = previous;
    }
    if (previousGrace === undefined) {
      delete process.env.CODEX_APPSERVER_IMAGE_COMMAND_GRACE_MS;
    } else {
      process.env.CODEX_APPSERVER_IMAGE_COMMAND_GRACE_MS = previousGrace;
    }
  }
});
