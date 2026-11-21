import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import process from "node:process";
import {
  buildLocalLaunch,
  loadAgySubscriptionConfig,
  parseAgyJsonOutput,
  resolveAgyEffort,
  resolveAgyModel,
  runAgyLaunch,
  sanitizeDiagnostic,
  type GatewayRequest,
} from "./agy-subscription-bridge.js";

const DEFAULT_BIND = "127.0.0.1";
const DEFAULT_PORT = 8787;

export interface WorkerListenConfig {
  bind: string;
  port: number;
  token: string;
  executable: string;
  workdir?: string;
  printTimeout: string;
}

export function loadWorkerListenConfig(env: NodeJS.ProcessEnv = process.env): WorkerListenConfig {
  const portRaw = env.AGY_SUBSCRIPTION_PORT?.trim();
  const port = portRaw ? Number(portRaw) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("AGY_SUBSCRIPTION_PORT must be an integer from 1 to 65535.");
  }
  const token = env.AGY_SUBSCRIPTION_TOKEN?.trim();
  if (!token) {
    throw new Error("AGY_SUBSCRIPTION_TOKEN is required to start the worker.");
  }
  const bind = env.AGY_SUBSCRIPTION_BIND?.trim() || DEFAULT_BIND;
  if (bind === "0.0.0.0" || bind === "::" || bind === "*") {
    throw new Error("agy-subscription worker will not bind on a wildcard address. Set AGY_SUBSCRIPTION_BIND to a Tailscale or loopback address.");
  }
  const config = loadAgySubscriptionConfig(env);
  return {
    bind,
    port,
    token,
    executable: config.executable,
    workdir: config.workdir,
    printTimeout: config.printTimeout,
  };
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${token}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createAgySubscriptionWorker(config: WorkerListenConfig) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://agy-subscription.local");
      if (!authorized(req, config.token)) {
        send(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/healthz") {
        send(res, 200, { ok: true });
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/v1/complete") {
        send(res, 404, { ok: false, error: "not_found" });
        return;
      }
      const parsed = JSON.parse(await readBody(req)) as GatewayRequest & {
        model?: unknown;
        prompt?: unknown;
        effort?: unknown;
        printTimeout?: unknown;
        workdir?: unknown;
      };
      const model = resolveAgyModel(typeof parsed.model === "string" ? parsed.model : "");
      const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
      if (!prompt) {
        send(res, 400, { ok: false, error: "empty_prompt" });
        return;
      }
      const request: GatewayRequest = { prompt, reasoningEffort: parsed.effort };
      const stdout = await runAgyLaunch(
        buildLocalLaunch(
          {
            enabled: true,
            mode: "local",
            executable: config.executable,
            workdir:
              (typeof parsed.workdir === "string" && parsed.workdir.trim()) || config.workdir,
            sshExecutable: "ssh",
            sshPort: 22,
            printTimeout:
              (typeof parsed.printTimeout === "string" && parsed.printTimeout.trim()) ||
              config.printTimeout,
          },
          {
            model,
            prompt,
            effort: resolveAgyEffort(request),
          },
        ),
      );
      send(res, 200, parseAgyJsonOutput(stdout));
    } catch (error) {
      send(res, 500, {
        ok: false,
        error: sanitizeDiagnostic(error instanceof Error ? error.message : "worker_failed"),
      });
    }
  });
}

async function main(): Promise<void> {
  const config = loadWorkerListenConfig();
  const server = createAgySubscriptionWorker(config);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.bind, resolve);
  });
  process.stdout.write(`agy-subscription worker listening on ${config.bind}:${config.port}\n`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${sanitizeDiagnostic(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  });
}
