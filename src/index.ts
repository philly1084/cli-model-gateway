import { loadAppConfig, loadProvidersFile, loadRemoteCliTargetsFile } from "./config";
import { ProviderRegistry } from "./providers/registry";
import { buildServer } from "./server";

async function main(): Promise<void> {
  const config = loadAppConfig();
  const providersFile = loadProvidersFile(config.providersPath);
  const remoteCliTargets = config.remoteCliTargetsPath
    ? loadRemoteCliTargetsFile(config.remoteCliTargetsPath) ?? providersFile.remoteCliTargets
    : providersFile.remoteCliTargets;
  const registry = await ProviderRegistry.create(providersFile.providers);
  const { app, close } = buildServer(config, registry, {
    remoteCliTargets,
  });

  // Track active connections for graceful shutdown
  let isShuttingDown = false;
  let autoRouterBenchmarkTimer: NodeJS.Timeout | undefined;

  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) {
      app.log.warn(`Received ${signal} while already shutting down, forcing exit...`);
      process.exit(1);
    }

    isShuttingDown = true;
    app.log.info(`Received ${signal}, starting graceful shutdown...`);

    // Set a hard timeout to force exit
    const forceExitTimeout = setTimeout(() => {
      app.log.error(`Graceful shutdown timed out after ${config.shutdownTimeoutMs}ms, forcing exit.`);
      process.exit(1);
    }, config.shutdownTimeoutMs);

    try {
      if (autoRouterBenchmarkTimer) {
        clearInterval(autoRouterBenchmarkTimer);
        autoRouterBenchmarkTimer = undefined;
      }
      await close();
      clearTimeout(forceExitTimeout);
      app.log.info("Server closed successfully.");
      process.exit(0);
    } catch (error) {
      clearTimeout(forceExitTimeout);
      app.log.error(error, "Error during graceful shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

  await app.listen({
    host: config.host,
    port: config.port,
  });

  app.log.info(
    {
      host: config.host,
      port: config.port,
      providersPath: config.providersPath,
      remoteCliTargetsPath: config.remoteCliTargetsPath,
      models: registry.listModels().map((item) => item.id),
      rateLimitMax: config.rateLimitMax,
      rateLimitWindowMs: config.rateLimitWindowMs,
      maxRequestBodySize: config.maxRequestBodySize,
      frontendApiKeysConfigured: config.frontendApiKeys.size,
      frontendAllowedCwds: config.frontendAllowedCwds,
      remoteCliTargetsConfigured: remoteCliTargets?.length ?? 0,
      remoteCliToolAuthScopes: [...config.remoteCliToolAuthScopes],
      shutdownTimeoutMs: config.shutdownTimeoutMs,
      requestTimeoutMs: config.requestTimeoutMs,
      defaultReasoningEffort: config.defaultReasoningEffort,
      autoRouterBenchmarkOnStart: config.autoRouterBenchmarkOnStart,
      autoRouterBenchmarkTimeoutMs: config.autoRouterBenchmarkTimeoutMs,
      autoRouterBenchmarkMaxModels: config.autoRouterBenchmarkMaxModels,
      autoRouterBenchmarkConcurrency: config.autoRouterBenchmarkConcurrency,
      autoRouterBenchmarkIntervalMs: config.autoRouterBenchmarkIntervalMs,
      autoRouterBenchmarkEvaluateQuality: config.autoRouterBenchmarkEvaluateQuality,
      autoRouterBenchmarkEvaluatorModel: config.autoRouterBenchmarkEvaluatorModel,
      autoRouterBenchmarkQualityTimeoutMs: config.autoRouterBenchmarkQualityTimeoutMs,
    },
    "gateway listening",
  );

  const runAutoRouterBaseline = (reason: "startup" | "scheduled") => {
    void registry.runStartupBenchmarks({
      timeoutMs: config.autoRouterBenchmarkTimeoutMs,
      maxModels: config.autoRouterBenchmarkMaxModels,
      concurrency: config.autoRouterBenchmarkConcurrency,
      evaluateQuality: config.autoRouterBenchmarkEvaluateQuality,
      evaluatorModelId: config.autoRouterBenchmarkEvaluatorModel,
      qualityTimeoutMs: config.autoRouterBenchmarkQualityTimeoutMs,
      logger: app.log,
    }).then((benchmarks) => {
      app.log.info(
        {
          completed: benchmarks.filter((item) => item.status === "succeeded").length,
          failed: benchmarks.filter((item) => item.status === "failed").length,
          total: benchmarks.length,
          reason,
        },
        "Auto router capacity baseline finished.",
      );
    }).catch((error) => {
      app.log.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          reason,
        },
        "Auto router capacity baseline did not complete.",
      );
    });
  };

  if (config.autoRouterBenchmarkOnStart) {
    runAutoRouterBaseline("startup");
  }

  if (config.autoRouterBenchmarkIntervalMs > 0) {
    autoRouterBenchmarkTimer = setInterval(
      () => runAutoRouterBaseline("scheduled"),
      config.autoRouterBenchmarkIntervalMs,
    );
    autoRouterBenchmarkTimer.unref();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
