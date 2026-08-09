import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { RemoteCliTargetConfig } from "../types";
import type { RemoteAgentHandoff } from "../validation";
import { shellEscape } from "../utils/shell";

export const REMOTE_AGENT_HANDOFF_VERSION = "RemoteAgentHandoff/v1" as const;
export const REMOTE_AGENT_RESULT_FILES_VERSION = "RemoteAgentResultFiles/v1" as const;
export const MAX_AGENT_HANDOFF_FILES = 12;
export const MAX_AGENT_HANDOFF_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_AGENT_HANDOFF_TOTAL_BYTES = 6 * 1024 * 1024;
const MAX_RESULT_MANIFEST_BYTES = 64 * 1024;
const REMOTE_COMMAND_TIMEOUT_MS = 60_000;

export interface AgentHandoffAcknowledgement {
  accepted: true;
  version: typeof REMOTE_AGENT_HANDOFF_VERSION;
  operationId: string;
  inputManifestPath: string;
  resultManifestPath?: string;
}

export interface GatewayVerifiedResultFile {
  path: string;
  filename: string;
  role: string;
  mimeType: string;
  description: string;
  sizeBytes: number;
  sha256: string;
  contentBase64: string;
}

export interface GatewayVerifiedResultFiles {
  version: typeof REMOTE_AGENT_RESULT_FILES_VERSION;
  gatewayVerified: true;
  operationId: string;
  manifestPath: string;
  files: GatewayVerifiedResultFile[];
}

interface AgentResultManifestEntry {
  path: string;
  role?: string;
  mimeType?: string;
  description?: string;
}

interface AgentResultManifest {
  version: typeof REMOTE_AGENT_RESULT_FILES_VERSION;
  files: AgentResultManifestEntry[];
}

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export class AgentHandoffStore {
  private readonly sshExecutable: string;
  private readonly spawnFn: SpawnFn;

  constructor(options: { sshExecutable?: string; spawnFn?: SpawnFn } = {}) {
    this.sshExecutable = options.sshExecutable ?? "ssh";
    this.spawnFn = options.spawnFn ?? spawn;
  }

  async stageLocal(workspacePath: string, input: RemoteAgentHandoff): Promise<AgentHandoffAcknowledgement> {
    const handoff = normalizeAgentHandoff(input);
    const workspace = await resolveRealLocalWorkspace(workspacePath);
    const runDirectory = resolveWithinWorkspace(workspace, handoff.runDirectory);
    const inputDirectory = resolveWithinWorkspace(workspace, handoff.contextDirectory);
    const outputFilesDirectory = resolveWithinWorkspace(workspace, handoff.output.filesDirectory);

    await ensureSafeLocalParent(workspace, path.posix.dirname(handoff.runDirectory));
    let runDirectoryCreated = false;
    try {
      await mkdir(runDirectory, { mode: 0o700 });
      runDirectoryCreated = true;
      await mkdir(inputDirectory, { recursive: true, mode: 0o700 });
      await mkdir(outputFilesDirectory, { recursive: true, mode: 0o700 });

      for (const file of handoff.files) {
        const targetPath = resolveWithinWorkspace(workspace, `${handoff.contextDirectory}/${file.filename}`);
        const buffer = Buffer.from(file.contentBase64, "base64");
        await writeFile(targetPath, buffer, { flag: "wx", mode: 0o600 });
        await chmod(targetPath, 0o600);
      }
      await writeJsonAtomically(
        resolveWithinWorkspace(workspace, handoff.manifestPath),
        buildInputManifest(handoff),
      );
    } catch (error) {
      if (runDirectoryCreated) {
        await this.cleanupLocal(workspace, handoff).catch(() => undefined);
      }
      throw error;
    }
    return buildAcknowledgement(handoff);
  }

  async collectLocal(workspacePath: string, input: RemoteAgentHandoff): Promise<GatewayVerifiedResultFiles> {
    const handoff = normalizeAgentHandoff(input);
    assertResultFilesRequested(handoff);
    const workspace = await resolveRealLocalWorkspace(workspacePath);
    try {
      const outputRoot = await resolveSafeExistingLocalPath(
        workspace,
        handoff.output.directory,
        "AGENT_RESULT_FILES_UNSAFE_ROOT",
      );
      if (!outputRoot.info.isDirectory()) {
        throw handoffError("Remote agent output root is not a safe directory.", "AGENT_RESULT_FILES_UNSAFE_ROOT");
      }
      const manifest = await readLocalResultManifest(workspace, handoff, outputRoot.realPath);
      const filesRoot = await resolveSafeExistingLocalPath(
        workspace,
        handoff.output.filesDirectory,
        "AGENT_RESULT_FILES_UNSAFE_ROOT",
      );
      if (!filesRoot.info.isDirectory()) {
        throw handoffError("Remote agent output files root is not a safe directory.", "AGENT_RESULT_FILES_UNSAFE_ROOT");
      }

      let totalBytes = 0;
      const files: GatewayVerifiedResultFile[] = [];
      for (const [index, entry] of manifest.files.entries()) {
        const relativePath = validateResultPath(entry.path, handoff);
        const buffer = await readSafeLocalFile(
          workspace,
          relativePath,
          filesRoot.realPath,
          "AGENT_RESULT_FILES_UNSAFE_PATH",
          MAX_AGENT_HANDOFF_FILE_BYTES,
        );
        totalBytes += buffer.length;
        if (totalBytes > MAX_AGENT_HANDOFF_TOTAL_BYTES) {
          throw handoffError("Remote agent result files exceed the total byte limit.", "AGENT_RESULT_FILES_TOO_LARGE");
        }
        files.push(buildVerifiedResultFile(entry, relativePath, buffer, index));
      }

      return buildVerifiedEnvelope(handoff, files);
    } finally {
      await this.cleanupLocal(workspace, handoff);
    }
  }

  async cleanupLocal(workspacePath: string, input: RemoteAgentHandoff): Promise<void> {
    const handoff = normalizeAgentHandoff(input);
    const workspace = await resolveRealLocalWorkspace(workspacePath);
    const runDirectory = resolveWithinWorkspace(workspace, handoff.runDirectory);
    const info = await lstat(runDirectory).catch(() => null);
    if (!info) {
      return;
    }
    const safeRunDirectory = await resolveSafeExistingLocalPath(
      workspace,
      handoff.runDirectory,
      "AGENT_HANDOFF_UNSAFE_CLEANUP",
    );
    if (!safeRunDirectory.info.isDirectory()) {
      throw handoffError("Refusing to remove an unsafe agent handoff run directory.", "AGENT_HANDOFF_UNSAFE_CLEANUP");
    }
    const parentRelative = path.posix.dirname(handoff.runDirectory);
    const safeParent = await resolveSafeExistingLocalPath(
      workspace,
      parentRelative,
      "AGENT_HANDOFF_UNSAFE_CLEANUP",
    );
    if (!safeParent.info.isDirectory()) {
      throw handoffError("Refusing to remove an agent handoff with an unsafe parent.", "AGENT_HANDOFF_UNSAFE_CLEANUP");
    }
    const quarantineRelative = `${parentRelative}/.cleanup-${handoff.operationId}-${randomUUID()}`;
    const quarantinePath = resolveWithinWorkspace(workspace, quarantineRelative);
    await rename(safeRunDirectory.absolutePath, quarantinePath);
    const quarantined = await resolveSafeExistingLocalPath(
      workspace,
      quarantineRelative,
      "AGENT_HANDOFF_UNSAFE_CLEANUP",
    );
    if (!quarantined.info.isDirectory()
      || !sameFileIdentity(safeRunDirectory.info, quarantined.info)
      || !isWithinPath(quarantined.realPath, safeParent.realPath)) {
      throw handoffError("Refusing to remove an agent handoff whose quarantine identity changed.", "AGENT_HANDOFF_UNSAFE_CLEANUP");
    }
    await rm(quarantined.absolutePath, { recursive: true, force: true });
  }

  async stageRemote(
    target: RemoteCliTargetConfig,
    cwd: string,
    input: RemoteAgentHandoff,
  ): Promise<AgentHandoffAcknowledgement> {
    const handoff = normalizeAgentHandoff(input);
    const workspace = await this.resolveRemoteWorkspace(target, cwd);
    const parent = path.posix.dirname(handoff.runDirectory);
    const setup = [
      `cd ${shellEscape(workspace)}`,
      "umask 077",
      `test ! -L ${shellEscape(".kimibuilt")}`,
      `mkdir -p -- ${shellEscape(".kimibuilt")}`,
      `test ! -L ${shellEscape(parent)}`,
      `mkdir -p -- ${shellEscape(parent)}`,
      `test ! -e ${shellEscape(handoff.runDirectory)}`,
      `mkdir -- ${shellEscape(handoff.runDirectory)}`,
      `mkdir -p -- ${shellEscape(handoff.contextDirectory)} ${shellEscape(handoff.output.filesDirectory)}`,
      `chmod 700 -- ${shellEscape(handoff.runDirectory)} ${shellEscape(handoff.contextDirectory)} ${shellEscape(handoff.output.directory)} ${shellEscape(handoff.output.filesDirectory)}`,
    ].join(" && ");
    await this.runSsh(target, setup);

    try {
      for (const file of handoff.files) {
        const relativePath = `${handoff.contextDirectory}/${file.filename}`;
        await this.writeRemoteFile(target, workspace, relativePath, file.contentBase64, file.sha256);
      }
      const manifestBuffer = Buffer.from(JSON.stringify(buildInputManifest(handoff), null, 2));
      await this.writeRemoteFile(
        target,
        workspace,
        handoff.manifestPath,
        manifestBuffer.toString("base64"),
        sha256(manifestBuffer),
      );
    } catch (error) {
      await this.cleanupRemote(target, cwd, handoff).catch(() => undefined);
      throw error;
    }
    return buildAcknowledgement(handoff);
  }

  async collectRemote(
    target: RemoteCliTargetConfig,
    cwd: string,
    input: RemoteAgentHandoff,
  ): Promise<GatewayVerifiedResultFiles> {
    const handoff = normalizeAgentHandoff(input);
    assertResultFilesRequested(handoff);
    const workspace = await this.resolveRemoteWorkspace(target, cwd);
    try {
      const manifestBuffer = await this.readRemoteFile(
        target,
        workspace,
        handoff.output.manifestPath,
        handoff.output.directory,
        MAX_RESULT_MANIFEST_BYTES,
      );
      const manifest = parseResultManifest(manifestBuffer);

      let totalBytes = 0;
      const files: GatewayVerifiedResultFile[] = [];
      for (const [index, entry] of manifest.files.entries()) {
        const relativePath = validateResultPath(entry.path, handoff);
        const buffer = await this.readRemoteFile(
          target,
          workspace,
          relativePath,
          handoff.output.filesDirectory,
          MAX_AGENT_HANDOFF_FILE_BYTES,
        );
        totalBytes += buffer.length;
        if (totalBytes > MAX_AGENT_HANDOFF_TOTAL_BYTES) {
          throw handoffError("Remote agent result files exceed the total byte limit.", "AGENT_RESULT_FILES_TOO_LARGE");
        }
        files.push(buildVerifiedResultFile(entry, relativePath, buffer, index));
      }
      return buildVerifiedEnvelope(handoff, files);
    } finally {
      await this.cleanupRemote(target, workspace, handoff);
    }
  }

  async cleanupRemote(
    target: RemoteCliTargetConfig,
    cwd: string,
    input: RemoteAgentHandoff,
  ): Promise<void> {
    const handoff = normalizeAgentHandoff(input);
    const workspace = await this.resolveRemoteWorkspace(target, cwd);
    const command = [
      `cd ${shellEscape(workspace)}`,
      `if test ! -e ${shellEscape(handoff.runDirectory)}; then exit 0; fi`,
      `test ! -L ${shellEscape(".kimibuilt")}`,
      `test ! -L ${shellEscape(path.posix.dirname(handoff.runDirectory))}`,
      `test ! -L ${shellEscape(handoff.runDirectory)}`,
      `test -d ${shellEscape(handoff.runDirectory)}`,
      "root=$(realpath -e .)",
      `candidate=$(realpath -e ${shellEscape(handoff.runDirectory)})`,
      `case "$candidate" in "$root"/*) ;; *) exit 43 ;; esac`,
      `rm -rf -- ${shellEscape(handoff.runDirectory)}`,
    ].join(" && ");
    await this.runSsh(target, command);
  }

  async resolveRemoteWorkspace(target: RemoteCliTargetConfig, cwd: string): Promise<string> {
    if (!Array.isArray(target.allowedCwds) || target.allowedCwds.length === 0) {
      throw handoffError("Remote agent target has no allowed workspace roots.", "AGENT_HANDOFF_REMOTE_ROOTS_MISSING");
    }
    const checks = target.allowedCwds.map((root, index) => (
      `if root_${index}=$(realpath -e -- ${shellEscape(root)} 2>/dev/null) && test -d "$root_${index}"; then `
      + `case "$workspace" in "$root_${index}"|"$root_${index}"/*) printf '%s\\n' "$workspace"; exit 0 ;; esac; fi`
    ));
    const command = [
      `workspace=$(realpath -e -- ${shellEscape(cwd)}) || exit 43`,
      "test -d \"$workspace\" || exit 43",
      ...checks,
      "echo 'Remote workspace is outside configured real roots.' >&2",
      "exit 44",
    ].join("; ");
    const output = await this.runSsh(target, command, undefined, 8 * 1024);
    const canonical = output.trim();
    if (!canonical.startsWith("/") || canonical.includes("\n")) {
      throw handoffError("Remote workspace preflight returned an invalid canonical path.", "AGENT_HANDOFF_REMOTE_WORKSPACE_INVALID");
    }
    return canonical;
  }

  private async writeRemoteFile(
    target: RemoteCliTargetConfig,
    cwd: string,
    relativePath: string,
    contentBase64: string,
    expectedSha256: string,
  ): Promise<void> {
    const temporaryPath = `${relativePath}.tmp-${randomUUID()}`;
    const command = [
      `cd ${shellEscape(cwd)}`,
      "umask 077",
      `base64 -d > ${shellEscape(temporaryPath)}`,
      `chmod 600 -- ${shellEscape(temporaryPath)}`,
      `test \"$(sha256sum ${shellEscape(temporaryPath)} | cut -d ' ' -f 1)\" = ${shellEscape(expectedSha256)}`,
      `mv -- ${shellEscape(temporaryPath)} ${shellEscape(relativePath)}`,
    ].join(" && ");
    await this.runSsh(target, command, contentBase64, 8 * 1024);
  }

  private async readRemoteFile(
    target: RemoteCliTargetConfig,
    cwd: string,
    relativePath: string,
    allowedRoot: string,
    maxBytes: number,
  ): Promise<Buffer> {
    const command = [
      `cd ${shellEscape(cwd)}`,
      `test -f ${shellEscape(relativePath)}`,
      `test ! -L ${shellEscape(relativePath)}`,
      `test -d ${shellEscape(allowedRoot)}`,
      `test ! -L ${shellEscape(allowedRoot)}`,
      "workspace=$(realpath -e .)",
      `root=$(realpath -e ${shellEscape(allowedRoot)})`,
      `candidate=$(realpath -e ${shellEscape(relativePath)})`,
      `case \"$root\" in \"$workspace\"/*) ;; *) exit 42 ;; esac`,
      `case \"$candidate\" in \"$root\"/*) ;; *) exit 43 ;; esac`,
      `stat -c '%s' ${shellEscape(relativePath)}`,
      `sha256sum ${shellEscape(relativePath)} | cut -d ' ' -f 1`,
      `base64 -w0 ${shellEscape(relativePath)}`,
    ].join(" && ");
    const output = await this.runSsh(target, command, undefined, Math.ceil(maxBytes * 1.4) + 8192);
    const firstBreak = output.indexOf("\n");
    const secondBreak = firstBreak >= 0 ? output.indexOf("\n", firstBreak + 1) : -1;
    if (firstBreak < 0 || secondBreak < 0) {
      throw handoffError(`Remote agent result ${relativePath} returned an invalid verification envelope.`, "AGENT_RESULT_FILES_INVALID_REMOTE_ENVELOPE");
    }
    const sizeBytes = Number(output.slice(0, firstBreak).trim());
    const expectedSha256 = output.slice(firstBreak + 1, secondBreak).trim().toLowerCase();
    const contentBase64 = output.slice(secondBreak + 1).trim();
    const buffer = decodeBase64Strict(contentBase64, relativePath);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes !== buffer.length || sizeBytes <= 0 || sizeBytes > maxBytes) {
      throw handoffError(`Remote agent result ${relativePath} failed its size attestation.`, "AGENT_RESULT_FILES_SIZE_MISMATCH");
    }
    if (!/^[a-f0-9]{64}$/.test(expectedSha256) || sha256(buffer) !== expectedSha256) {
      throw handoffError(`Remote agent result ${relativePath} failed its checksum attestation.`, "AGENT_RESULT_FILES_CHECKSUM_MISMATCH");
    }
    return buffer;
  }

  private runSsh(
    target: RemoteCliTargetConfig,
    command: string,
    stdin?: string,
    maxOutputBytes = 256 * 1024,
  ): Promise<string> {
    const destination = target.user ? `${target.user}@${target.host}` : target.host;
    const args = [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      ...(target.port ? ["-p", String(target.port)] : []),
      destination,
      command,
    ];
    const timeoutMs = Math.min(target.timeoutMs ?? REMOTE_COMMAND_TIMEOUT_MS, 5 * 60_000);
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(this.sshExecutable, args, {
        env: process.env,
        shell: false,
        stdio: "pipe",
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(handoffError("Remote agent handoff SSH command timed out.", "AGENT_HANDOFF_SSH_TIMEOUT"));
      }, timeoutMs);
      timer.unref();

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(stdout);
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > maxOutputBytes) {
          child.kill("SIGTERM");
          finish(handoffError("Remote agent handoff SSH output exceeded its byte limit.", "AGENT_HANDOFF_SSH_OUTPUT_TOO_LARGE"));
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-16 * 1024);
      });
      child.on("error", (error) => finish(error));
      child.on("close", (exitCode) => {
        if (exitCode !== 0) {
          finish(handoffError(`Remote agent handoff SSH command failed (${exitCode ?? "unknown"}): ${stderr.trim() || "no stderr"}`, "AGENT_HANDOFF_SSH_FAILED"));
        } else {
          finish();
        }
      });
      child.stdin.end(stdin ?? "");
    });
  }
}

export function normalizeAgentHandoff(input: RemoteAgentHandoff): RemoteAgentHandoff {
  if (!input || input.version !== REMOTE_AGENT_HANDOFF_VERSION) {
    throw handoffError(`Agent handoff contract must be ${REMOTE_AGENT_HANDOFF_VERSION}.`, "AGENT_HANDOFF_VERSION_MISMATCH");
  }
  if (!/^[a-z0-9][a-z0-9-]{7,79}$/i.test(input.operationId)) {
    throw handoffError("Agent handoff operationId is invalid.", "AGENT_HANDOFF_OPERATION_ID_INVALID");
  }
  const expectedRunDirectory = `.kimibuilt/agent-runs/${input.operationId}`;
  const expectedContextDirectory = `${expectedRunDirectory}/input`;
  const expectedManifestPath = `${expectedContextDirectory}/manifest.json`;
  const expectedOutputDirectory = `${expectedRunDirectory}/output`;
  const expectedFilesDirectory = `${expectedOutputDirectory}/files`;
  const expectedResultManifestPath = `${expectedOutputDirectory}/manifest.json`;
  const exactPaths = [
    [input.runDirectory, expectedRunDirectory],
    [input.contextDirectory, expectedContextDirectory],
    [input.manifestPath, expectedManifestPath],
    [input.output.directory, expectedOutputDirectory],
    [input.output.filesDirectory, expectedFilesDirectory],
    [input.output.manifestPath, expectedResultManifestPath],
  ];
  for (const [actual, expected] of exactPaths) {
    if (validateRelativePath(actual ?? "") !== expected) {
      throw handoffError("Agent handoff paths do not match the isolated operation directory.", "AGENT_HANDOFF_PATH_MISMATCH");
    }
  }
  if (input.output.version !== REMOTE_AGENT_RESULT_FILES_VERSION
    || input.output.maxFiles !== MAX_AGENT_HANDOFF_FILES
    || input.output.maxFileBytes !== MAX_AGENT_HANDOFF_FILE_BYTES
    || input.output.maxTotalBytes !== MAX_AGENT_HANDOFF_TOTAL_BYTES) {
    throw handoffError("Agent handoff output limits or version do not match the gateway contract.", "AGENT_HANDOFF_LIMIT_MISMATCH");
  }
  if (input.files.length > MAX_AGENT_HANDOFF_FILES) {
    throw handoffError("Agent handoff includes too many files.", "AGENT_HANDOFF_TOO_MANY_FILES");
  }

  let totalBytes = 0;
  const seen = new Set<string>();
  const files = input.files.map((file) => {
    if (validateInputFilename(file.filename) !== file.filename) {
      throw handoffError(`Agent handoff filename is unsafe: ${file.filename}`, "AGENT_HANDOFF_UNSAFE_FILENAME");
    }
    const key = file.filename.toLowerCase();
    if (seen.has(key)) {
      throw handoffError(`Agent handoff filename is duplicated: ${file.filename}`, "AGENT_HANDOFF_DUPLICATE_FILENAME");
    }
    const buffer = decodeBase64Strict(file.contentBase64, file.filename);
    if (buffer.length !== file.sizeBytes || buffer.length <= 0 || buffer.length > MAX_AGENT_HANDOFF_FILE_BYTES) {
      throw handoffError(`Agent handoff file ${file.filename} failed its size attestation.`, "AGENT_HANDOFF_SIZE_MISMATCH");
    }
    if (sha256(buffer) !== file.sha256.toLowerCase()) {
      throw handoffError(`Agent handoff file ${file.filename} failed its checksum attestation.`, "AGENT_HANDOFF_CHECKSUM_MISMATCH");
    }
    totalBytes += buffer.length;
    if (totalBytes > MAX_AGENT_HANDOFF_TOTAL_BYTES) {
      throw handoffError("Agent handoff files exceed the total byte limit.", "AGENT_HANDOFF_TOO_LARGE");
    }
    seen.add(key);
    return { ...file, sha256: file.sha256.toLowerCase(), contentBase64: buffer.toString("base64") };
  });
  input.output.requestedGlobs.forEach(validateRelativePath);
  return {
    ...input,
    files,
    sourceArtifactIds: [...new Set(input.sourceArtifactIds)],
    output: {
      ...input.output,
      requestedGlobs: [...input.output.requestedGlobs],
    },
  };
}

export function redactAgentHandoff(input: RemoteAgentHandoff): RemoteAgentHandoff {
  const normalized = normalizeAgentHandoff(input);
  return {
    ...normalized,
    files: [],
  };
}

export function buildHandoffPrompt(handoff: RemoteAgentHandoff): string {
  const normalized = normalizeAgentHandoff(handoff);
  return [
    "Gateway-verified file handoff:",
    `- Read input metadata from ${normalized.manifestPath}.`,
    `- ${normalized.runDirectory} is gateway scratch space. Never git-add, commit, publish, or deploy files from that directory.`,
    normalized.files.length > 0
      ? `- ${normalized.files.length} input file(s) are staged in ${normalized.contextDirectory}.`
      : "- No input files were staged; this run only requests returned artifacts.",
    normalized.output.enabled
      ? `- Copy only files that should return to KimiBuilt into ${normalized.output.filesDirectory}.`
      : "- No returned artifact collection was requested.",
    normalized.output.enabled
      ? `- Write ${normalized.output.manifestPath} as JSON: {\"version\":\"${REMOTE_AGENT_RESULT_FILES_VERSION}\",\"files\":[{\"path\":\"${normalized.output.filesDirectory}/example.ext\",\"role\":\"deliverable\",\"mimeType\":\"application/octet-stream\",\"description\":\"...\"}]}.`
      : "",
    normalized.output.enabled
      ? `- Finish with RESULT_FILES_MANIFEST=${normalized.output.manifestPath}.`
      : "",
  ].filter(Boolean).join("\n");
}

function buildAcknowledgement(handoff: RemoteAgentHandoff): AgentHandoffAcknowledgement {
  return {
    accepted: true,
    version: REMOTE_AGENT_HANDOFF_VERSION,
    operationId: handoff.operationId,
    inputManifestPath: handoff.manifestPath,
    ...(handoff.output.enabled ? { resultManifestPath: handoff.output.manifestPath } : {}),
  };
}

function buildInputManifest(handoff: RemoteAgentHandoff): Record<string, unknown> {
  return {
    version: REMOTE_AGENT_HANDOFF_VERSION,
    operationId: handoff.operationId,
    generatedAt: new Date().toISOString(),
    directory: handoff.contextDirectory,
    files: handoff.files.map(({ contentBase64: _contentBase64, ...file }) => ({
      ...file,
      path: `${handoff.contextDirectory}/${file.filename}`,
      relativePath: `${handoff.contextDirectory}/${file.filename}`,
    })),
    output: {
      version: handoff.output.version,
      enabled: handoff.output.enabled,
      directory: handoff.output.directory,
      filesDirectory: handoff.output.filesDirectory,
      manifestPath: handoff.output.manifestPath,
      requestedGlobs: handoff.output.requestedGlobs,
      limits: {
        maxFiles: handoff.output.maxFiles,
        maxFileBytes: handoff.output.maxFileBytes,
        maxTotalBytes: handoff.output.maxTotalBytes,
      },
    },
  };
}

async function writeJsonAtomically(targetPath: string, value: unknown): Promise<void> {
  const temporaryPath = `${targetPath}.tmp-${randomUUID()}`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, targetPath);
}

async function ensureSafeLocalParent(workspace: string, relativeParent: string): Promise<void> {
  let current = workspace;
  for (const segment of validateRelativePath(relativeParent).split("/")) {
    current = path.join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (info?.isSymbolicLink()) {
      throw handoffError(`Agent handoff parent is a symlink: ${segment}`, "AGENT_HANDOFF_UNSAFE_PARENT");
    }
    if (info && !info.isDirectory()) {
      throw handoffError(`Agent handoff parent is not a directory: ${segment}`, "AGENT_HANDOFF_UNSAFE_PARENT");
    }
    if (!info) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        const afterRace = await lstat(current).catch(() => null);
        if (!afterRace?.isDirectory() || afterRace.isSymbolicLink()) {
          throw error;
        }
      }
    }
  }
}

async function resolveRealLocalWorkspace(workspacePath: string): Promise<string> {
  const resolved = path.resolve(workspacePath);
  const info = await lstat(resolved).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw handoffError("Agent handoff workspace is not a safe directory.", "AGENT_HANDOFF_UNSAFE_WORKSPACE");
  }
  return realpath(resolved);
}

async function resolveSafeExistingLocalPath(
  workspace: string,
  relativePath: string,
  errorCode: string,
): Promise<{ absolutePath: string; realPath: string; info: Awaited<ReturnType<typeof lstat>> }> {
  const safeRelativePath = validateRelativePath(relativePath);
  let current = workspace;
  let info: Awaited<ReturnType<typeof lstat>> | null = null;
  const segments = safeRelativePath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    info = await lstat(current).catch(() => null);
    if (!info) {
      throw handoffError(`Agent handoff path does not exist: ${safeRelativePath}`, errorCode);
    }
    if (info.isSymbolicLink()) {
      throw handoffError(`Agent handoff path contains a symlink: ${safeRelativePath}`, errorCode);
    }
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw handoffError(`Agent handoff path has a non-directory parent: ${safeRelativePath}`, errorCode);
    }
  }
  if (!info) {
    throw handoffError(`Agent handoff path does not exist: ${safeRelativePath}`, errorCode);
  }
  const realPath = await realpath(current);
  if (!isWithinPath(realPath, workspace)) {
    throw handoffError(`Agent handoff path escapes the real workspace: ${safeRelativePath}`, errorCode);
  }
  return { absolutePath: current, realPath, info };
}

async function readSafeLocalFile(
  workspace: string,
  relativePath: string,
  allowedRealRoot: string,
  errorCode: string,
  maxBytes: number,
): Promise<Buffer> {
  const initial = await resolveSafeExistingLocalPath(workspace, relativePath, errorCode);
  if (!initial.info.isFile() || !isWithinPath(initial.realPath, allowedRealRoot)) {
    throw handoffError(`Agent handoff file is outside its safe root: ${relativePath}`, errorCode);
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(initial.absolutePath, fsConstants.O_RDONLY | noFollow);
  try {
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile()
      || openedInfo.size <= 0
      || openedInfo.size > maxBytes
      || !sameFileIdentity(initial.info, openedInfo)) {
      throw handoffError(`Agent handoff file changed before it could be opened safely: ${relativePath}`, errorCode);
    }
    const rechecked = await resolveSafeExistingLocalPath(workspace, relativePath, errorCode);
    if (!rechecked.info.isFile()
      || !isWithinPath(rechecked.realPath, allowedRealRoot)
      || !sameFileIdentity(openedInfo, rechecked.info)) {
      throw handoffError(`Agent handoff file changed during safe-open verification: ${relativePath}`, errorCode);
    }
    const buffer = await handle.readFile();
    const afterRead = await handle.stat();
    if (!sameFileIdentity(openedInfo, afterRead)
      || buffer.length <= 0
      || buffer.length > maxBytes) {
      throw handoffError(`Agent handoff file changed or exceeded its limit while reading: ${relativePath}`, errorCode);
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

async function readLocalResultManifest(
  workspace: string,
  handoff: RemoteAgentHandoff,
  outputRealRoot: string,
): Promise<AgentResultManifest> {
  const buffer = await readSafeLocalFile(
    workspace,
    handoff.output.manifestPath,
    outputRealRoot,
    "AGENT_RESULT_MANIFEST_INVALID",
    MAX_RESULT_MANIFEST_BYTES,
  );
  return parseResultManifest(buffer);
}

function parseResultManifest(buffer: Buffer): AgentResultManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw handoffError("Remote agent result manifest is not valid JSON.", "AGENT_RESULT_MANIFEST_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw handoffError("Remote agent result manifest must be an object.", "AGENT_RESULT_MANIFEST_INVALID");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== REMOTE_AGENT_RESULT_FILES_VERSION || !Array.isArray(record.files)) {
    throw handoffError(`Remote agent result manifest must use ${REMOTE_AGENT_RESULT_FILES_VERSION}.`, "AGENT_RESULT_MANIFEST_VERSION_MISMATCH");
  }
  if (record.files.length > MAX_AGENT_HANDOFF_FILES) {
    throw handoffError("Remote agent result manifest includes too many files.", "AGENT_RESULT_FILES_TOO_MANY");
  }
  const files = record.files.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw handoffError(`Remote agent result manifest file ${index + 1} is invalid.`, "AGENT_RESULT_MANIFEST_INVALID");
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.path !== "string" || !entry.path.trim()) {
      throw handoffError(`Remote agent result manifest file ${index + 1} has no path.`, "AGENT_RESULT_MANIFEST_INVALID");
    }
    return {
      path: entry.path,
      role: typeof entry.role === "string" ? entry.role.slice(0, 120) : undefined,
      mimeType: typeof entry.mimeType === "string" ? entry.mimeType.slice(0, 256) : undefined,
      description: typeof entry.description === "string" ? entry.description.slice(0, 2000) : undefined,
    };
  });
  return { version: REMOTE_AGENT_RESULT_FILES_VERSION, files };
}

function validateResultPath(value: string, handoff: RemoteAgentHandoff): string {
  const relativePath = validateRelativePath(value);
  if (!relativePath.startsWith(`${handoff.output.filesDirectory}/`)) {
    throw handoffError(`Remote agent result path is outside the isolated files directory: ${relativePath}`, "AGENT_RESULT_FILES_UNSAFE_PATH");
  }
  return relativePath;
}

function buildVerifiedResultFile(
  entry: AgentResultManifestEntry,
  relativePath: string,
  buffer: Buffer,
  index: number,
): GatewayVerifiedResultFile {
  return {
    path: relativePath,
    filename: path.posix.basename(relativePath) || `result-${index + 1}.bin`,
    role: entry.role?.trim() || "deliverable",
    mimeType: entry.mimeType?.trim() || "application/octet-stream",
    description: entry.description?.trim() || "",
    sizeBytes: buffer.length,
    sha256: sha256(buffer),
    contentBase64: buffer.toString("base64"),
  };
}

function buildVerifiedEnvelope(
  handoff: RemoteAgentHandoff,
  files: GatewayVerifiedResultFile[],
): GatewayVerifiedResultFiles {
  return {
    version: REMOTE_AGENT_RESULT_FILES_VERSION,
    gatewayVerified: true,
    operationId: handoff.operationId,
    manifestPath: handoff.output.manifestPath,
    files,
  };
}

function assertResultFilesRequested(handoff: RemoteAgentHandoff): void {
  if (!handoff.output.enabled) {
    throw handoffError("Remote agent result files were not requested for this run.", "AGENT_RESULT_FILES_NOT_REQUESTED");
  }
}

function validateRelativePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)) {
    throw handoffError(`Agent handoff path must be workspace-relative: ${value}`, "AGENT_HANDOFF_UNSAFE_PATH");
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw handoffError(`Agent handoff path escapes the workspace: ${value}`, "AGENT_HANDOFF_UNSAFE_PATH");
  }
  return segments.join("/");
}

function validateInputFilename(value: string): string {
  const normalized = value.trim();
  if (!normalized
    || normalized === "manifest.json"
    || normalized === "."
    || normalized === ".."
    || normalized.includes("/")
    || normalized.includes("\\")
    || /[<>:"|?*\x00-\x1F]/.test(normalized)) {
    throw handoffError(`Agent handoff filename is unsafe: ${value}`, "AGENT_HANDOFF_UNSAFE_FILENAME");
  }
  return normalized;
}

function resolveWithinWorkspace(workspace: string, relativePath: string): string {
  const safeRelativePath = validateRelativePath(relativePath);
  const resolved = path.resolve(workspace, ...safeRelativePath.split("/"));
  if (!isWithinPath(resolved, workspace) || resolved === workspace) {
    throw handoffError(`Agent handoff path escapes the workspace: ${relativePath}`, "AGENT_HANDOFF_UNSAFE_PATH");
  }
  return resolved;
}

function isWithinPath(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function decodeBase64Strict(value: string, label: string): Buffer {
  const compact = value.replace(/\s+/g, "");
  if (!compact
    || compact.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw handoffError(`Agent handoff file ${label} contains invalid base64.`, "AGENT_HANDOFF_INVALID_BASE64");
  }
  return Buffer.from(compact, "base64");
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function handoffError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
