import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ExecutionReceipt } from "./execution-policy.js";
import { ProviderFailure, safeFinishReason } from "./provider-failure.js";
import { UpstreamError } from "./upstream-error.js";
import { RequestCapabilityError } from "./request-capability.js";
import { ToolContractError } from "./tool-contract.js";

interface StreamOutcome {
  requestedModel: string;
  selectedModel: string;
  bytesSent: number;
  stage: "before_first_token" | "mid_stream";
  errorType?: string;
}

const streams = new WeakMap<FastifyRequest, StreamOutcome>();
const failures = new WeakMap<FastifyRequest, Record<string, unknown>>();
const routes = new WeakMap<FastifyRequest, Record<string, string>>();
const identifier = (value: unknown) => typeof value === "string" && /^[\w./:-]{1,128}$/.test(value) ? value : "unknown";

export function recordProviderFailure(reply: FastifyReply, error: unknown): void {
  const fields = error instanceof ProviderFailure ? { errorClass: error.name, code: error.code,
    finish_reason: error.finishReason, prompt_tokens: error.promptTokens, completion_tokens: error.completionTokens }
    : error instanceof UpstreamError ? { errorClass: "UpstreamError", code: error.code }
    : error instanceof RequestCapabilityError ? { errorClass: "RequestCapabilityError", code: "model_capability_mismatch" }
    : error instanceof ToolContractError ? { errorClass: "ToolContractError", code: "provider_tool_contract_invalid" }
    : { errorClass: "ProviderError", code: "provider_error" };
  failures.set(reply.request, fields);
}

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
  if (state && (!state.errorType || (state.errorType === "upstream_stream_failed" && errorType === "provider_tool_contract_invalid"))) state.errorType = errorType;
}

export function recordExecution(reply: FastifyReply, receipt: ExecutionReceipt): void {
  if (receipt.type === "gateway.execution.attempt") routes.set(reply.request, {
    operationId: identifier(receipt.operationId), provider: identifier(receipt.providerId), model: identifier(receipt.model),
  });
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
    if (reply.raw.statusCode >= 400 || state?.errorType || failures.has(request)) {
      const body = request.body as { model?: unknown; gateway_policy?: { operationId?: unknown } } | undefined;
      request.log.error({ ...fields, type: "gateway.request.failure/v1", reqId: identifier(request.id),
        operationId: identifier(body?.gateway_policy?.operationId), provider: "unknown", model: identifier(body?.model),
        ...routes.get(request), finish_reason: safeFinishReason(undefined),
        errorClass: "RequestError", code: "unknown", ...failures.get(request),
        httpStatus: reply.raw.statusCode, latencyMs }, "request completed");
    } else request.log.info(fields, "request completed");
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
