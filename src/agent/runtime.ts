import type { ProviderRegistry } from "../providers/registry.js";
import { SopsKeyProvider, Sealer, sha256 } from "./crypto/sealed.js";
import { SealedLog } from "./store/sealed-log.js";
import { NativeRouterClient } from "./router/router-client.js";
import { LeaseManager } from "./pool/leases.js";
import { WorkerPool } from "./pool/worker-pool.js";
import { InProcessRunner } from "./pool/runners.js";
import { DelegateTool, startSchema } from "./delegate/delegate-tool.js";
import { RollingSummarizer } from "./context/handoff.js";
import { ApprovalInbox } from "./approvals/inbox.js";
import { InboxNotifier } from "./notify/notifier.js";
import { AgentMemory } from "./memory/index.js";
import { Coordinator } from "./coordinator/coordinator.js";
import type { AgentConfig } from "./config.js";
import { ProcessCheckerClient } from "./checker/client.js";
export async function createAgentRuntime(
  config: AgentConfig,
  registry: ProviderRegistry,
) {
  if (!config.keysSopsFile || !config.checkerKeySopsFile)
    throw Error("Agent SOPS key files are required");
  const keys = await SopsKeyProvider.load(
      config.keysSopsFile,
      config.checkerKeySopsFile,
    ),
    sealer = new Sealer(keys),
    log = new SealedLog(config.dataDir, sealer);
  const router = new NativeRouterClient(registry),
    inbox = new ApprovalInbox(log, config.approvalTtlMs),
    notifier = new InboxNotifier(log),
    memory = new AgentMemory(log);
  // Phase 1 is a model-only skeleton. No shell, container, MCP or external effects.
  const runner = new InProcessRunner(async (job, signal) => {
    const spec = startSchema.parse(job.payload);
    signal.throwIfAborted();
    const result = await router.decide({
      kind: "chat",
      requestId: job.jobId,
      messages: [{ role: "user", content: spec.goal }],
      budget: spec.budget,
      signal,
    });
    signal.throwIfAborted();
    return { text: result.outputText, receipt: result.receipt };
  });
  let delegate: DelegateTool | undefined;
  let coordinator: Coordinator | undefined;
  const pending = new Set<Promise<unknown>>();
  const pool = new WorkerPool(
    new LeaseManager(),
    runner,
    config.poolMax,
    config.poolMax,
    3000,
    (event) => {
      delegate?.onPoolEvent(event);
      if (
        event.failure === "secret_detected" ||
        event.state === "reconciliation_required"
      ) {
        const item = inbox.request({
          kind:
            event.failure === "secret_detected"
              ? "secret_detected"
              : "reconciliation_required",
          jobId: event.jobId,
        });
        notifier.notify({ itemId: item.id, kind: "review" });
      }
      if (event.state === "awaiting_check") {
        const parentJobId = startSchema.parse(event.payload).parentJobId;
        if (parentJobId) {
          const content = JSON.stringify(event.result);
          // Dispatch after the parent's claim has settled and its child id is recorded.
          const task = new Promise<void>((resolve) => setImmediate(resolve))
            .then(() =>
              coordinator?.checkChild(parentJobId, event.jobId, [
                { name: event.jobId, content, sha256: sha256(content) },
              ]),
            )
            .catch(() => {
              inbox.request({
                kind: "checker_unavailable",
                jobId: parentJobId,
              });
            });
          pending.add(task);
          void task.finally(() => pending.delete(task));
        }
      }
    },
  );
  delegate = new DelegateTool(pool, log, new RollingSummarizer(router, log));
  coordinator = new Coordinator(
    router,
    log,
    inbox,
    notifier,
    delegate,
    memory,
    keys.getMacKey(),
    new ProcessCheckerClient(keys),
  );
  return {
    coordinator,
    delegate,
    inbox,
    sealer,
    async close() {
      pool.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await Promise.allSettled([...pending]);
      log.close();
    },
  };
}
