import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteReasoningFilter, supportsRemoteReasoning } from "../utils/remote-reasoning";
import { parseRemoteAgentArgs, buildRemoteAgentCliCommand } from "../scripts/remote-agent-session-bridge";
import { remoteAgentTaskCreateRequestSchema, providerSessionCreateRequestSchema } from "../validation";

test("remote reasoning schemas validate effort rather than silently passing unknown values", () => {
  const remote = { providerId: "codex-cli", targetId: "primary", task: "Check files" };
  for (const reasoningEffort of ["high", "low", "none"]) {
    assert.equal(remoteAgentTaskCreateRequestSchema.parse({ ...remote, reasoningEffort }).reasoningEffort, reasoningEffort);
    assert.equal(providerSessionCreateRequestSchema.parse({ providerId: "codex-cli", reasoningEffort }).reasoningEffort, reasoningEffort);
  }
  for (const reasoningEffort of ["ultra", "high;whoami", "", 5, null]) {
    assert.equal(remoteAgentTaskCreateRequestSchema.safeParse({ ...remote, reasoningEffort }).success, false);
  }
  assert.equal(remoteAgentTaskCreateRequestSchema.parse(remote).reasoningEffort, undefined);
  assert.equal(remoteAgentTaskCreateRequestSchema.parse({ ...remote, reasoningEffort: "max" }).reasoningEffort, "xhigh");
});

test("capability recognizes only the Codex remote session bridge", () => {
  const args = ["dist/scripts/remote-agent-session-bridge.js", "--provider", "codex", "--session", "{{session_id}}"];
  assert.equal(supportsRemoteReasoning({ executable: "node", args }), true);
  assert.equal(supportsRemoteReasoning({ executable: "node", args: args.map((v) => v === "codex" ? "grok" : v) }), false);
  assert.equal(supportsRemoteReasoning({ executable: "codex", args: ["run"] }), false);
});

test("remote bridge uses scoped effort env with explicit argument precedence and preserves omitted default", () => {
  assert.equal(parseRemoteAgentArgs(["--provider", "codex"], { GATEWAY_REMOTE_REASONING_EFFORT: "high" }).reasoningEffort, "high");
  assert.equal(parseRemoteAgentArgs(["--reasoning-effort", "low"], { GATEWAY_REMOTE_REASONING_EFFORT: "high" }).reasoningEffort, "low");
  assert.equal(parseRemoteAgentArgs([], { OPENAI_REASONING_EFFORT: "high" }).reasoningEffort, undefined);
  assert.equal(parseRemoteAgentArgs([], { GATEWAY_REMOTE_REASONING_EFFORT: "" }).reasoningEffort, undefined);
  assert.equal(parseRemoteAgentArgs([], { GATEWAY_REMOTE_REASONING_EFFORT: "max" }).reasoningEffort, "xhigh");
  assert.throws(() => parseRemoteAgentArgs(["--reasoning-effort"], {}), /requires a value/);
  assert.throws(() => parseRemoteAgentArgs([], { GATEWAY_REMOTE_REASONING_EFFORT: "malicious" }), /Unsupported/);
});

test("fresh and resumed Codex commands forward validated effort without changing default or other providers", () => {
  const target = { host: "example.test", cwd: "/opt/work", executable: "/usr/local/bin/codex-remote-run" };
  const prompt = `REMOTE_AGENT_TARGET_JSON=${JSON.stringify(target)}\nTask:\nInspect files.`;
  for (const session of ["", "resume-123"]) {
    const command = buildRemoteAgentCliCommand("codex", prompt, "gpt-5.6-luna", session, "high");
    assert.match(command.args.at(-1)!, /--reasoning-effort 'high'/);
    if (session) assert.match(command.args.at(-1)!, /--session 'resume-123'/);
  }
  assert.doesNotMatch(buildRemoteAgentCliCommand("codex", prompt).args.at(-1)!, /reasoning-effort/);
  assert.throws(() => buildRemoteAgentCliCommand("kimi", "task", "k3", "", "high"), /does not support/);
  assert.throws(() => buildRemoteAgentCliCommand("grok", "task", "grok-build", "", "high"), /does not support/);
});

test("acknowledgement filter strips exact split marker but not JSON, prefixed or unterminated text", () => {
  const applied: string[] = [];
  const filter = createRemoteReasoningFilter((effort) => applied.push(effort));
  assert.equal(filter.write("GATEWAY_REMOTE_REASONING_"), "");
  assert.equal(filter.write("EFFORT_APPLIED=high\r\n"), "");
  assert.deepEqual(applied, ["high"]);
  const json = '{"text":"GATEWAY_REMOTE_REASONING_EFFORT_APPLIED=low"}\n';
  assert.equal(filter.write(json), json);
  assert.equal(filter.write("prefix GATEWAY_REMOTE_REASONING_EFFORT_APPLIED=low\n"), "prefix GATEWAY_REMOTE_REASONING_EFFORT_APPLIED=low\n");
  assert.equal(filter.write("GATEWAY_REMOTE_REASONING_EFFORT_APPLIED=low"), "");
  assert.equal(filter.flush(), "GATEWAY_REMOTE_REASONING_EFFORT_APPLIED=low");
  assert.deepEqual(applied, ["high"]);
});

test("acknowledgement filter does not reinterpret marker after partial ordinary or long output", () => {
  const applied: string[] = [];
  const filter = createRemoteReasoningFilter((effort) => applied.push(effort));
  assert.equal(filter.write("prefix "), "prefix ");
  assert.equal(filter.write("GATEWAY_REMOTE_REASONING_EFFORT_APPLIED=high\n"), "GATEWAY_REMOTE_REASONING_EFFORT_APPLIED=high\n");
  const long = "x".repeat(10000);
  assert.equal(filter.write(long), long);
  assert.equal(filter.write("GATEWAY_REMOTE_REASONING_EFFORT_APPLIED=high\n"), "GATEWAY_REMOTE_REASONING_EFFORT_APPLIED=high\n");
  assert.deepEqual(applied, []);
});
