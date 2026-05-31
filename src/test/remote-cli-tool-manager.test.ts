import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import {
  RemoteCliToolManager,
  buildRemoteOpenCodeLaunch,
} from "../jobs/remote-cli-tool-manager";
import type { RemoteCliTargetConfig } from "../types";

const TARGET: RemoteCliTargetConfig = {
  targetId: "prod",
  host: "server.example.com",
  user: "deploy",
  port: 2222,
  allowedCwds: ["/srv/apps"],
  defaultModel: "codex-latest",
  opencodeExecutable: "/usr/local/bin/opencode",
  timeoutMs: 10_000,
};

test("buildRemoteOpenCodeLaunch quotes dynamic values and pins ssh target", () => {
  const launch = buildRemoteOpenCodeLaunch(
    {
      targetId: "prod",
      cwd: "/srv/apps/my app",
      task: "fix bug'; touch /tmp/pwned #",
      model: "anthropic/claude sonnet",
      sessionId: "sess'1",
    },
    new Map([[TARGET.targetId, TARGET]]),
    "ssh-test",
  );

  assert.equal(launch.command, "ssh-test");
  assert.deepEqual(launch.args.slice(0, 5), ["-o", "BatchMode=yes", "-p", "2222", "deploy@server.example.com"]);
  assert.match(launch.remoteCommand, /^cd '\/srv\/apps\/my app' && '\/usr\/local\/bin\/opencode' run --format json/);
  assert.match(launch.remoteCommand, /--model 'anthropic\/claude sonnet'/);
  assert.match(launch.remoteCommand, /--session 'sess'"'"'1'/);
  assert.match(launch.remoteCommand, /'fix bug'"'"'; touch \/tmp\/pwned #/);
  assert.match(launch.remoteCommand, /WHAT_CHANGED=<short summary/);
});

test("buildRemoteOpenCodeLaunch rejects cwd outside allowed remote roots", () => {
  assert.throws(
    () =>
      buildRemoteOpenCodeLaunch(
        {
          targetId: "prod",
          cwd: "/srv/applications/not-allowed",
          task: "run tests",
        },
        new Map([[TARGET.targetId, TARGET]]),
      ),
    /outside target prod allowed roots/,
  );
});

test("RemoteCliToolManager captures fake ssh output and extracts session metadata", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const manager = new RemoteCliToolManager([TARGET], {
    sshExecutable: "fake-ssh",
    spawnFn(command: string, args: string[], _options: SpawnOptionsWithoutStdio) {
      calls.push({ command, args });
      const child = createFakeChild();
      setTimeout(() => {
        (child.stdout as PassThrough).write(
          '{"sessionId":"sess_123","summary":"patched tests","type":"item.completed","item":{"type":"agent_message","text":"WHAT_CHANGED=patched tests\\nVERIFY_COMMANDS=npm test\\nVERIFY_RESULTS=passed\\nPUBLIC_URL=not_available\\nBLOCKER=none\\nREMOTE_CLI_SESSION_ID=sess_123"}}\n',
        );
        child.emit("close", 0);
      }, 5);
      return child;
    },
  });

  const result = await manager.run({
    targetId: "prod",
    cwd: "/srv/apps/repo",
    task: "fix failing test",
    waitMs: 500,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.sessionId, "sess_123");
  assert.equal(result.summary, "patched tests");
  assert.equal(result.proof?.complete, true);
  assert.equal(result.completionStatus, "complete");
  assert.match(result.finalOutput ?? "", /WHAT_CHANGED=patched tests/);
  assert.deepEqual(result.verifyCommands, ["npm test"]);
  assert.deepEqual(result.verifyResults, ["passed"]);
  assert.equal(result.proof?.markers.WHAT_CHANGED?.[0], "patched tests");
  assert.equal(result.proof?.markers.VERIFY_COMMANDS?.[0], "npm test");
  assert.equal(result.proof?.markers.BLOCKER?.[0], "none");
  assert.equal(calls[0]?.command, "fake-ssh");
  assert.match(calls[0]?.args.at(-1) ?? "", /opencode' run --format json/);
  assert.match(calls[0]?.args.at(-1) ?? "", /WHAT_CHANGED=<short summary/);

  await manager.close();
});

test("RemoteCliToolManager promotes blocker markers into contract status", async () => {
  const manager = new RemoteCliToolManager([TARGET], {
    sshExecutable: "fake-ssh",
    spawnFn() {
      const child = createFakeChild();
      setTimeout(() => {
        (child.stdout as PassThrough).write(
          '{"text":"WHAT_CHANGED=none\\nVERIFY_COMMANDS=git status\\nVERIFY_RESULTS=blocked\\nPUBLIC_URL=not_available\\nBLOCKER=missing deploy key"}\n',
        );
        child.emit("close", 1);
      }, 5);
      return child;
    },
  });

  const result = await manager.run({
    targetId: "prod",
    cwd: "/srv/apps/repo",
    task: "deploy",
    waitMs: 500,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.completionStatus, "blocked");
  assert.equal(result.blocker, "missing deploy key");
  assert.equal(result.publicUrl, undefined);
  assert.match(result.finalOutput ?? "", /BLOCKER=missing deploy key/);

  await manager.close();
});

function createFakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = new PassThrough() as ChildProcessWithoutNullStreams["stdin"];
  child.stdout = new PassThrough() as ChildProcessWithoutNullStreams["stdout"];
  child.stderr = new PassThrough() as ChildProcessWithoutNullStreams["stderr"];
  child.kill = (() => true) as ChildProcessWithoutNullStreams["kill"];
  return child;
}
