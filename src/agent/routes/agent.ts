import type { FastifyPluginAsync } from "fastify";
import type { Coordinator } from "../coordinator/coordinator.js";
import type { DelegateTool } from "../delegate/delegate-tool.js";
import type { ApprovalInbox } from "../approvals/inbox.js";
import type { Sealer } from "../crypto/sealed.js";
export interface AgentRoutesOptions {
  adminApiKey: string;
  coordinator: Coordinator;
  delegate: DelegateTool;
  inbox: ApprovalInbox;
  sealer: Sealer;
}
export const agentRoutes: FastifyPluginAsync<AgentRoutesOptions> = async (
  app,
  options,
) => {
  app.addHook("preHandler", async (request, reply) => {
    const key =
      request.headers["x-admin-key"] ??
      request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (key !== options.adminApiKey)
      return reply.code(401).send({ error: "Unauthorized" });
  });
  app.setErrorHandler((_error, _request, reply) => {
    if (!reply.sent)
      void reply.code(400).send({ error: "Agent request rejected" });
  });
  app.post("/submit", async (request) => {
    const input = options.sealer.open(request.body, "agent:submit");
    const job = await options.coordinator.submit(input);
    return { jobId: job.jobId, state: job.state };
  });
  app.get<{ Params: { id: string } }>(
    "/delegate/:id/status",
    async (request) => {
      const job = options.delegate.status({ jobId: request.params.id });
      return {
        jobId: job.jobId,
        state: job.state,
        lastEventSeq: job.lastEventSeq,
        failure: job.failure,
      };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/delegate/:id/stop",
    async (request) => {
      const job = options.delegate.stop({
        jobId: request.params.id,
        reason: "operator",
      });
      return { jobId: job.jobId, state: job.state };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/delegate/:id/summarize",
    async (request) => options.delegate.summarize({ jobId: request.params.id }),
  );
  app.get<{
    Params: { id: string };
    Querystring: { fromSeq?: string; toSeq?: string };
  }>("/delegate/:id/log", async (request) =>
    options.delegate.log({
      jobId: request.params.id,
      fromSeq: Number(request.query.fromSeq ?? 0),
      toSeq:
        request.query.toSeq === undefined
          ? undefined
          : Number(request.query.toSeq),
    }),
  );
  app.get("/inbox", async () => ({ items: options.inbox.list() }));
  app.post<{ Params: { id: string } }>(
    "/inbox/:id/approve",
    async (request) => {
      const item = options.inbox.approve(request.params.id);
      const action = item.action as { jobId?: string };
      if (action.jobId) await options.coordinator.advance(action.jobId);
      return { id: item.id, state: item.state };
    },
  );
  app.post<{ Params: { id: string } }>("/inbox/:id/deny", async (request) => {
    const item = options.inbox.deny(request.params.id);
    return { id: item.id, state: item.state };
  });
};
