import test from "node:test";
import assert from "node:assert/strict";
import { buildRemoteAgentCliCommand } from "../scripts/remote-agent-session-bridge";

test("builds bounded headless Grok Build remote-agent command", () => {
  const command = buildRemoteAgentCliCommand("grok", "Inspect the remote target.", "grok-build");
  assert.equal(command.executable, "grok");
  assert.deepEqual(command.args.slice(-2), ["--single", "Inspect the remote target."]);
  assert.equal(command.args.includes("bypassPermissions"), true);
  assert.equal(command.args.includes("strict"), true);
  assert.equal(command.args.includes("--disable-web-search"), true);
  assert.deepEqual(command.args.slice(0, 4), ["--no-auto-update", "--model", "grok-build", "--permission-mode"]);
});

test("builds non-interactive Kimi remote-agent command", () => {
  const command = buildRemoteAgentCliCommand("kimi", "Inspect the remote target.");
  assert.equal(command.executable, "kimi");
  assert.deepEqual(command.args, ["--quiet", "--afk", "--prompt", "Inspect the remote target."]);
});
