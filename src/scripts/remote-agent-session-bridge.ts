import { spawn } from "node:child_process";

export interface RemoteAgentCliCommand {
  executable: string;
  args: string[];
}

export function buildRemoteAgentCliCommand(
  provider: string,
  prompt: string,
  model = "",
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
  const command = buildRemoteAgentCliCommand(options.provider, prompt, options.model);
  const child = spawn(command.executable, command.args, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  forwardOutput(child);
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

function forwardOutput(child: { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream }): void {
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
}

function parseArgs(args: string[]): { provider: string; model: string } {
  let provider = "";
  let model = "";
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--provider") {
      provider = args[index + 1] ?? "";
      index += 1;
    } else if (value === "--model") {
      model = args[index + 1] ?? "";
      index += 1;
    }
  }
  return { provider: provider.trim().toLowerCase(), model: model.trim() };
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
