import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentHandoffStore,
  normalizeAgentHandoff,
} from "../jobs/agent-handoff-store";
import { CodexAgentManager } from "../jobs/codex-agent-manager";
import type { RemoteAgentHandoff } from "../validation";

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function buildHandoff(operationId: string, files: Array<{
  filename: string;
  mimeType: string;
  buffer: Buffer;
}> = []): RemoteAgentHandoff {
  const runDirectory = `.kimibuilt/agent-runs/${operationId}`;
  return {
    version: "RemoteAgentHandoff/v1",
    operationId,
    runDirectory,
    contextDirectory: `${runDirectory}/input`,
    manifestPath: `${runDirectory}/input/manifest.json`,
    sourceArtifactIds: ["artifact-source-1"],
    files: files.map((file) => ({
      filename: file.filename,
      mimeType: file.mimeType,
      sizeBytes: file.buffer.length,
      sha256: sha256(file.buffer),
      contentBase64: file.buffer.toString("base64"),
      source: "artifact",
      artifactId: "artifact-source-1",
      description: `${file.filename} input`,
    })),
    output: {
      version: "RemoteAgentResultFiles/v1",
      enabled: true,
      directory: `${runDirectory}/output`,
      filesDirectory: `${runDirectory}/output/files`,
      manifestPath: `${runDirectory}/output/manifest.json`,
      requestedGlobs: ["dist/*.html", "artifacts/*.svg"],
      maxFiles: 12,
      maxFileBytes: 4 * 1024 * 1024,
      maxTotalBytes: 6 * 1024 * 1024,
    },
  };
}

test("stages XML, SVG, and binary bytes then collects verified isolated results", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-handoff-store-"));
  const store = new AgentHandoffStore();
  const handoff = buildHandoff("11111111-2222-4333-8444-555555555555", [
    { filename: "brief.xml", mimeType: "application/xml", buffer: Buffer.from("<brief/>") },
    { filename: "diagram.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") },
    { filename: "reference.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 255, 1, 2]) },
  ]);

  try {
    const acknowledgement = await store.stageLocal(workspace, handoff);
    assert.deepEqual(acknowledgement, {
      accepted: true,
      version: "RemoteAgentHandoff/v1",
      operationId: handoff.operationId,
      inputManifestPath: handoff.manifestPath,
      resultManifestPath: handoff.output.manifestPath,
    });
    for (const file of handoff.files) {
      const stored = await readFile(path.join(workspace, ...handoff.contextDirectory.split("/"), file.filename));
      assert.deepEqual(stored, Buffer.from(file.contentBase64, "base64"));
    }
    const inputManifest = await readFile(path.join(workspace, ...handoff.manifestPath.split("/")), "utf8");
    assert.doesNotMatch(inputManifest, /contentBase64/);

    const html = Buffer.from("<!doctype html><title>Ready</title>");
    const svg = Buffer.from("<svg><circle r=\"8\"/></svg>");
    const htmlPath = `${handoff.output.filesDirectory}/index.html`;
    const svgPath = `${handoff.output.filesDirectory}/result.svg`;
    await writeFile(path.join(workspace, ...htmlPath.split("/")), html);
    await writeFile(path.join(workspace, ...svgPath.split("/")), svg);
    await writeFile(
      path.join(workspace, ...handoff.output.manifestPath.split("/")),
      JSON.stringify({
        version: "RemoteAgentResultFiles/v1",
        files: [
          { path: htmlPath, role: "preview", mimeType: "text/html", description: "Rendered preview" },
          { path: svgPath, role: "diagram", mimeType: "image/svg+xml", description: "Vector diagram" },
        ],
      }),
    );

    const result = await store.collectLocal(workspace, handoff);
    assert.equal(result.gatewayVerified, true);
    assert.equal(result.operationId, handoff.operationId);
    assert.equal(result.files.length, 2);
    assert.deepEqual(Buffer.from(result.files[0]!.contentBase64, "base64"), html);
    assert.equal(result.files[0]!.sha256, sha256(html));
    assert.deepEqual(Buffer.from(result.files[1]!.contentBase64, "base64"), svg);
    await assert.rejects(access(path.join(workspace, ...handoff.runDirectory.split("/"))));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("isolates simultaneous operations and a duplicate operation cannot delete the first", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-handoff-concurrent-"));
  const store = new AgentHandoffStore();
  const first = buildHandoff("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  const second = buildHandoff("ffffffff-1111-4222-8333-444444444444");

  try {
    await Promise.all([
      store.stageLocal(workspace, first),
      store.stageLocal(workspace, second),
    ]);
    await assert.rejects(store.stageLocal(workspace, first));
    const firstDirectory = path.join(workspace, ...first.runDirectory.split("/"));
    const firstInfo = await lstat(firstDirectory);
    assert.equal(firstInfo.isDirectory(), true);
    await store.cleanupLocal(workspace, first);
    await store.cleanupLocal(workspace, second);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Codex manager does not clean an existing operation when duplicate staging fails", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-handoff-manager-duplicate-"));
  const store = new AgentHandoffStore();
  const handoff = buildHandoff("31313131-4242-4535-8646-575757575757");
  const manager = new CodexAgentManager({
    allowedWorkspaceRoots: [workspace],
    codexExecutableCandidates: [],
    handoffStore: store,
  });

  try {
    await store.stageLocal(workspace, handoff);
    await assert.rejects(manager.startRun({
      workspacePath: workspace,
      prompt: "Use the staged design.",
      handoff,
    }));
    const info = await lstat(path.join(workspace, ...handoff.runDirectory.split("/")));
    assert.equal(info.isDirectory(), true);
    await store.cleanupLocal(workspace, handoff);
  } finally {
    await manager.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Codex manager rejects a workspace that escapes an allowed root through an intermediate symlink", async (t) => {
  const allowedRoot = await mkdtemp(path.join(os.tmpdir(), "codex-allowed-root-"));
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), "codex-external-root-"));
  const externalWorkspace = path.join(externalRoot, "workspace");
  const escapeLink = path.join(allowedRoot, "escape");
  const manager = new CodexAgentManager({
    allowedWorkspaceRoots: [allowedRoot],
    codexExecutableCandidates: [],
  });

  try {
    await mkdir(externalWorkspace);
    try {
      await symlink(externalRoot, escapeLink, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("Directory symlink creation is not permitted on this host.");
        return;
      }
      throw error;
    }
    await assert.rejects(manager.startRun({
      workspacePath: path.join(escapeLink, "workspace"),
      prompt: "Inspect the workspace.",
    }), /outside the allowed workspace roots after realpath resolution/i);
  } finally {
    await manager.close();
    await rm(allowedRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("collection failure still removes the isolated local run directory", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-handoff-failed-collection-"));
  const store = new AgentHandoffStore();
  const handoff = buildHandoff("61616161-7272-4838-8949-505050505050");

  try {
    await store.stageLocal(workspace, handoff);
    await assert.rejects(store.collectLocal(workspace, handoff), /manifest|does not exist/i);
    await assert.rejects(access(path.join(workspace, ...handoff.runDirectory.split("/"))));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("cleanup refuses a symlinked handoff parent and preserves the external target", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-handoff-parent-link-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "agent-handoff-external-"));
  const store = new AgentHandoffStore();
  const handoff = buildHandoff("71717171-8282-4939-8050-616161616161");
  const localParent = path.join(workspace, ".kimibuilt");
  const externalParent = path.join(external, "staged-data");

  try {
    await store.stageLocal(workspace, handoff);
    await rename(localParent, externalParent);
    try {
      await symlink(externalParent, localParent, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("Directory symlink creation is not permitted on this host.");
        return;
      }
      throw error;
    }
    await assert.rejects(store.cleanupLocal(workspace, handoff), /symlink|unsafe/i);
    const externalRun = path.join(externalParent, "agent-runs", handoff.operationId);
    const info = await lstat(externalRun);
    assert.equal(info.isDirectory(), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("rejects path tampering, reserved filenames, invalid checksums, and secret paths", async () => {
  const safe = buildHandoff("12121212-3434-4567-8901-234567890123", [
    { filename: "brief.xml", mimeType: "application/xml", buffer: Buffer.from("<brief/>") },
  ]);

  assert.throws(() => normalizeAgentHandoff({
    ...safe,
    runDirectory: "../outside",
  }), /workspace|paths/i);
  assert.throws(() => normalizeAgentHandoff({
    ...safe,
    files: [{ ...safe.files[0]!, filename: "manifest.json" }],
  }), /filename is unsafe/i);
  assert.throws(() => normalizeAgentHandoff({
    ...safe,
    files: [{ ...safe.files[0]!, sha256: "0".repeat(64) }],
  }), /checksum attestation/i);

  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-handoff-secret-"));
  const store = new AgentHandoffStore();
  try {
    await store.stageLocal(workspace, safe);
    await writeFile(path.join(workspace, ...safe.output.manifestPath.split("/")), JSON.stringify({
      version: "RemoteAgentResultFiles/v1",
      files: [{ path: ".env", role: "secret", mimeType: "text/plain" }],
    }));
    await assert.rejects(store.collectLocal(workspace, safe), /outside the isolated files directory/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("rejects a symlinked result file when the platform permits symlink creation", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-handoff-symlink-"));
  const store = new AgentHandoffStore();
  const handoff = buildHandoff("98989898-7676-4545-8321-101010101010");
  try {
    await store.stageLocal(workspace, handoff);
    const outside = path.join(workspace, "outside.txt");
    await writeFile(outside, "secret");
    const resultPath = `${handoff.output.filesDirectory}/result.txt`;
    const absoluteResultPath = path.join(workspace, ...resultPath.split("/"));
    try {
      await symlink(outside, absoluteResultPath, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("Symlink creation is not permitted on this Windows host.");
        return;
      }
      throw error;
    }
    await writeFile(path.join(workspace, ...handoff.output.manifestPath.split("/")), JSON.stringify({
      version: "RemoteAgentResultFiles/v1",
      files: [{ path: resultPath, role: "deliverable", mimeType: "text/plain" }],
    }));
    await assert.rejects(store.collectLocal(workspace, handoff), /symlink|unsafe/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
