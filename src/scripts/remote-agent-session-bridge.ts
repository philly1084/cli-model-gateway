import { spawn } from "node:child_process";

export interface RemoteAgentCliCommand {
  executable: string;
  args: string[];
}

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
    return {
      executable: "kimi",
      args: [
        "--quiet",
        "--afk",
        ...(model ? ["--model", model] : []),
        "--prompt",
        prompt,
      ],
    };
  }
  throw new Error(`Unsupported remote-agent CLI provider: ${provider || "missing"}`);
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
