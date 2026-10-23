import { gatewayError } from "./utils/output-normalization.js";
import Fastify from "fastify";
import { loadAgentConfig } from "./agent/config.js";
import { createAgentRuntime } from "./agent/runtime.js";
import { agentRoutes } from "./agent/routes/agent.js";
import { agentUiRoutes } from "./agent/routes/ui.js";
import type { AppConfig, RemoteCliTargetConfig } from "./types";
import { adminRoutes } from "./routes/admin";
import { openAiRoutes } from "./routes/openai";
import { providerSessionRoutes } from "./routes/provider-sessions";
import { remoteAgentRoutes } from "./routes/remote-agents";
import { codexAgentRoutes } from "./routes/codex-agent";
import { mcpRoutes } from "./routes/mcp";
import { JobManager } from "./jobs/job-manager";
import { ProviderSessionManager } from "./jobs/provider-session-manager";
import { RemoteAgentManager } from "./jobs/remote-agent-manager";
import { CodexAgentManager } from "./jobs/codex-agent-manager";
import { RemoteCliToolManager } from "./jobs/remote-cli-tool-manager";
import { REMOTE_AGENT_HANDOFF_VERSION } from "./jobs/agent-handoff-store";
import { ProviderRegistry } from "./providers/registry";
import { LruMap } from "./utils/lru-map";
import { makeId } from "./utils/ids";
import { installRequestCompletionLogging } from "./utils/request-completion.js";
import { metrics, trackRequest } from "./metrics";

// Rate limit configuration constants
const RATE_LIMIT_STORE_MAX_SIZE = 10000;
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60000;

// LRU-based rate limit store to prevent memory leaks
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

function getRateLimitKey(request: { headers: Record<string, unknown> }): string {
  // Use API key as the rate limit identifier
  const xApiKey = request.headers["x-api-key"];
  const xApiKeyValue = Array.isArray(xApiKey) ? xApiKey[0] : xApiKey;
  if (typeof xApiKeyValue === "string") {
    return xApiKeyValue.trim();
  }

  const auth = request.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }

  // Fallback to IP (not available in all environments, but good enough)
  return "anonymous";
}

function checkRateLimit(
  store: LruMap<string, RateLimitEntry>,
  key: string,
  max: number,
  windowMs: number,
): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now > entry.resetTime) {
    // New window
    store.set(key, {
      count: 1,
      resetTime: now + windowMs,
    });
    return { allowed: true };
  }

  if (entry.count >= max) {
    // Rate limit exceeded
    return {
      allowed: false,
      retryAfter: Math.ceil((entry.resetTime - now) / 1000),
    };
  }

  // Increment count
  entry.count++;
  return { allowed: true };
}

export function buildServer(
  config: AppConfig,
  registry: ProviderRegistry,
  options: {
    remoteCliTargets?: RemoteCliTargetConfig[];
    agentRuntimeFactory?: typeof createAgentRuntime;
    embeddingsFetch?: typeof fetch;
  } = {},
) {
  if (config.embeddings) {
    const chatModelIds = new Set(registry.listModels().map(model => model.id));
    if (config.embeddings.models.some(model => [model.id, ...model.aliases].some(id => chatModelIds.has(id)))) {
      throw new Error("Embedding ids and aliases must not overlap chat model ids.");
    }
  }
  const app = Fastify({
    disableRequestLogging: true,
    logger: {
      level: config.logLevel,
    },
    // Request body size limit
    bodyLimit: config.maxRequestBodySize,
    // Keep long-running CLI-backed requests open, especially image batches.
    connectionTimeout: config.requestTimeoutMs,
    keepAliveTimeout: config.requestTimeoutMs,
    requestTimeout: config.requestTimeoutMs,
  });

  installRequestCompletionLogging(app);

  const jobManager = new JobManager(config.maxJobLogLines);
  const providerSessionManager = new ProviderSessionManager({
    allowedCwds: config.frontendAllowedCwds,
  });
  const remoteCliToolManager = new RemoteCliToolManager(options.remoteCliTargets ?? []);
  const remoteAgentManager = new RemoteAgentManager(providerSessionManager, options.remoteCliTargets ?? []);
  const codexAgentManager = new CodexAgentManager({
    allowedWorkspaceRoots: config.codexAgentAllowedWorkspaceRoots,
  });

  // Rate limit store scoped to this server instance
  const rateLimitStore = new LruMap<string, RateLimitEntry>(RATE_LIMIT_STORE_MAX_SIZE);

  // Periodic cleanup of expired rate limit entries
  const rateLimitCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitStore.entries()) {
      if (now > entry.resetTime) {
        rateLimitStore.delete(key);
      }
    }
  }, RATE_LIMIT_CLEANUP_INTERVAL_MS);
  rateLimitCleanupInterval.unref();

  // Generate request ID for tracing
  app.addHook("onRequest", async (request, reply) => {
    const requestId = makeId("req");
    request.headers["x-request-id"] = requestId;
    reply.header("x-request-id", requestId);
    // Store start time for metrics
    (request as unknown as Record<string, number>).startTime = Date.now();
  });

  // Track request metrics
  app.addHook("onResponse", async (request, reply) => {
    const startTime = (request as unknown as Record<string, number>).startTime;
    if (startTime) {
      const duration = Date.now() - startTime;
      trackRequest(
        request.method,
        request.url,
        reply.statusCode,
        duration,
      );
    }
  });

  // Rate limiting hook for OpenAI routes
  app.addHook("preHandler", async (request, reply) => {
    // Only rate limit OpenAI routes (not admin routes or health)
    if (!request.url.startsWith("/v1/") && !request.url.startsWith("/openai/v1/")) {
      return;
    }

    const key = getRateLimitKey(request);
    const result = checkRateLimit(rateLimitStore, key, config.rateLimitMax, config.rateLimitWindowMs);

    if (!result.allowed) {
      reply.header("Retry-After", result.retryAfter?.toString() ?? "60");
      return reply.status(429).send(gatewayError("Rate limit exceeded. Please try again later.", "rate_limit_error", 429));
    }
  });

  app.get("/healthz", async (request) => ({
    ok: true,
    ts: new Date().toISOString(),
    requestId: request.headers["x-request-id"],
    contracts: {
      remoteAgentHandoff: REMOTE_AGENT_HANDOFF_VERSION,
    },
  }));

  // Prometheus metrics endpoint (admin only)
  app.get("/metrics", async (request, reply) => {
    // Check admin authorization
    const xAdmin = request.headers["x-admin-key"];
    const authorization = request.headers.authorization;
    const isAdmin =
      (typeof xAdmin === "string" && xAdmin === config.adminApiKey) ||
      (authorization && authorization.toLowerCase().startsWith("bearer ") &&
        authorization.slice("bearer ".length).trim() === config.adminApiKey);

    if (!isAdmin) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    reply.header("Content-Type", "text/plain");
    return metrics.export();
  });

  app.register(openAiRoutes, {
    prefix: "/v1",
    registry,
    n8nApiKeys: config.n8nApiKeys,
    defaultReasoningEffort: config.defaultReasoningEffort,
    embeddings: config.embeddings,
    embeddingsFetch: options.embeddingsFetch,
  });

  app.register(openAiRoutes, {
    prefix: "/openai/v1",
    registry,
    n8nApiKeys: config.n8nApiKeys,
    defaultReasoningEffort: config.defaultReasoningEffort,
    embeddings: config.embeddings,
    embeddingsFetch: options.embeddingsFetch,
  });

  app.register(adminRoutes, {
    prefix: "/admin",
    registry,
    jobManager,
    adminApiKey: config.adminApiKey,
  });

  if (process.env.AGENT_ENABLED === "true") {
    app.register(async agentApp => {
      const factory = options.agentRuntimeFactory ?? createAgentRuntime;
      const runtime = await factory(loadAgentConfig(), registry);
      agentApp.addHook("onClose", async () => runtime.close());
      await agentApp.register(agentRoutes, {
        prefix: "/admin/agent",
        adminApiKey: config.adminApiKey,
        ...runtime,
      });
      await agentApp.register(agentUiRoutes, {
        prefix: "/admin/agent/ui",
        adminApiKey: config.adminApiKey,
        ...runtime,
      });
    });
  }

  app.register(providerSessionRoutes, {
    prefix: "/admin",
    registry,
    sessionManager: providerSessionManager,
    adminApiKey: config.adminApiKey,
    frontendApiKeys: config.frontendApiKeys,
  });

  app.register(remoteAgentRoutes, {
    prefix: "/admin",
    registry,
    manager: remoteAgentManager,
    adminApiKey: config.adminApiKey,
    frontendApiKeys: config.frontendApiKeys,
  });

  app.register(codexAgentRoutes, {
    prefix: "/api/codex-agent",
    manager: codexAgentManager,
    adminApiKey: config.adminApiKey,
    frontendApiKeys: config.frontendApiKeys,
  });

  app.register(mcpRoutes, {
    manager: remoteCliToolManager,
    adminApiKey: config.adminApiKey,
    frontendApiKeys: config.frontendApiKeys,
    n8nApiKeys: config.n8nApiKeys,
    authScopes: config.remoteCliToolAuthScopes,
  });

  app.setErrorHandler((error, request, reply) => {
    const requestId = request.headers["x-request-id"];
    request.log.error({ error, requestId }, "Request error");
    if (reply.sent) {
      return;
    }

    // Handle validation errors
    const statusCode = error && typeof error === "object" && "statusCode" in error
      ? (error as { statusCode?: number }).statusCode
      : undefined;
    if (statusCode === 413) {
      return reply.status(413).send(gatewayError("Request body too large.", "invalid_request_error", 413));
    }

    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send(gatewayError("Invalid request.", "invalid_request_error", statusCode));
    }
    reply.status(500).send(gatewayError("Internal server error.", "server_error", 500));
  });

  return {
    app,
    /**
     * Closes the server gracefully, waiting for existing connections to complete
     * up to the specified timeout.
     */
    async close(): Promise<void> {
      app.log.info("Starting graceful shutdown...");

      // Stop accepting new connections
      await app.close();

      // Clear the rate limit cleanup interval
      clearInterval(rateLimitCleanupInterval);
      await remoteAgentManager.close();
      await providerSessionManager.close();
      await remoteCliToolManager.close();
      await codexAgentManager.close();

      app.log.info("Graceful shutdown complete.");
    },
  };
}
