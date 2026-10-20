import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ExecutionReceipt } from "./execution-policy.js";

interface StreamOutcome {
  requestedModel: string;
  selectedModel: string;
  bytesSent: number;
  stage: "before_first_token" | "mid_stream";
  errorType?: string;
}

const streams = new WeakMap<FastifyRequest, StreamOutcome>();

export function trackChatStream(reply: FastifyReply, requestedModel: string): void {
  const state: StreamOutcome = { requestedModel, selectedModel: requestedModel, bytesSent: 0, stage: "before_first_token" };
  streams.set(reply.request, state);
  const write = reply.raw.write.bind(reply.raw);
  reply.raw.write = ((...args: Parameters<typeof write>) => {
    const chunk = args[0];
    const encoding = typeof args[1] === "string" ? args[1] as BufferEncoding : undefined;
    const result = write(...args);
    state.bytesSent += typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
    return result;
  }) as typeof write;
}

export function markStreamToken(reply: FastifyReply): void {
  const state = streams.get(reply.request);
  if (state) state.stage = "mid_stream";
}

export function failChatStream(reply: FastifyReply, errorType = "upstream_stream_failed"): void {
  const state = streams.get(reply.request);
  if (state) state.errorType ??= errorType;
}

export function recordExecution(reply: FastifyReply, receipt: ExecutionReceipt): void {
  const state = streams.get(reply.request);
  if (!state) return;
  if (typeof receipt.model === "string") state.selectedModel = receipt.model;
  if (typeof receipt.selectedModel === "string") state.selectedModel = receipt.selectedModel;
  if (receipt.type === "gateway.execution.terminal" && receipt.status !== "succeeded") {
    failChatStream(reply, receipt.status === "failed" ? "upstream_stream_failed" : String(receipt.status));
  }
}

export function installRequestCompletionLogging(app: FastifyInstance): void {
  const started = new WeakMap<FastifyRequest, number>();
  const logged = new WeakSet<FastifyRequest>();
  const complete = (request: FastifyRequest, reply: FastifyReply) => {
    if (logged.has(request)) return;
    logged.add(request);
    const state = streams.get(request);
    const latencyMs = Date.now() - (started.get(request) ?? Date.now());
    const fields = {
      res: { statusCode: reply.raw.statusCode }, httpStatus: reply.raw.statusCode,
      responseTime: latencyMs, latencyMs, ...state,
      ...(state ? { outcome: state.errorType ? "stream_failed" : "ok" } : {}),
    };
    if (state?.errorType) request.log.error(fields, "request completed");
    else request.log.info(fields, "request completed");
  };
  app.addHook("onRequest", async (request, reply) => {
    started.set(request, Date.now());
    request.log.info({ req: request }, "incoming request");
    let finished = false;
    reply.raw.prependOnceListener("finish", () => { finished = true; });
    reply.raw.prependOnceListener("error", () => failChatStream(reply, "transport_error"));
    reply.raw.once("close", () => {
      if (!finished) failChatStream(reply, "cancelled");
      complete(request, reply);
    });
  });
  app.addHook("onResponse", async (request, reply) => complete(request, reply));
}
