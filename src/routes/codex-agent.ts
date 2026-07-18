import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { CodexAgentManager } from "../jobs/codex-agent-manager";
import { codexAgentRunRequestSchema } from "../validation";

interface CodexAgentRoutesOptions {
  manager: CodexAgentManager;
  adminApiKey: string;
  frontendApiKeys: Set<string>;
}

type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

export const codexAgentRoutes: FastifyPluginAsync<CodexAgentRoutesOptions> = async (
  app,
  options,
) => {
  app.addHook("preHandler", async (request, reply) => {
    const token = extractApiToken(request);
    if (token && (token === options.adminApiKey || options.frontendApiKeys.has(token))) {
      return;
    }
    reply.status(401).send({ error: "Unauthorized" });
    return reply;
  });

  app.post("/run", async (request, reply) => {
    const validationResult = validateBody(request.body, codexAgentRunRequestSchema);
    if (!validationResult.success) {
      return reply.status(400).send({ error: validationResult.error });
    }

    try {
      const run = await options.manager.startRun(validationResult.data);
      const handoff = options.manager.getHandoffAcknowledgement(run.runId);
      return {
        ok: true,
        runId: run.runId,
        threadId: run.threadId,
        turnId: run.turnId,
        sessionId: run.sessionId,
        status: run.status,
        ...(handoff ? {
          handoff,
          ...(handoff.resultManifestPath
            ? { resultFilesUrl: `/api/codex-agent/runs/${run.runId}/result-files` }
            : {}),
        } : {}),
      };
    } catch (error) {
      return reply.status(400).send({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to start Codex agent run.",
      });
    }
  });

  app.get("/runs/:runId", async (request, reply) => {
    const runId = getRunId(request);
    const run = options.manager.getRun(runId);
    if (!run) {
      return reply.status(404).send({ error: `Unknown codex agent run: ${runId}` });
    }
    return run;
  });

  app.post("/runs/:runId/cancel", async (request, reply) => {
    const runId = getRunId(request);
    try {
      const run = await options.manager.cancelRun(runId);
      return { ok: true, status: run.status };
    } catch (error) {
      return handleMutationError(reply, error);
    }
  });

  app.get("/runs/:runId/result-files", async (request, reply) => {
    const runId = getRunId(request);
    const run = options.manager.getRun(runId);
    if (!run) {
      return reply.status(404).send({ error: `Unknown codex agent run: ${runId}` });
    }
    if (!isTerminalStatus(run.status)) {
      return reply.status(409).send({ error: `Codex agent run is not terminal: ${runId}` });
    }
    if (!options.manager.getHandoffAcknowledgement(runId)?.resultManifestPath) {
      return reply.status(404).send({ error: `Codex agent run did not request result files: ${runId}` });
    }
    try {
      return await options.manager.getResultFiles(runId);
    } catch (error) {
      return reply.status(422).send({
        error: error instanceof Error ? error.message : "Unable to collect Codex agent result files.",
      });
    }
  });

  app.get("/runs/:runId/events", async (request, reply) => {
    const runId = getRunId(request);
    const query = request.query as Record<string, unknown>;
    const afterRaw = typeof query.after === "string" ? Number(query.after) : 0;
    const after = Number.isInteger(afterRaw) && afterRaw >= 0 ? afterRaw : 0;
    const follow = !(query.follow === "false" || query.follow === false);
    const events = options.manager.getEvents(runId, after);
    if (!events) {
      return reply.status(404).send({ error: `Unknown codex agent run: ${runId}` });
    }
    const run = options.manager.getRun(runId);

    if (!follow || !run || isTerminalStatus(run.status)) {
      reply.header("Content-Type", "text/event-stream; charset=utf-8");
      return events.map(formatSseEvent).join("");
    }

    reply.hijack();
    const raw = reply.raw;
    raw.statusCode = 200;
    raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    raw.setHeader("Cache-Control", "no-cache, no-transform");
    raw.setHeader("Connection", "keep-alive");

    for (const event of events) {
      raw.write(formatSseEvent(event));
    }

    const unsubscribe = options.manager.subscribe(runId, (event) => {
      raw.write(formatSseEvent(event));
      if (isTerminalEvent(event.event)) {
        raw.end();
      }
    });
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

function getRunId(request: FastifyRequest): string {
  const params = request.params as { runId?: string };
  return params.runId?.trim() || "";
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
    return token || null;
  }
  return null;
}

function validateBody<T>(body: unknown, schema: z.ZodSchema<T>): ValidationResult<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    return {
      success: false,
      error: result.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "root";
        return `${path}: ${issue.message}`;
      }).join("; "),
    };
  }
  return { success: true, data: result.data };
}

function handleMutationError(reply: FastifyReply, error: unknown): FastifyReply {
  const message = error instanceof Error ? error.message : "Codex agent request failed.";
  const statusCode = message.startsWith("Unknown codex agent run:") ? 404 : 400;
  return reply.status(statusCode).send({ error: message });
}

function formatSseEvent(event: { event: string } & Record<string, unknown>): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
}

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "input_required";
}

function isTerminalEvent(event: string): boolean {
  return event === "turn_completed" || event === "turn_failed" || event === "turn_cancelled" || event === "turn_input_required";
}
