import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { EmbeddingsConfig } from "../types.js";

const inputSchema = z.string().min(1).max(8192).refine(value => value.trim().length > 0);
const requestSchema = z.object({
  model: z.string().min(1),
  input: z.union([inputSchema, z.array(inputSchema).min(1).max(256)]),
  encoding_format: z.literal("float").optional(),
  dimensions: z.number().int().positive().optional(),
});

function error(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { message, type: "invalid_request_error", code } });
}

export function registerEmbeddingsRoutes(
  app: FastifyInstance,
  config?: EmbeddingsConfig,
  fetchUpstream: typeof fetch = fetch,
): void {
  app.get("/embeddings/models", async (_request, reply) => {
    if (!config) return error(reply, 404, "embeddings_not_configured", "Embeddings are not configured.");
    return { object: "list", data: config.models.map(model => ({
      id: model.id, object: "model", type: "embedding", dimensions: model.dimensions,
    })) };
  });

  app.post("/embeddings", {
    bodyLimit: 512 * 1024,
    errorHandler: (cause, _request, reply) => {
      const status = cause.statusCode === 413 ? 413 : cause.statusCode === 400 ? 400 : 500;
      return error(reply, status, "invalid_request_error",
        status === 413 ? "Request body too large." : status === 400 ? "Invalid embeddings request body." : "Embeddings request failed.");
    },
  }, async (request, reply) => {
    if (!config) return error(reply, 404, "embeddings_not_configured", "Embeddings are not configured.");
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return error(reply, 400, "invalid_request_error", "Invalid embeddings request: provide a model, 1-256 non-empty strings of at most 8192 characters, and float encoding.");
    const body = parsed.data;
    const model = config.models.find(entry => entry.id === body.model || entry.aliases.includes(body.model));
    if (!model) return error(reply, 400, "model_not_found", "Model is not a configured embedding model.");
    if (body.dimensions !== undefined && body.dimensions !== model.dimensions) {
      return error(reply, 400, "invalid_request_error", "Dimensions must equal the embedding model's native dimensions.");
    }
    const inputs = typeof body.input === "string" ? [body.input] : body.input;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
    const disconnect = () => { if (!reply.raw.writableFinished) controller.abort(); };
    reply.raw.once("close", disconnect);
    if (reply.raw.destroyed) disconnect();
    const started = Date.now();
    try {
      const response = await fetchUpstream(`${config.upstreamUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: model.upstreamModel, input: body.input }),
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        return error(reply, 502, "upstream_error", "Embeddings upstream returned an unsuccessful status.");
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (controller.signal.aborted) throw new Error();
        return error(reply, 502, "upstream_invalid_response", "Invalid embeddings upstream response.");
      }
      const result = z.object({
        data: z.array(z.object({
          embedding: z.array(z.number().finite()).length(model.dimensions),
        })).length(inputs.length),
        usage: z.object({
          prompt_tokens: z.number().int().nonnegative(),
          total_tokens: z.number().int().nonnegative(),
        }).optional(),
      }).safeParse(payload);
      if (!result.success) return error(reply, 502, "upstream_invalid_response", "Invalid embeddings upstream response.");
      const estimate = Math.ceil(inputs.reduce((sum, input) => sum + input.length, 0) / 4);
      return {
        object: "list",
        data: result.data.data.map((item, index) => ({ object: "embedding", index, embedding: item.embedding })),
        model: model.id,
        usage: result.data.usage ?? { prompt_tokens: estimate, total_tokens: estimate },
      };
    } catch {
      return error(reply, timedOut ? 504 : 502, timedOut ? "upstream_timeout" : "upstream_error",
        timedOut ? "Embeddings upstream timed out." : "Embeddings upstream request failed.");
    } finally {
      clearTimeout(timer);
      reply.raw.off("close", disconnect);
      request.log.info({ model: model.id, inputCount: inputs.length, dimensions: model.dimensions,
        latencyMs: Date.now() - started, status: reply.statusCode }, "Embeddings request");
    }
  });
}
