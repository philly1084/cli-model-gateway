import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { JobManager } from "../jobs/job-manager";
import type { ProviderRegistry } from "../providers/registry";
import type { ChatMessage, ReasoningEffort, UnifiedToolDefinition } from "../types";
import { getCliExecManager } from "../jobs/cli-exec-manager";

interface AdminRoutesOptions {
  registry: ProviderRegistry;
  jobManager: JobManager;
  adminApiKey: string;
}

export const adminRoutes: FastifyPluginAsync<AdminRoutesOptions> = async (app, options) => {
  app.addHook("preHandler", async (request, reply) => {
    if (!isAdminAuthorized(request, options.adminApiKey)) {
      reply.status(401).send({
        error: "Unauthorized",
      });
      return reply;
    }
  });

  app.get("/providers", async (request) => {
    const query = request.query as Record<string, unknown>;
    const checkAuth = query.check === "true" || query.check === true;

    const data = await Promise.all(
      options.registry.listProviders().map(async (provider) => {
        const statusConfigured =
          provider.config.type === "cli" ? Boolean(provider.config.auth?.statusCommand) : true;
        const loginConfigured =
          provider.config.type === "cli" ? Boolean(provider.config.auth?.loginCommand) : false;
        const rateLimitConfigured =
          provider.config.type === "cli" ? Boolean(provider.config.auth?.rateLimitCommand) : false;

        let authStatus:
          | {
            ok: boolean;
            exitCode: number | null;
            stdout: string;
            stderr: string;
          }
          | undefined;

        if (checkAuth && statusConfigured) {
          authStatus = await provider.checkAuthStatus();
        }

        return {
          id: provider.id,
          description: provider.description,
          models: provider.models,
          auth: {
            loginConfigured,
            statusConfigured,
            rateLimitConfigured,
            status: authStatus,
          },
        };
      }),
    );

    return { data };
  });

  app.post("/providers/:providerId/login", async (request, reply) => {
    const params = request.params as { providerId?: string };
    const providerId = params.providerId?.trim() || "";
    const provider = options.registry.getProvider(providerId);
    if (!provider) {
      return reply.status(404).send({
        error: `Unknown provider: ${providerId}`,
      });
    }

    try {
      const job = await provider.startLoginJob(options.jobManager);
      return {
        job,
        message:
          "Login command started. Poll /admin/jobs/{id} to capture URL/code output over SSH.",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start login job.";
      return reply.status(400).send({ error: message });
    }
  });

  app.post("/providers/:providerId/status", async (request, reply) => {
    const params = request.params as { providerId?: string };
    const providerId = params.providerId?.trim() || "";
    const provider = options.registry.getProvider(providerId);
    if (!provider) {
      return reply.status(404).send({
        error: `Unknown provider: ${providerId}`,
      });
    }

    const status = await provider.checkAuthStatus();
    return {
      providerId,
      status,
    };
  });

  app.get("/jobs", async (request) => {
    const query = request.query as Record<string, unknown>;
    const limitRaw = typeof query.limit === "string" ? Number(query.limit) : 50;
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 50;
    return {
      data: options.jobManager.listJobs(Math.min(limit, 200)),
    };
  });

  app.get("/jobs/:jobId", async (request, reply) => {
    const params = request.params as { jobId?: string };
    const jobId = params.jobId?.trim() || "";
    const job = options.jobManager.getJob(jobId);
    if (!job) {
      return reply.status(404).send({
        error: `Unknown job: ${jobId}`,
      });
    }
    return job;
  });

  app.get("/stats/models", async () => {
    return options.registry.getModelStats();
  });

  app.get("/stats/models/:modelId", async (request, reply) => {
    const params = request.params as { modelId?: string };
    const modelId = params.modelId?.trim() || "";
    const snapshot = options.registry.getModelStatsById(modelId);
    if (!snapshot) {
      return reply.status(404).send({
        error: `Unknown model: ${modelId}`,
      });
    }
    return snapshot;
  });

  app.get("/stats/auto-router", async () => {
    return {
      generatedAt: new Date().toISOString(),
      benchmarks: options.registry.getAutoRouterBenchmarks(),
    };
  });

  app.post("/stats/auto-router/baseline", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const timeoutMs = readPositiveInteger(body.timeoutMs, 20_000);
    const maxModels = readNonNegativeInteger(body.maxModels, 16);
    const concurrency = readPositiveInteger(body.concurrency, 2);
    const evaluateQuality = readBoolean(body.evaluateQuality, true);
    const evaluatorModelId =
      typeof body.evaluatorModelId === "string" && body.evaluatorModelId.trim()
        ? body.evaluatorModelId.trim()
        : undefined;
    const qualityTimeoutMs = readPositiveInteger(body.qualityTimeoutMs, 15_000);

    try {
      const benchmarks = await options.registry.runStartupBenchmarks({
        timeoutMs,
        maxModels,
        concurrency,
        evaluateQuality,
        evaluatorModelId,
        qualityTimeoutMs,
        logger: app.log,
      });
      return {
        generatedAt: new Date().toISOString(),
        options: {
          timeoutMs,
          maxModels,
          concurrency,
          evaluateQuality,
          evaluatorModelId,
          qualityTimeoutMs,
        },
        summary: {
          succeeded: benchmarks.filter((item) => item.status === "succeeded").length,
          failed: benchmarks.filter((item) => item.status === "failed").length,
          total: benchmarks.length,
        },
        benchmarks,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: message });
    }
  });

  app.post("/stats/auto-router/explain", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const messages = normalizeExplainMessages(body.messages);
    if (messages.length === 0) {
      return reply.status(400).send({
        error: "messages must include at least one item.",
      });
    }

    try {
      return {
        generatedAt: new Date().toISOString(),
        decision: options.registry.explainAutoRouting({
          messages,
          tools: normalizeExplainTools(body.tools),
          stream: typeof body.stream === "boolean" ? body.stream : undefined,
          requestKind: typeof body.requestKind === "string" ? body.requestKind : "chat_completions",
          reasoningEffort: normalizeReasoningEffort(body.reasoningEffort),
          metadata: body.metadata && typeof body.metadata === "object"
            ? body.metadata as Record<string, unknown>
            : body,
        }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: message });
    }
  });

  // Rate limits endpoints
  app.get("/rate-limits", async () => {
    const providers = options.registry.listProviders();
    const results = await Promise.all(
      providers.map(async (provider) => {
        try {
          return await provider.checkRateLimits();
        } catch (error) {
          return {
            providerId: provider.id,
            providerDescription: provider.description,
            status: "unknown" as const,
            limits: [{
              providerId: provider.id,
              limitType: "unknown" as const,
              checkedAt: new Date().toISOString(),
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }],
            lastCheckedAt: new Date().toISOString(),
          };
        }
      })
    );

    return {
      data: results,
      summary: {
        total: results.length,
        healthy: results.filter(r => r.status === "healthy").length,
        degraded: results.filter(r => r.status === "degraded").length,
        rateLimited: results.filter(r => r.status === "rate_limited").length,
        authErrors: results.filter(r => r.status === "auth_error").length,
        unknown: results.filter(r => r.status === "unknown").length,
      },
    };
  });

  app.get("/rate-limits/:providerId", async (request, reply) => {
    const params = request.params as { providerId?: string };
    const providerId = params.providerId?.trim() || "";
    const provider = options.registry.getProvider(providerId);
    if (!provider) {
      return reply.status(404).send({
        error: `Unknown provider: ${providerId}`,
      });
    }

    try {
      const limits = await provider.checkRateLimits();
      return limits;
    } catch (error) {
      return reply.status(500).send({
        error: `Failed to check rate limits: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  // CLI Execution endpoints for software development workflows
  const cliExecManager = getCliExecManager();

  // Execute arbitrary CLI command
  app.post("/cli/exec", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    if (!body) {
      return reply.status(400).send({ error: "Request body is required" });
    }

    const command = typeof body.command === "string" ? body.command : "";
    const args = Array.isArray(body.args) ? body.args.filter((a): a is string => typeof a === "string") : [];
    const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
    const env = typeof body.env === "object" && body.env !== null
      ? Object.fromEntries(Object.entries(body.env).filter(([, v]) => typeof v === "string"))
      : undefined;
    const timeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : undefined;

    if (!command) {
      return reply.status(400).send({ error: "command is required" });
    }

    try {
      const job = await cliExecManager.execute(command, args, { cwd, env, timeoutMs });
      return {
        job,
        message: "Command execution started. Poll /admin/cli/jobs/{id} for results.",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start command";
      return reply.status(400).send({ error: message });
    }
  });

  // Git clone helper
  app.post("/cli/git/clone", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    if (!body) {
      return reply.status(400).send({ error: "Request body is required" });
    }

    const repo = typeof body.repo === "string" ? body.repo : "";
    const dir = typeof body.dir === "string" ? body.dir : undefined;
    const branch = typeof body.branch === "string" ? body.branch : undefined;
    const cwd = typeof body.cwd === "string" ? body.cwd : undefined;

    if (!repo) {
      return reply.status(400).send({ error: "repo is required" });
    }

    const args = ["clone", repo];
    if (branch) {
      args.push("--branch", branch);
    }
    if (dir) {
      args.push(dir);
    }

    try {
      const job = await cliExecManager.execute("git", args, { cwd });
      return {
        job,
        message: `Git clone started for ${repo}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start git clone";
      return reply.status(400).send({ error: message });
    }
  });

  // Git commit helper
  app.post("/cli/git/commit", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    if (!body) {
      return reply.status(400).send({ error: "Request body is required" });
    }

    const message = typeof body.message === "string" ? body.message : "";
    const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
    const add = body.add === true;

    if (!message) {
      return reply.status(400).send({ error: "message is required" });
    }

    try {
      // First add if requested
      if (add) {
        await cliExecManager.execute("git", ["add", "."], { cwd });
      }

      const job = await cliExecManager.execute("git", ["commit", "-m", message], { cwd });
      return {
        job,
        message: "Git commit started",
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Failed to start git commit";
      return reply.status(400).send({ error: errMsg });
    }
  });

  // Git push helper
  app.post("/cli/git/push", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;

    const remote = typeof body?.remote === "string" ? body.remote : "origin";
    const branch = typeof body?.branch === "string" ? body.branch : undefined;
    const cwd = typeof body?.cwd === "string" ? body.cwd : undefined;

    const args = ["push", remote];
    if (branch) {
      args.push(branch);
    }

    try {
      const job = await cliExecManager.execute("git", args, { cwd });
      return {
        job,
        message: `Git push started to ${remote}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start git push";
      return reply.status(400).send({ error: message });
    }
  });

  // Docker build helper
  app.post("/cli/docker/build", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    if (!body) {
      return reply.status(400).send({ error: "Request body is required" });
    }

    const tag = typeof body.tag === "string" ? body.tag : "";
    const context = typeof body.context === "string" ? body.context : ".";
    const dockerfile = typeof body.dockerfile === "string" ? body.dockerfile : undefined;
    const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
    const push = body.push === true;

    if (!tag) {
      return reply.status(400).send({ error: "tag is required" });
    }

    const args = ["build", "-t", tag];
    if (dockerfile) {
      args.push("-f", dockerfile);
    }
    args.push(context);

    try {
      const buildJob = await cliExecManager.execute("docker", args, { cwd });

      if (push) {
        // Wait for build to complete before pushing
        const pushAfterBuild = async () => {
          // Poll until build completes
          const pollIntervalMs = 2000;
          const maxWaitMs = 600000; // 10 minutes
          const startedAt = Date.now();
          while (Date.now() - startedAt < maxWaitMs) {
            const current = cliExecManager.getJob(buildJob.id);
            if (!current || current.status !== "running") break;
            await new Promise(r => setTimeout(r, pollIntervalMs));
          }
          const finalBuild = cliExecManager.getJob(buildJob.id);
          if (finalBuild?.status === "completed") {
            await cliExecManager.execute("docker", ["push", tag], { cwd });
          }
        };
        // Fire and forget the push-after-build — client can poll cli/jobs
        pushAfterBuild().catch(() => { /* errors visible via job status */ });
      }

      return {
        job: buildJob,
        message: `Docker build started for ${tag}${push ? " (push will follow after build completes)" : ""}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start docker build";
      return reply.status(400).send({ error: message });
    }
  });

  // Kubectl apply helper
  app.post("/cli/kubectl/apply", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    if (!body) {
      return reply.status(400).send({ error: "Request body is required" });
    }

    const file = typeof body.file === "string" ? body.file : undefined;
    const dir = typeof body.dir === "string" ? body.dir : undefined;
    const namespace = typeof body.namespace === "string" ? body.namespace : undefined;

    if (!file && !dir) {
      return reply.status(400).send({ error: "file or dir is required" });
    }

    const args = ["apply"];
    if (namespace) {
      args.push("-n", namespace);
    }
    if (file) {
      args.push("-f", file);
    } else if (dir) {
      args.push("-f", dir);
    }

    try {
      const job = await cliExecManager.execute("kubectl", args);
      return {
        job,
        message: "Kubectl apply started",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start kubectl apply";
      return reply.status(400).send({ error: message });
    }
  });

  // Get CLI job status
  app.get("/cli/jobs", async (request) => {
    const query = request.query as Record<string, unknown>;
    const limitRaw = typeof query.limit === "string" ? Number(query.limit) : 50;
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 50;
    return {
      data: cliExecManager.listJobs(Math.min(limit, 200)),
    };
  });

  app.get("/cli/jobs/:jobId", async (request, reply) => {
    const params = request.params as { jobId?: string };
    const jobId = params.jobId?.trim() || "";
    const job = cliExecManager.getJob(jobId);
    if (!job) {
      return reply.status(404).send({
        error: `Unknown job: ${jobId}`,
      });
    }
    return job;
  });
};

function isAdminAuthorized(request: FastifyRequest, adminApiKey: string): boolean {
  const xAdmin = request.headers["x-admin-key"];
  if (typeof xAdmin === "string" && xAdmin === adminApiKey) {
    return true;
  }

  const authorization = request.headers.authorization;
  if (authorization && authorization.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice("bearer ".length).trim();
    if (token === adminApiKey) {
      return true;
    }
  }

  return false;
}

function normalizeExplainMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item): ChatMessage[] => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const role = record.role;
    const content = record.content;
    if (
      (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") ||
      typeof content !== "string"
    ) {
      return [];
    }
    return [{ role, content }];
  });
}

function normalizeExplainTools(value: unknown): UnifiedToolDefinition[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item): UnifiedToolDefinition[] => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const functionRecord =
      record.function && typeof record.function === "object"
        ? record.function as Record<string, unknown>
        : undefined;
    const name = typeof functionRecord?.name === "string" ? functionRecord.name.trim() : "";
    if (!name) {
      return [];
    }
    return [{
      type: "function",
      function: {
        name,
        description: typeof functionRecord?.description === "string"
          ? functionRecord.description
          : undefined,
        parameters: functionRecord?.parameters,
      },
    }];
  });
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
    ? value
    : undefined;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
