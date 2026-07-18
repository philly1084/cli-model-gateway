import { spawn } from "node:child_process";
import { shellEscape } from "../utils/shell";

export interface RemoteAgentCliCommand {
  executable: string;
  args: string[];
}

interface RemoteCodexTarget {
  host: string;
  user?: string;
  port?: number;
  cwd: string;
  executable: string;
}

const REMOTE_TARGET_MARKER = "REMOTE_AGENT_TARGET_JSON=";

export function buildRemoteAgentCliCommand(
  provider: string,
  prompt: string,
  model = "",
  sessionId = "",
): RemoteAgentCliCommand {
  if (provider === "grok") {
    return {
      executable: "grok",
      args: [
        "--no-auto-update",
        ...(model ? ["--model", model] : []),
        "--permission-mode",
        "bypassPermissions",
        "--sandbox",
        "strict",
        "--disable-web-search",
        "--no-subagents",
        "--no-memory",
        "--output-format",
        "streaming-json",
        ...(sessionId ? ["--resume", sessionId] : []),
        "--single",
        prompt,
      ],
    };
  }
  if (provider === "kimi") {
    const resolvedModel = resolveKimiCliModel(model);
    return {
      executable: "kimi",
      args: [
        "--quiet",
        "--afk",
        ...(resolvedModel ? ["--model", resolvedModel] : []),
        "--prompt",
        prompt,
      ],
    };
  }
  if (provider === "codex") {
    const target = parseRemoteCodexTarget(prompt);
    const remotePrompt = buildRemoteCodexPrompt(prompt, target);
    const destination = target.user ? `${target.user}@${target.host}` : target.host;
    const remoteArgs = [
      shellEscape(target.executable),
      "run",
      "--format",
      "json",
      "--sandbox",
      "workspace-write",
      ...(model ? ["--model", shellEscape(model)] : []),
      ...(sessionId ? ["--session", shellEscape(sessionId)] : []),
      shellEscape(remotePrompt),
    ];
    return {
      executable: "ssh",
      args: [
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        ...(target.port ? ["-p", String(target.port)] : []),
        destination,
        `cd ${shellEscape(target.cwd)} && ${remoteArgs.join(" ")}`,
      ],
    };
  }
  throw new Error(`Unsupported remote-agent CLI provider: ${provider || "missing"}`);
}

export function buildRemoteCodexPrompt(prompt: string, target: RemoteCodexTarget): string {
  const taskBoundary = prompt.indexOf("\nTask:\n");
  if (taskBoundary < 0) {
    throw new Error("Codex remote-agent bootstrap must contain a Task boundary.");
  }
  const bootstrapLines = prompt.slice(0, taskBoundary).split(/\r?\n/);
  const remoteBootstrap = bootstrapLines
    .filter((line) => !line.startsWith(REMOTE_TARGET_MARKER) && !line.startsWith("- ssh:"))
    .map((line) => {
      if (line === "Use the configured remote target for this task:") {
        return "The gateway has already connected this Codex process to the configured remote target:";
      }
      if (line === "- Work through SSH on the configured target; do not request secrets from the user.") {
        return "- Work locally in the current remote workspace; do not run SSH to reach the configured target or request secrets from the user.";
      }
      return line;
    });
  remoteBootstrap.splice(
    1,
    0,
    `You are already on ${target.host} in ${target.cwd}; use local paths and commands in this process.`,
  );
  return `${remoteBootstrap.join("\n")}${prompt.slice(taskBoundary)}`;
}

export function resolveKimiCliModel(model: string): string {
  const value = model.trim();
  if (!value) {
    return "";
  }
  if (value === "k3" || value === "kimi-for-coding" || value === "kimi-for-coding-highspeed") {
    return `kimi-code/${value}`;
  }
  if (/^kimi-code\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    return value;
  }
  throw new Error(`Unsupported Kimi CLI model selector: ${value}`);
}

export function parseRemoteCodexTarget(prompt: string): RemoteCodexTarget {
  const taskBoundary = prompt.indexOf("\nTask:\n");
  const bootstrap = taskBoundary >= 0 ? prompt.slice(0, taskBoundary) : prompt;
  const targetLines = bootstrap
    .split(/\r?\n/)
    .filter((line) => line.startsWith(REMOTE_TARGET_MARKER));
  if (targetLines.length !== 1) {
    throw new Error("Codex remote-agent bootstrap must contain exactly one trusted target marker.");
  }
  const targetLine = targetLines[0];
  if (!targetLine) {
    throw new Error("Codex remote-agent bootstrap is missing its trusted target marker.");
  }
  let value: unknown;
  try {
    value = JSON.parse(targetLine.slice(REMOTE_TARGET_MARKER.length));
  } catch {
    throw new Error("Codex remote-agent target marker is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex remote-agent target marker must be an object.");
  }
  const target = value as Record<string, unknown>;
  if (typeof target.host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(target.host)) {
    throw new Error("Codex remote-agent target host is invalid.");
  }
  if (target.user !== undefined
    && (typeof target.user !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(target.user))) {
    throw new Error("Codex remote-agent target user is invalid.");
  }
  if (target.port !== undefined
    && (typeof target.port !== "number" || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535)) {
    throw new Error("Codex remote-agent target port is invalid.");
  }
  if (typeof target.cwd !== "string" || !/^\/(?:[^\0\r\n/]+\/?)*$/.test(target.cwd)) {
    throw new Error("Codex remote-agent target cwd is invalid.");
  }
  if (typeof target.executable !== "string" || !/^\/(?:[^\0\r\n/]+\/?)*$/.test(target.executable)) {
    throw new Error("Codex remote-agent executable must be an absolute POSIX path.");
  }
  return {
    host: target.host,
    user: target.user as string | undefined,
    port: target.port as number | undefined,
    cwd: target.cwd,
    executable: target.executable,
  };
}

export async function readPromptFromStdin(maxBytes = 512 * 1024): Promise<string> {
  process.stdin.setEncoding("utf8");
  let prompt = "";
  for await (const chunk of process.stdin) {
    prompt += chunk;
    if (Buffer.byteLength(prompt, "utf8") > maxBytes) {
      throw new Error(`Remote-agent prompt exceeds ${maxBytes} bytes.`);
    }
  }
  if (!prompt.trim()) {
    throw new Error("Remote-agent prompt is required on stdin.");
  }
  return prompt;
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const prompt = await readPromptFromStdin();
  const command = buildRemoteAgentCliCommand(
    options.provider,
    prompt,
    options.model,
    options.sessionId,
  );
  const child = spawn(command.executable, command.args, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  forwardOutput(child, options.provider);
  const forwardSignal = (signal: NodeJS.Signals) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };
  process.once("SIGINT", () => forwardSignal("SIGINT"));
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
}

function forwardOutput(
  child: { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream },
  provider: string,
): void {
  if (provider === "grok") {
    forwardGrokStreamingOutput(child.stdout);
  } else {
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  }
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
}

export function parseGrokStreamingLine(line: string): { text?: string; sessionId?: string } {
  const trimmed = line.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const event = JSON.parse(trimmed) as Record<string, unknown>;
    if (event.type === "text" && typeof event.data === "string") {
      return { text: event.data };
    }
    if (event.type === "end" && typeof event.sessionId === "string" && event.sessionId.trim()) {
      return { sessionId: event.sessionId.trim() };
    }
  } catch {
    return { text: line };
  }
  return {};
}

function forwardGrokStreamingOutput(stdout: NodeJS.ReadableStream): void {
  stdout.setEncoding("utf8");
  let buffer = "";
  const flushLine = (line: string) => {
    const event = parseGrokStreamingLine(line);
    if (event.text) {
      process.stdout.write(event.text);
    }
    if (event.sessionId) {
      process.stdout.write(`\nREMOTE_CLI_SESSION_ID=${event.sessionId}\n`);
    }
  };
  stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      flushLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  });
  stdout.on("end", () => {
    if (buffer) {
      flushLine(buffer);
    }
  });
}

function parseArgs(args: string[]): { provider: string; model: string; sessionId: string } {
  let provider = "";
  let model = "";
  let sessionId = "";
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--provider") {
      provider = args[index + 1] ?? "";
      index += 1;
    } else if (value === "--model") {
      model = args[index + 1] ?? "";
      index += 1;
    } else if (value === "--session") {
      sessionId = args[index + 1] ?? "";
      index += 1;
    }
  }
  return {
    provider: provider.trim().toLowerCase(),
    model: model.trim(),
    sessionId: sessionId.trim(),
  };
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
