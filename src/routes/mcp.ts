import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type { RemoteCliToolAuthScope, RemoteCliTargetConfig } from "../types";
import { RemoteCliToolManager } from "../jobs/remote-cli-tool-manager";

interface McpRoutesOptions {
  manager: RemoteCliToolManager;
  adminApiKey: string;
  frontendApiKeys: Set<string>;
  n8nApiKeys: Set<string>;
  authScopes: Set<RemoteCliToolAuthScope>;
}

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

const runArgsSchema = z.object({
  targetId: z.string().min(1),
  cwd: z.string().min(1).optional(),
  task: z.string().min(1),
  model: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  adminMode: z.boolean().optional(),
  waitMs: z.number().int().min(0).max(30_000).optional(),
}).passthrough();

const jobArgsSchema = z.object({
  jobId: z.string().min(1),
}).passthrough();

export const mcpRoutes: FastifyPluginAsync<McpRoutesOptions> = async (app, options) => {
  app.addHook("preHandler", async (request, reply) => {
    const scope = getRemoteCliAuthScope(request, options);
    if (!scope || !options.authScopes.has(scope)) {
      reply.status(401).send({
        error: "Unauthorized",
      });
      return reply;
    }
  });

  app.post("/mcp", async (request, reply) => {
    const payload = request.body;
    if (Array.isArray(payload)) {
      const responses = await Promise.all(payload.map((item) => handleRpcRequest(item, options)));
      const responseBody = responses.filter((item): item is Record<string, unknown> => item !== null);
      if (responseBody.length === 0) {
        return reply.status(202).send();
      }
      return responseBody;
    }

    const response = await handleRpcRequest(payload, options);
    if (!response) {
      return reply.status(202).send();
    }
    return response;
  });
};

async function handleRpcRequest(
  raw: unknown,
  options: McpRoutesOptions,
): Promise<Record<string, unknown> | null> {
  if (!raw || typeof raw !== "object") {
    return rpcError(null, -32600, "Invalid JSON-RPC request.");
  }

  const request = raw as JsonRpcRequest;
  const id = request.id ?? null;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return rpcError(id, -32600, "Invalid JSON-RPC request.");
  }

  try {
    switch (request.method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: "2025-03-26",
          capabilities: {
            tools: {
              listChanged: false,
            },
          },
          serverInfo: {
            name: "n8n-openai-cli-gateway-remote-cli",
            version: "0.1.0",
          },
        });

      case "notifications/initialized":
        return null;

      case "ping":
        return rpcResult(id, {});

      case "tools/list":
        return rpcResult(id, {
          tools: buildToolsList(options.manager.listTargets()),
        });

      case "tools/call":
        return rpcResult(id, await callTool(request.params, options.manager));

      default:
        return rpcError(id, -32601, `Unknown MCP method: ${request.method}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "MCP tool call failed.";
    return rpcError(id, -32000, message);
  }
}

async function callTool(params: unknown, manager: RemoteCliToolManager): Promise<Record<string, unknown>> {
  const record = params && typeof params === "object" ? params as Record<string, unknown> : {};
  const name = typeof record.name === "string" ? record.name : "";
  const args = record.arguments && typeof record.arguments === "object"
    ? record.arguments as Record<string, unknown>
    : {};

  switch (name) {
    case "remote_code_run": {
      rejectRawCommandFields(args);
      const parsed = runArgsSchema.parse(args);
      const result = await manager.run(parsed);
      return toolResult(result);
    }

    case "remote_code_status": {
      const parsed = jobArgsSchema.parse(args);
      const result = manager.getJob(parsed.jobId);
      if (!result) {
        throw new Error(`Unknown remote CLI job: ${parsed.jobId}`);
      }
      return toolResult(result);
    }

    case "remote_code_cancel": {
      const parsed = jobArgsSchema.parse(args);
      const result = manager.cancel(parsed.jobId);
      return toolResult(result);
    }

    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}

function buildToolsList(targets: RemoteCliTargetConfig[]): Array<Record<string, unknown>> {
  const targetIds = targets.map((target) => target.targetId);
  const targetSchema = targetIds.length > 0
    ? { type: "string", enum: targetIds }
    : { type: "string" };

  return [
    {
      name: "remote_code_run",
      description: "Run a high-level coding task on a configured remote server using OpenCode over SSH.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          targetId: targetSchema,
          cwd: {
            type: "string",
            description: "Absolute remote working directory inside the target's allowed roots.",
          },
          task: {
            type: "string",
            description: "High-level coding task for OpenCode.",
          },
          model: {
            type: "string",
            description: "Optional OpenCode model override.",
          },
          sessionId: {
            type: "string",
            description: "Optional OpenCode session id to continue.",
          },
          adminMode: {
            type: "boolean",
            description: "Use the configured admin-capable remote Codex lane for scoped live deploy and verification work.",
          },
          waitMs: {
            type: "integer",
            minimum: 0,
            maximum: 30000,
            description: "Milliseconds to wait before returning a running job.",
          },
        },
        required: ["targetId", "task"],
      },
    },
    {
      name: "remote_code_status",
      description: "Poll a previously started remote coding job.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          jobId: {
            type: "string",
          },
        },
        required: ["jobId"],
      },
    },
    {
      name: "remote_code_cancel",
      description: "Cancel a running remote coding job.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          jobId: {
            type: "string",
          },
        },
        required: ["jobId"],
      },
    },
  ];
}

function toolResult(result: unknown): Record<string, unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result),
      },
    ],
    structuredContent: result,
  };
}

function rejectRawCommandFields(args: Record<string, unknown>): void {
  for (const key of ["command", "args", "executable", "shell"]) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      throw new Error(`remote_code_run does not accept raw command field '${key}'.`);
    }
  }
}

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}

function getRemoteCliAuthScope(
  request: FastifyRequest,
  options: Pick<McpRoutesOptions, "adminApiKey" | "frontendApiKeys" | "n8nApiKeys">,
): RemoteCliToolAuthScope | null {
  const token = extractApiToken(request);
  if (!token) {
    return null;
  }
  if (token === options.adminApiKey) {
    return "admin";
  }
  if (options.frontendApiKeys.has(token)) {
    return "frontend";
  }
  if (options.n8nApiKeys.has(token)) {
    return "n8n";
  }
  return null;
}

function extractApiToken(request: FastifyRequest): string | null {
  const xApiKey = request.headers["x-api-key"];
  const xApiKeyValue = Array.isArray(xApiKey) ? xApiKey[0] : xApiKey;
  if (typeof xApiKeyValue === "string" && xApiKeyValue.trim()) {
    return xApiKeyValue.trim();
  }

  const authorization = request.headers.authorization;
  if (authorization && authorization.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice("bearer ".length).trim();
    if (token) {
      return token;
    }
  }

  return null;
}
