import { spawn } from "node:child_process";
import os from "node:os";
import process from "node:process";
import {
  buildPrompt,
  parseJsonContractFromText,
} from "./kimi-acp-bridge.js";

interface GatewayRequest {
  prompt?: unknown;
  messages?: unknown;
  tools?: unknown;
  metadata?: unknown;
}

interface JsonRpcMessage {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: {
    message?: unknown;
    data?: unknown;
  };
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface GrokContract {
  output_text: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  finish_reason: "stop" | "tool_calls" | "length" | "error";
}

class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications: unknown[] = [];
  private readonly waiters: Array<(value: unknown | null) => void> = [];
  private buffer = "";
  private ended = false;

  constructor(private readonly child: ReturnType<typeof spawn>) {
    if (!child.stdin || !child.stdout) {
      throw new Error("Grok ACP stdio streams are unavailable.");
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.drain();
    });
    child.on("error", (error) => this.rejectAll(error));
    child.on("close", () => {
      this.ended = true;
      this.rejectAll(new Error("Grok ACP process closed."));
    });
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Grok ACP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  respond(id: unknown, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  async nextNotification(timeoutMs: number): Promise<unknown | null> {
    if (this.notifications.length > 0) {
      return this.notifications.shift() ?? null;
    }
    if (this.ended) {
      return null;
    }

    return await new Promise<unknown | null>((resolve) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(resolve);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        resolve(null);
      }, timeoutMs);
      this.waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  private send(value: unknown): void {
    if (!this.child.stdin) {
      throw new Error("Grok ACP stdin is unavailable.");
    }
    this.child.stdin.write(`${JSON.stringify(value)}\n`, "utf8");
  }

  private drain(): void {
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }

      const line = this.buffer.slice(0, newline).replace(/\r$/, "").trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) {
        continue;
      }

      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }

      if (
        typeof message.id === "number" &&
        (Object.prototype.hasOwnProperty.call(message, "result") || message.error)
      ) {
        const pending = this.pending.get(message.id);
        if (!pending) {
          continue;
        }
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          const detail =
            message.error.data === undefined ? "" : ` data=${stringify(message.error.data)}`;
          pending.reject(
            new Error(
              `Grok ACP ${pending.method} failed: ${stringify(message.error.message)}${detail}`,
            ),
          );
        } else {
          pending.resolve(message.result);
        }
        continue;
      }

      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(message);
      } else {
        this.notifications.push(message);
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    while (this.waiters.length > 0) {
      this.waiters.shift()?.(null);
    }
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });
}

function parseModel(argv: string[]): string {
  const index = argv.indexOf("--model");
  const fromArg = index >= 0 ? argv[index + 1] : undefined;
  if (typeof fromArg === "string" && fromArg.trim()) {
    return fromArg.trim();
  }
  return "grok-build";
}

function readTimeoutMs(): number {
  const value = Number(process.env.GROK_ACP_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 600_000;
}

export function selectGrokAuthMethod(
  initializeResult: unknown,
  hasApiKey: boolean,
): string | null {
  if (!isRecord(initializeResult) || !Array.isArray(initializeResult.authMethods)) {
    return null;
  }

  const ids = initializeResult.authMethods
    .map((entry) => (isRecord(entry) && typeof entry.id === "string" ? entry.id : ""))
    .filter(Boolean);
  if (hasApiKey && ids.includes("xai.api_key")) {
    return "xai.api_key";
  }
  if (ids.includes("cached_token")) {
    return "cached_token";
  }
  return ids[0] ?? null;
}

export function extractGrokAgentText(message: unknown): string {
  if (!isRecord(message) || message.method !== "session/update" || !isRecord(message.params)) {
    return "";
  }
  const update = isRecord(message.params.update) ? message.params.update : null;
  if (!update || update.sessionUpdate !== "agent_message_chunk") {
    return "";
  }
  if (typeof update.content === "string") {
    return update.content;
  }
  if (isRecord(update.content) && typeof update.content.text === "string") {
    return update.content.text;
  }
  return "";
}

function extractSessionId(result: unknown): string {
  if (isRecord(result) && typeof result.sessionId === "string" && result.sessionId) {
    return result.sessionId;
  }
  throw new Error("Grok ACP session/new did not return a session id.");
}

async function selectModel(
  rpc: JsonRpcClient,
  sessionId: string,
  sessionResult: unknown,
  model: string,
  timeoutMs: number,
): Promise<void> {
  if (!isRecord(sessionResult) || !Array.isArray(sessionResult.configOptions)) {
    return;
  }
  const modelOption = sessionResult.configOptions.find(
    (entry) => isRecord(entry) && entry.category === "model" && typeof entry.id === "string",
  );
  if (!isRecord(modelOption) || typeof modelOption.id !== "string") {
    return;
  }
  const options = Array.isArray(modelOption.options) ? modelOption.options : [];
  const match = options.find(
    (entry) =>
      isRecord(entry) &&
      typeof entry.value === "string" &&
      (entry.value === model || entry.name === model),
  );
  if (!isRecord(match) || typeof match.value !== "string") {
    return;
  }
  await rpc.request(
    "session/set_config_option",
    { sessionId, configId: modelOption.id, value: match.value },
    timeoutMs,
  );
}

function rejectPermission(rpc: JsonRpcClient, message: JsonRpcMessage): boolean {
  if (message.method !== "session/request_permission" || message.id === undefined) {
    return false;
  }
  rpc.respond(message.id, { outcome: { outcome: "cancelled" } });
  return true;
}

function stopChild(child: ReturnType<typeof spawn>): void {
  child.stdin?.end();
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 1500).unref();
}

async function run(): Promise<void> {
  const rawRequest = await readStdin();
  if (!rawRequest.trim()) {
    process.stdout.write(JSON.stringify({ output_text: "", finish_reason: "stop" }));
    return;
  }

  const request = JSON.parse(rawRequest) as GatewayRequest;
  const model = parseModel(process.argv.slice(2));
  const timeoutMs = readTimeoutMs();
  const child = spawn("grok", [
    "--no-auto-update",
    "--permission-mode",
    "dontAsk",
    "--sandbox",
    "strict",
    "--disable-web-search",
    "--no-subagents",
    "--no-memory",
    "agent",
    "stdio",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const rpc = new JsonRpcClient(child);

  try {
    const initialized = await rpc.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: {
          name: "n8n-openai-cli-gateway",
          title: "n8n OpenAI CLI Gateway",
          version: "0.1.0",
        },
      },
      Math.min(timeoutMs, 60_000),
    );

    const authMethod = selectGrokAuthMethod(initialized, Boolean(process.env.XAI_API_KEY));
    if (authMethod) {
      await rpc.request(
        "authenticate",
        { methodId: authMethod, _meta: { headless: true } },
        Math.min(timeoutMs, 120_000),
      );
    }

    const sessionResult = await rpc.request(
      "session/new",
      {
        cwd: process.env.GROK_ACP_CWD?.trim() || os.tmpdir(),
        mcpServers: [],
      },
      Math.min(timeoutMs, 120_000),
    );
    const sessionId = extractSessionId(sessionResult);
    await selectModel(rpc, sessionId, sessionResult, model, Math.min(timeoutMs, 120_000));

    let promptComplete = false;
    let promptError: Error | null = null;
    const promptPromise = rpc
      .request(
        "session/prompt",
        {
          sessionId,
          prompt: [{ type: "text", text: buildPrompt(request) }],
        },
        timeoutMs,
      )
      .then(() => {
        promptComplete = true;
      })
      .catch((error) => {
        promptComplete = true;
        promptError = error instanceof Error ? error : new Error(String(error));
      });

    const chunks: string[] = [];
    let deniedPermission = false;
    let completedIdlePolls = 0;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs && completedIdlePolls < 2) {
      const notification = await rpc.nextNotification(500);
      if (!notification) {
        if (promptComplete) {
          completedIdlePolls += 1;
        }
        continue;
      }
      completedIdlePolls = 0;
      const message = notification as JsonRpcMessage;
      deniedPermission = rejectPermission(rpc, message) || deniedPermission;
      const text = extractGrokAgentText(message);
      if (text) {
        chunks.push(text);
      }
    }
    await promptPromise;
    if (promptError) {
      throw promptError;
    }

    const output = chunks.join("").trim();
    const contract = parseJsonContractFromText(output);
    if (contract) {
      process.stdout.write(JSON.stringify(contract));
      return;
    }
    if (!output && deniedPermission) {
      throw new Error("Grok ACP requested local tool permission instead of returning an answer.");
    }

    process.stdout.write(
      JSON.stringify({ output_text: output, finish_reason: "stop" } satisfies GrokContract),
    );
  } finally {
    stopChild(child);
    if (stderr.trim()) {
      process.stderr.write(`${stderr.trim()}\n`);
    }
  }
}

if (require.main === module) {
  void run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
