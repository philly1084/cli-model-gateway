import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ProviderRegistry } from "../providers/registry";
import { ProviderSessionManager } from "../jobs/provider-session-manager";
import { requireRemoteReasoning } from "../utils/remote-reasoning";
import {
  providerSessionCreateRequestSchema,
  providerSessionInputRequestSchema,
  providerSessionResizeRequestSchema,
  providerSessionSignalRequestSchema,
} from "../validation";

interface ProviderSessionRoutesOptions {
  registry: ProviderRegistry;
  sessionManager: ProviderSessionManager;
  adminApiKey: string;
  frontendApiKeys: Set<string>;
}

type AuthScope = "admin" | "frontend";

type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

export const providerSessionRoutes: FastifyPluginAsync<ProviderSessionRoutesOptions> = async (
  app,
  options,
) => {
  app.addHook("preHandler", async (request, reply) => {
    if (isStreamTokenAuthorized(request, options.sessionManager)) {
      return;
    }
    const scope = getSessionAuthScope(request, options.frontendApiKeys, options.adminApiKey);
    if (!scope) {
      reply.status(401).send({ error: "Unauthorized" });
      return reply;
    }
    (request as FastifyRequest & { sessionAuthScope?: AuthScope }).sessionAuthScope = scope;
  });

  app.get("/provider-capabilities", async () => ({
    data: options.sessionManager.listCapabilities(options.registry.listProviders()),
  }));

  app.get("/provider-sessions", async (request) => {
    const query = request.query as Record<string, unknown>;
    const limitRaw = typeof query.limit === "string" ? Number(query.limit) : 50;
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 50;
    return {
      data: options.sessionManager.listSessions(Math.min(limit, 200)),
    };
  });

  app.post("/provider-sessions", async (request, reply) => {
    const validationResult = validateBody(request.body, providerSessionCreateRequestSchema);
    if (!validationResult.success) {
      return reply.status(400).send({ error: validationResult.error });
    }

    const provider = options.registry.getProvider(validationResult.data.providerId);
    if (!provider) {
      return reply.status(404).send({ error: `Unknown provider: ${validationResult.data.providerId}` });
    }

    try {
      const scope = getRequestScope(request);
      const session = await options.sessionManager.createSession({
        provider,
        mode: validationResult.data.mode ?? "interactive",
        model: validationResult.data.model,
        reasoningEffort: requireRemoteReasoning(validationResult.data.reasoningEffort),
        cwd: validationResult.data.cwd,
        cols: validationResult.data.cols ?? 120,
        rows: validationResult.data.rows ?? 40,
        allowAnyCwd: scope === "admin",
      });

      return {
        session,
        streamUrl: `/admin/provider-sessions/${session.id}/stream?token=${encodeURIComponent(session.streamToken)}`,
      };
    } catch (error) {
      return reply.status(400).send({
        error: error instanceof Error ? error.message : "Failed to create provider session.",
      });
    }
  });

  app.get("/provider-sessions/:sessionId", async (request, reply) => {
    const params = request.params as { sessionId?: string };
    const sessionId = params.sessionId?.trim() || "";
    const session = options.sessionManager.getSession(sessionId);
    if (!session) {
      return reply.status(404).send({ error: `Unknown provider session: ${sessionId}` });
    }
    return session;
  });

  app.get("/provider-sessions/:sessionId/transcript", async (request, reply) => {
    const params = request.params as { sessionId?: string };
    const query = request.query as Record<string, unknown>;
    const sessionId = params.sessionId?.trim() || "";
    const afterCursorRaw = typeof query.after === "string" ? Number(query.after) : 0;
    const afterCursor = Number.isInteger(afterCursorRaw) && afterCursorRaw >= 0 ? afterCursorRaw : 0;
    const transcript = options.sessionManager.getTranscript(sessionId, afterCursor);
    if (!transcript) {
      return reply.status(404).send({ error: `Unknown provider session: ${sessionId}` });
    }
    return { data: transcript };
  });

  app.post("/provider-sessions/:sessionId/input", async (request, reply) => {
    const params = request.params as { sessionId?: string };
    const sessionId = params.sessionId?.trim() || "";
    const validationResult = validateBody(request.body, providerSessionInputRequestSchema);
    if (!validationResult.success) {
      return reply.status(400).send({ error: validationResult.error });
    }

    try {
      return {
        session: options.sessionManager.writeInput(sessionId, validationResult.data.data),
      };
    } catch (error) {
      return handleSessionMutationError(reply, error);
    }
  });

  app.post("/provider-sessions/:sessionId/resize", async (request, reply) => {
    const params = request.params as { sessionId?: string };
    const sessionId = params.sessionId?.trim() || "";
    const validationResult = validateBody(request.body, providerSessionResizeRequestSchema);
    if (!validationResult.success) {
      return reply.status(400).send({ error: validationResult.error });
    }

    try {
      const session = options.sessionManager.resizeSession(
        sessionId,
        validationResult.data.cols,
        validationResult.data.rows,
      );
      return {
        session,
        applied: session.supportsResize,
      };
    } catch (error) {
      return handleSessionMutationError(reply, error);
    }
  });

  app.post("/provider-sessions/:sessionId/signal", async (request, reply) => {
    const params = request.params as { sessionId?: string };
    const sessionId = params.sessionId?.trim() || "";
    const validationResult = validateBody(request.body, providerSessionSignalRequestSchema);
    if (!validationResult.success) {
      return reply.status(400).send({ error: validationResult.error });
    }

    try {
      return {
        session: options.sessionManager.signalSession(sessionId, validationResult.data.signal ?? "SIGINT"),
      };
    } catch (error) {
      return handleSessionMutationError(reply, error);
    }
  });

  app.delete("/provider-sessions/:sessionId", async (request, reply) => {
    const params = request.params as { sessionId?: string };
    const sessionId = params.sessionId?.trim() || "";

    try {
      return {
        session: options.sessionManager.terminateSession(sessionId),
      };
    } catch (error) {
      return handleSessionMutationError(reply, error);
    }
  });

  app.get("/provider-sessions/:sessionId/stream", async (request, reply) => {
    const params = request.params as { sessionId?: string };
    const query = request.query as Record<string, unknown>;
    const sessionId = params.sessionId?.trim() || "";
    const session = options.sessionManager.getSession(sessionId);
    if (!session) {
      return reply.status(404).send({ error: `Unknown provider session: ${sessionId}` });
    }

    const token = typeof query.token === "string" ? query.token.trim() : "";
    const afterCursorRaw = typeof query.after === "string" ? Number(query.after) : 0;
    const afterCursor = Number.isInteger(afterCursorRaw) && afterCursorRaw >= 0 ? afterCursorRaw : 0;
    const follow = !(query.follow === "false" || query.follow === false);

    if (token && token !== session.streamToken) {
      return reply.status(401).send({ error: "Invalid stream token." });
    }

    const initialEvents = options.sessionManager.getTranscript(sessionId, afterCursor) ?? [];
    if (!follow || isFinalStatus(session.status)) {
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

    const unsubscribe = options.sessionManager.subscribe(
      sessionId,
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

function getSessionAuthScope(
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
  sessionManager: ProviderSessionManager,
): boolean {
  if (!request.url.includes("/provider-sessions/") || !request.url.includes("/stream")) {
    return false;
  }
  const params = request.params as { sessionId?: string } | undefined;
  const query = request.query as Record<string, unknown> | undefined;
  const sessionId = params?.sessionId?.trim() || "";
  const token = typeof query?.token === "string" ? query.token.trim() : "";
  if (!sessionId || !token) {
    return false;
  }
  const session = sessionManager.getSession(sessionId);
  return session?.streamToken === token;
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
  const scope = (request as FastifyRequest & { sessionAuthScope?: AuthScope }).sessionAuthScope;
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

function handleSessionMutationError(reply: FastifyReply, error: unknown): FastifyReply {
  const message = error instanceof Error ? error.message : "Provider session request failed.";
  const statusCode = message.startsWith("Unknown provider session:") ? 404 : 400;
  return reply.status(statusCode).send({ error: message });
}

function formatSseEvent(event: { type: string } & Record<string, unknown>): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function isFinalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "terminated" || status === "timed_out";
}
