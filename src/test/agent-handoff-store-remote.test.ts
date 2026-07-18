import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { AgentHandoffStore } from "../jobs/agent-handoff-store";
import type { RemoteCliTargetConfig } from "../types";
import type { RemoteAgentHandoff } from "../validation";

const TARGET: RemoteCliTargetConfig = {
  targetId: "secondary",
  host: "secondary.example.com",
  user: "deploy",
  port: 2222,
  allowedCwds: ["/srv/missing", "/srv/apps"],
  defaultCwd: "/srv/apps/design-site",
  timeoutMs: 10_000,
};

interface SshCall {
  command: string;
  args: string[];
  remoteCommand: string;
  stdin: Buffer;
}

test("remote handoff stages exact bytes and collects a verified result before cleanup", async () => {
  const operationId = "12345678-1234-4234-8234-123456789abc";
  const runDirectory = `.kimibuilt/agent-runs/${operationId}`;
  const inputBytes = Buffer.from([0, 255, 1, 2, 10, 13, 60, 120, 109, 108, 47, 62]);
  const resultBytes = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 0h8v8z\"/></svg>");
  const resultPath = `${runDirectory}/output/files/result.svg`;
  const handoff: RemoteAgentHandoff = {
    version: "RemoteAgentHandoff/v1",
    operationId,
    runDirectory,
    contextDirectory: `${runDirectory}/input`,
    manifestPath: `${runDirectory}/input/manifest.json`,
    sourceArtifactIds: ["artifact-source-1"],
    files: [{
      filename: "design.xml",
      mimeType: "application/xml",
      sizeBytes: inputBytes.length,
      sha256: sha256(inputBytes),
      contentBase64: inputBytes.toString("base64"),
      source: "artifact",
      artifactId: "artifact-source-1",
      description: "Design source",
    }],
    output: {
      version: "RemoteAgentResultFiles/v1",
      enabled: true,
      directory: `${runDirectory}/output`,
      filesDirectory: `${runDirectory}/output/files`,
      manifestPath: `${runDirectory}/output/manifest.json`,
      requestedGlobs: ["**/*.svg"],
      maxFiles: 12,
      maxFileBytes: 4 * 1024 * 1024,
      maxTotalBytes: 6 * 1024 * 1024,
    },
  };
  const resultManifest = Buffer.from(JSON.stringify({
    version: "RemoteAgentResultFiles/v1",
    files: [{
      path: resultPath,
      role: "diagram",
      mimeType: "image/svg+xml",
      description: "Generated vector diagram",
    }],
  }));
  const calls: SshCall[] = [];

  const store = new AgentHandoffStore({
    sshExecutable: "fake-ssh",
    spawnFn(command: string, args: readonly string[], _options: SpawnOptionsWithoutStdio) {
      const child = createFakeChild();
      const chunks: Buffer[] = [];
      child.stdin.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.stdin.on("end", () => {
        const remoteCommand = args.at(-1) ?? "";
        calls.push({
          command,
          args: [...args],
          remoteCommand,
          stdin: Buffer.concat(chunks),
        });

        let stdout = "";
        if (remoteCommand.includes("Remote workspace is outside configured real roots.")) {
          stdout = "/srv/apps/design-site\n";
        } else if (remoteCommand.includes(`base64 -w0 '${handoff.output.manifestPath}'`)) {
          stdout = buildRemoteReadEnvelope(resultManifest);
        } else if (remoteCommand.includes(`base64 -w0 '${resultPath}'`)) {
          stdout = buildRemoteReadEnvelope(resultBytes);
        }

        setImmediate(() => {
          if (stdout) {
            (child.stdout as PassThrough).write(stdout);
          }
          child.emit("close", 0);
        });
      });
      return child;
    },
  });

  const acknowledgement = await store.stageRemote(TARGET, "/srv/apps/design-site", handoff);
  assert.deepEqual(acknowledgement, {
    accepted: true,
    version: "RemoteAgentHandoff/v1",
    operationId,
    inputManifestPath: handoff.manifestPath,
    resultManifestPath: handoff.output.manifestPath,
  });
  const preflight = calls.find((call) =>
    call.remoteCommand.includes("Remote workspace is outside configured real roots."));
  assert.ok(preflight, "remote workspace should be canonicalized before staging");
  assert.match(preflight.remoteCommand, /if root_0=.*'\/srv\/missing' 2>\/dev\/null/);
  assert.match(preflight.remoteCommand, /if root_1=.*'\/srv\/apps' 2>\/dev\/null/);

  const inputWrite = calls.find((call) =>
    call.remoteCommand.includes(`${handoff.contextDirectory}/design.xml.tmp-`));
  assert.ok(inputWrite, "input file should be transferred through ssh stdin");
  assert.deepEqual(Buffer.from(inputWrite.stdin.toString("utf8"), "base64"), inputBytes);

  const manifestWrite = calls.find((call) =>
    call.remoteCommand.includes(`${handoff.manifestPath}.tmp-`));
  assert.ok(manifestWrite, "input manifest should be transferred through ssh stdin");
  const stagedManifest = JSON.parse(
    Buffer.from(manifestWrite.stdin.toString("utf8"), "base64").toString("utf8"),
  ) as Record<string, unknown>;
  assert.equal(stagedManifest.operationId, operationId);
  assert.doesNotMatch(JSON.stringify(stagedManifest), /contentBase64/);

  for (const call of calls) {
    assert.equal(call.command, "fake-ssh");
    assert.deepEqual(call.args.slice(0, -1), [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-p",
      "2222",
      "deploy@secondary.example.com",
    ]);
  }

  const result = await store.collectRemote(TARGET, "/srv/apps/design-site", handoff);
  assert.equal(result.version, "RemoteAgentResultFiles/v1");
  assert.equal(result.gatewayVerified, true);
  assert.equal(result.operationId, operationId);
  assert.equal(result.manifestPath, handoff.output.manifestPath);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]?.path, resultPath);
  assert.equal(result.files[0]?.sha256, sha256(resultBytes));
  assert.deepEqual(Buffer.from(result.files[0]?.contentBase64 ?? "", "base64"), resultBytes);

  const manifestRead = calls.find((call) =>
    call.remoteCommand.includes(`base64 -w0 '${handoff.output.manifestPath}'`));
  const resultRead = calls.find((call) =>
    call.remoteCommand.includes(`base64 -w0 '${resultPath}'`));
  assert.ok(manifestRead, "result manifest should be read over ssh");
  assert.ok(resultRead, "result file should be read over ssh");
  assert.ok(
    calls.at(-1)?.remoteCommand.includes(`rm -rf -- '${handoff.runDirectory}'`),
    "successful collection should clean the isolated remote run directory",
  );

  for (const call of calls) {
    assert.equal(call.command, "fake-ssh");
    assert.deepEqual(call.args.slice(0, -1), [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-p",
      "2222",
      "deploy@secondary.example.com",
    ]);
  }
});

test("remote handoff rejects a canonical workspace outside the configured real roots", async () => {
  const handoff = buildEmptyHandoff("22345678-1234-4234-8234-123456789abc");
  const calls: SshCall[] = [];
  const store = new AgentHandoffStore({
    sshExecutable: "fake-ssh",
    spawnFn(command: string, args: readonly string[], _options: SpawnOptionsWithoutStdio) {
      const child = createFakeChild();
      const chunks: Buffer[] = [];
      child.stdin.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.stdin.on("end", () => {
        const remoteCommand = args.at(-1) ?? "";
        calls.push({ command, args: [...args], remoteCommand, stdin: Buffer.concat(chunks) });
        setImmediate(() => {
          (child.stderr as PassThrough).write("Remote workspace is outside configured real roots.");
          child.emit("close", 44);
        });
      });
      return child;
    },
  });

  await assert.rejects(
    store.stageRemote(TARGET, "/srv/apps/escape", handoff),
    /SSH command failed \(44\).*outside configured real roots/i,
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.remoteCommand, /realpath -e/);
  assert.deepEqual(calls[0]!.args.slice(0, -1), [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-p",
    "2222",
    "deploy@secondary.example.com",
  ]);
});

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function buildRemoteReadEnvelope(buffer: Buffer): string {
  return `${buffer.length}\n${sha256(buffer)}\n${buffer.toString("base64")}`;
}

function buildEmptyHandoff(operationId: string): RemoteAgentHandoff {
  const runDirectory = `.kimibuilt/agent-runs/${operationId}`;
  return {
    version: "RemoteAgentHandoff/v1",
    operationId,
    runDirectory,
    contextDirectory: `${runDirectory}/input`,
    manifestPath: `${runDirectory}/input/manifest.json`,
    sourceArtifactIds: [],
    files: [],
    output: {
      version: "RemoteAgentResultFiles/v1",
      enabled: true,
      directory: `${runDirectory}/output`,
      filesDirectory: `${runDirectory}/output/files`,
      manifestPath: `${runDirectory}/output/manifest.json`,
      requestedGlobs: [],
      maxFiles: 12,
      maxFileBytes: 4 * 1024 * 1024,
      maxTotalBytes: 6 * 1024 * 1024,
    },
  };
}

function createFakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = new PassThrough() as ChildProcessWithoutNullStreams["stdin"];
  child.stdout = new PassThrough() as ChildProcessWithoutNullStreams["stdout"];
  child.stderr = new PassThrough() as ChildProcessWithoutNullStreams["stderr"];
  child.kill = (() => true) as ChildProcessWithoutNullStreams["kill"];
  return child;
}
