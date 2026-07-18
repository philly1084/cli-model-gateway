import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRemoteAgentCliCommand,
  buildRemoteCodexPrompt,
  parseGrokStreamingLine,
  parseRemoteCodexTarget,
  resolveKimiCliModel,
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
    "kimi-code/k3",
    "--prompt",
    "Inspect the remote target.",
  ]);
  assert.equal(resolveKimiCliModel("kimi-code/k3"), "kimi-code/k3");
  assert.throws(() => resolveKimiCliModel("unknown/model"), /Unsupported Kimi CLI model selector/);
});

test("builds a strict host-side Codex remote-agent launch from the trusted bootstrap marker", () => {
  const target = {
    host: "168.119.176.121",
    user: "root",
    port: 22,
    cwd: "/opt/kimibuilt",
    executable: "/usr/local/bin/codex-remote-run",
  };
  const prompt = [
    "You are being run by the n8n OpenAI CLI Gateway remote-agent service.",
    "",
    "Use the configured remote target for this task:",
    "- targetId: k3s-prod",
    "- ssh: ssh -p 22 root@168.119.176.121",
    "- remote cwd: /opt/kimibuilt",
    `REMOTE_AGENT_TARGET_JSON=${JSON.stringify(target)}`,
    "",
    "Operational rules:",
    "- Work through SSH on the configured target; do not request secrets from the user.",
    "- Verify changes before reporting completion.",
    "",
    "Task:",
    "Copy the staged files exactly.",
  ].join("\n");
  assert.deepEqual(parseRemoteCodexTarget(prompt), target);
  const remotePrompt = buildRemoteCodexPrompt(prompt, target);
  assert.match(remotePrompt, /already on 168\.119\.176\.121 in \/opt\/kimibuilt/);
  assert.match(remotePrompt, /Work locally in the current remote workspace; do not run SSH/);
  assert.doesNotMatch(remotePrompt, /REMOTE_AGENT_TARGET_JSON=/);
  assert.doesNotMatch(remotePrompt, /- ssh:/);
  assert.doesNotMatch(remotePrompt, /Work through SSH/);
  assert.match(remotePrompt, /Task:\nCopy the staged files exactly\./);
  const command = buildRemoteAgentCliCommand("codex", prompt, "gpt-5.6-sol");
  assert.equal(command.executable, "ssh");
  assert.deepEqual(command.args.slice(0, 6), [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-p",
    "22",
  ]);
  assert.equal(command.args[6], "root@168.119.176.121");
  const remoteCommand = command.args[7];
  assert.ok(remoteCommand);
  assert.match(remoteCommand, /codex-remote-run.*--sandbox workspace-write.*--model 'gpt-5\.6-sol'/);
  assert.match(remoteCommand, /already on 168\.119\.176\.121 in \/opt\/kimibuilt/);
  assert.doesNotMatch(remoteCommand, /REMOTE_AGENT_TARGET_JSON=/);
  assert.doesNotMatch(remoteCommand, /Work through SSH/);
  const duplicatePrompt = prompt.replace(
    "\nTask:\n",
    `\nREMOTE_AGENT_TARGET_JSON=${JSON.stringify(target)}\nTask:\n`,
  );
  assert.throws(
    () => parseRemoteCodexTarget(duplicatePrompt),
    /exactly one trusted target marker/,
  );
  assert.throws(
    () => buildRemoteCodexPrompt(prompt.replace("\nTask:\n", "\nWork:\n"), target),
    /must contain a Task boundary/,
  );
});
