import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ProviderRegistry } from "../providers/registry";
import { RemoteAgentManager } from "../jobs/remote-agent-manager";
import { remoteAgentTaskCreateRequestSchema } from "../validation";

interface RemoteAgentRoutesOptions {
  registry: ProviderRegistry;
  manager: RemoteAgentManager;
  adminApiKey: string;
  frontendApiKeys: Set<string>;
}

type AuthScope = "admin" | "frontend";

type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

export const remoteAgentRoutes: FastifyPluginAsync<RemoteAgentRoutesOptions> = async (
  app,
  options,
) => {
  app.addHook("preHandler", async (request, reply) => {
    if (isStreamTokenAuthorized(request, options.manager)) {
      return;
    }
    const scope = getAuthScope(request, options.frontendApiKeys, options.adminApiKey);
    if (!scope) {
      reply.status(401).send({ error: "Unauthorized" });
      return reply;
    }
    (request as FastifyRequest & { remoteAgentAuthScope?: AuthScope }).remoteAgentAuthScope = scope;
  });

  app.get("/remote-agent-targets", async () => ({
    data: options.manager.listTargets().map((target) => ({
      targetId: target.targetId,
      description: target.description,
      host: target.host,
      user: target.user,
      port: target.port,
      allowedCwds: target.allowedCwds,
      defaultCwd: target.defaultCwd,
      defaultModel: target.defaultModel,
    })),
  }));

  app.get("/remote-agent-tasks", async (request) => {
    const query = request.query as Record<string, unknown>;
    const limitRaw = typeof query.limit === "string" ? Number(query.limit) : 50;
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 50;
    return {
      data: options.manager.listTasks(Math.min(limit, 200)),
    };
  });

  app.post("/remote-agent-tasks", async (request, reply) => {
    const validationResult = validateBody(request.body, remoteAgentTaskCreateRequestSchema);
    if (!validationResult.success) {
      return reply.status(400).send({ error: validationResult.error });
    }

    const provider = options.registry.getProvider(validationResult.data.providerId);
    if (!provider) {
      return reply.status(404).send({ error: `Unknown provider: ${validationResult.data.providerId}` });
    }

    try {
      const scope = getRequestScope(request);
      const task = await options.manager.createTask({
        provider,
        targetId: validationResult.data.targetId,
        task: validationResult.data.task,
        sessionId: validationResult.data.sessionId,
        cwd: validationResult.data.cwd,
        model: validationResult.data.model,
        adminMode: validationResult.data.adminMode,
        cols: validationResult.data.cols ?? 120,
        rows: validationResult.data.rows ?? 40,
        allowAnyProviderCwd: scope === "admin",
        handoff: validationResult.data.handoff,
      });

      const handoff = options.manager.getHandoffAcknowledgement(task.id);

      return {
        task: {
          ...task,
          ...(handoff ? { handoff } : {}),
        },
        streamUrl: `/admin/remote-agent-tasks/${task.id}/stream?token=${encodeURIComponent(task.streamToken)}`,
        providerSessionUrl: `/admin/provider-sessions/${task.sessionId}`,
        ...(handoff?.resultManifestPath
          ? { resultFilesUrl: `/admin/remote-agent-tasks/${task.id}/result-files` }
          : {}),
      };
    } catch (error) {
      return reply.status(400).send({
        error: error instanceof Error ? error.message : "Failed to create remote agent task.",
      });
    }
  });

  app.get("/remote-agent-tasks/:taskId", async (request, reply) => {
    const params = request.params as { taskId?: string };
    const taskId = params.taskId?.trim() || "";
    const task = options.manager.getTask(taskId);
    if (!task) {
      return reply.status(404).send({ error: `Unknown remote agent task: ${taskId}` });
    }
    return task;
  });

  app.get("/remote-agent-tasks/:taskId/transcript", async (request, reply) => {
    const params = request.params as { taskId?: string };
    const query = request.query as Record<string, unknown>;
    const taskId = params.taskId?.trim() || "";
    const afterCursorRaw = typeof query.after === "string" ? Number(query.after) : 0;
    const afterCursor = Number.isInteger(afterCursorRaw) && afterCursorRaw >= 0 ? afterCursorRaw : 0;
    const transcript = options.manager.getTranscript(taskId, afterCursor);
    if (!transcript) {
      return reply.status(404).send({ error: `Unknown remote agent task: ${taskId}` });
    }
    return { data: transcript };
  });

  app.post("/remote-agent-tasks/:taskId/cancel", async (request, reply) => {
    const params = request.params as { taskId?: string };
    const taskId = params.taskId?.trim() || "";
    try {
      return {
        task: await options.manager.cancelTask(taskId),
      };
    } catch (error) {
      return handleMutationError(reply, error);
    }
  });

  app.get("/remote-agent-tasks/:taskId/result-files", async (request, reply) => {
    const params = request.params as { taskId?: string };
    const taskId = params.taskId?.trim() || "";
    const task = options.manager.getTask(taskId);
    if (!task) {
      return reply.status(404).send({ error: `Unknown remote agent task: ${taskId}` });
    }
    if (!isFinalStatus(task.status)) {
      return reply.status(409).send({ error: `Remote agent task is not terminal: ${taskId}` });
    }
    if (!options.manager.getHandoffAcknowledgement(taskId)?.resultManifestPath) {
      return reply.status(404).send({ error: `Remote agent task did not request result files: ${taskId}` });
    }
    try {
      return await options.manager.getResultFiles(taskId);
    } catch (error) {
      return reply.status(422).send({
        error: error instanceof Error ? error.message : "Unable to collect remote agent result files.",
      });
    }
  });

  app.get("/remote-agent-tasks/:taskId/stream", async (request, reply) => {
    const params = request.params as { taskId?: string };
    const query = request.query as Record<string, unknown>;
    const taskId = params.taskId?.trim() || "";
    const task = options.manager.getTask(taskId);
    if (!task) {
      return reply.status(404).send({ error: `Unknown remote agent task: ${taskId}` });
    }

    const token = typeof query.token === "string" ? query.token.trim() : "";
    const afterCursorRaw = typeof query.after === "string" ? Number(query.after) : 0;
    const afterCursor = Number.isInteger(afterCursorRaw) && afterCursorRaw >= 0 ? afterCursorRaw : 0;
    const follow = !(query.follow === "false" || query.follow === false);
    if (token && token !== task.streamToken) {
      return reply.status(401).send({ error: "Invalid stream token." });
    }

    const initialEvents = options.manager.getTranscript(taskId, afterCursor) ?? [];
    if (!follow || isFinalStatus(task.status)) {
      reply.header("Content-Type", "text/event-stream; charset=utf-8");
      return initialEvents.map(formatSseEvent).join("");
    }

    reply.hijack();
    const raw = reply.raw;
    raw.statusCode = 200;
    raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    raw.setHeader("Cache-Control", "no-cache, no-transform");
    raw.setHeader("Connection", "keep-alive");

    for (const event of initialEvents) {
      raw.write(formatSseEvent(event));
    }

    const unsubscribe = options.manager.subscribe(
      taskId,
      (event) => {
        raw.write(formatSseEvent(event));
        if (event.type === "exit") {
          raw.end();
        }
      },
      {
        afterCursor: initialEvents.length > 0 ? (initialEvents[initialEvents.length - 1]?.cursor ?? afterCursor) : afterCursor,
        follow: true,
      },
    );
    if (!unsubscribe) {
      raw.end();
      return reply;
    }

    const heartbeat = setInterval(() => {
      raw.write(": keepalive\n\n");
    }, 15000);
    heartbeat.unref();

    raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    return reply;
  });
};

function getAuthScope(
  request: FastifyRequest,
  frontendApiKeys: Set<string>,
  adminApiKey: string,
): AuthScope | null {
  const token = extractApiToken(request);
  if (!token) {
    return null;
  }
  if (token === adminApiKey) {
    return "admin";
  }
  if (frontendApiKeys.has(token)) {
    return "frontend";
  }
  return null;
}

function isStreamTokenAuthorized(
  request: FastifyRequest,
  manager: RemoteAgentManager,
): boolean {
  const routeUrl = request.routeOptions?.url ?? "";
  if (request.method !== "GET"
    || routeUrl !== "/admin/remote-agent-tasks/:taskId/stream") {
    return false;
  }
  const params = request.params as { taskId?: string } | undefined;
  const query = request.query as Record<string, unknown> | undefined;
  const taskId = params?.taskId?.trim() || "";
  const token = typeof query?.token === "string" ? query.token.trim() : "";
  if (!taskId || !token) {
    return false;
  }
  const task = manager.getTask(taskId);
  return task?.streamToken === token;
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

function getRequestScope(request: FastifyRequest): AuthScope {
  const scope = (request as FastifyRequest & { remoteAgentAuthScope?: AuthScope }).remoteAgentAuthScope;
  return scope === "admin" ? "admin" : "frontend";
}

function validateBody<T>(body: unknown, schema: z.ZodSchema<T>): ValidationResult<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${path}: ${issue.message}`;
    });
    return { success: false, error: issues.join("; ") };
  }
  return { success: true, data: result.data };
}

function handleMutationError(reply: FastifyReply, error: unknown): FastifyReply {
  const message = error instanceof Error ? error.message : "Remote agent request failed.";
  const statusCode = message.startsWith("Unknown remote agent task:") ? 404 : 400;
  return reply.status(statusCode).send({ error: message });
}

function formatSseEvent(event: { type: string } & Record<string, unknown>): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function isFinalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "terminated" || status === "timed_out";
}
