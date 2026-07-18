import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRemoteAgentCliCommand,
  parseGrokStreamingLine,
} from "../scripts/remote-agent-session-bridge";

test("builds bounded headless Grok Build remote-agent command", () => {
  const command = buildRemoteAgentCliCommand("grok", "Inspect the remote target.", "grok-build");
  assert.equal(command.executable, "grok");
  assert.deepEqual(command.args.slice(-2), ["--single", "Inspect the remote target."]);
  assert.equal(command.args.includes("bypassPermissions"), true);
  assert.equal(command.args.includes("strict"), true);
  assert.equal(command.args.includes("--disable-web-search"), true);
  assert.deepEqual(command.args.slice(-4), ["--output-format", "streaming-json", "--single", "Inspect the remote target."]);
  assert.deepEqual(command.args.slice(0, 4), ["--no-auto-update", "--model", "grok-build", "--permission-mode"]);
});

test("resumes a Grok Build session and extracts its structured session id", () => {
  const sessionId = "019f6357-10a2-7f61-9bf8-541fa830de18";
  const command = buildRemoteAgentCliCommand(
    "grok",
    "Continue the remote task.",
    "grok-build",
    sessionId,
  );
  assert.deepEqual(command.args.slice(-4), ["--resume", sessionId, "--single", "Continue the remote task."]);
  assert.deepEqual(
    parseGrokStreamingLine('{"type":"text","data":"REMOTE_AGENT_RESULT: success done"}'),
    { text: "REMOTE_AGENT_RESULT: success done" },
  );
  assert.deepEqual(
    parseGrokStreamingLine(`{"type":"end","sessionId":"${sessionId}"}`),
    { sessionId },
  );
});

test("forwards Kimi K3 selection to the installed non-interactive CLI command", () => {
  const command = buildRemoteAgentCliCommand("kimi", "Inspect the remote target.", "k3");
  assert.equal(command.executable, "kimi");
  assert.deepEqual(command.args, [
    "--quiet",
    "--afk",
    "--model",
    "k3",
    "--prompt",
    "Inspect the remote target.",
  ]);
});
