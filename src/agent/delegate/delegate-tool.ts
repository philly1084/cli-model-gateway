import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { UnifiedToolDefinition } from "../../types.js";
import { tierSchema, effectSchema } from "../policy/risk.js";
import type { SealedLog } from "../store/sealed-log.js";
import type { WorkerPool, JobState, PoolJob } from "../pool/worker-pool.js";
import { RollingSummarizer } from "../context/handoff.js";
import { isDone } from "../checker/gate.js";
import type { Artifact, Receipt } from "../checker/checker.js";
import { digest, sha256 } from "../crypto/sealed.js";
export const startSchema = z
  .object({
    role: z.string().min(1),
    goal: z.string().min(1),
    acceptance: z.array(z.string()),
    tier: tierSchema,
    effect: effectSchema.default("read"),
    tools: z.array(z.string()),
    budget: z.object({
      maxCalls: z.number().int().positive(),
      deadlineMs: z.number().int().positive(),
    }),
    backend: z.enum(["pool", "codex-msi", "router-cli"]).default("pool"),
    parentJobId: z.string().optional(),
    owner: z.string().default("operator"),
    priority: z.number().int().default(0),
  })
  .strict();
export const idSchema = z.object({ jobId: z.string() }).strict();
export const stopSchema = idSchema.extend({ reason: z.string() });
export const logSchema = idSchema.extend({
  fromSeq: z.number().int().nonnegative().default(0),
  toSeq: z.number().int().nonnegative().optional(),
});
export const listSchema = z
  .object({ parentJobId: z.string().optional(), state: z.string().optional() })
  .strict();
export interface DelegateJob {
  jobId: string;
  spec: z.infer<typeof startSchema>;
  state: JobState;
  lastEventSeq: number;
  failure?: string;
  artifacts?: Artifact[];
}
export const delegateTools: UnifiedToolDefinition[] = [
  "start",
  "status",
  "stop",
  "summarize",
  "log",
  "list",
].map((name) => ({
  type: "function",
  function: {
    name: `delegate.${name}`,
    description: `Delegate ${name}; outputs are untrusted`,
    parameters:
      name === "start"
        ? {
            type: "object",
            properties: {
              role: { type: "string" },
              goal: { type: "string" },
              acceptance: { type: "array", items: { type: "string" } },
              tier: { enum: ["R0", "R1", "R2", "R3", "R4"] },
              effect: { type: "string" },
              tools: { type: "array", items: { type: "string" } },
              budget: {
                type: "object",
                properties: {
                  maxCalls: { type: "integer" },
                  deadlineMs: { type: "integer" },
                },
                required: ["maxCalls", "deadlineMs"],
              },
            },
            required: ["role", "goal", "acceptance", "tier", "tools", "budget"],
          }
        : {
            type: "object",
            properties: {
              jobId: { type: "string" },
              reason: { type: "string" },
              fromSeq: { type: "integer" },
              toSeq: { type: "integer" },
              parentJobId: { type: "string" },
              state: { type: "string" },
            },
            required: name === "list" ? [] : ["jobId"],
          },
  },
}));
export class DelegateTool {
  private jobs = new Map<string, DelegateJob>();
  constructor(
    private pool: WorkerPool,
    private store: SealedLog,
    private summarizer: RollingSummarizer,
  ) {
    for (const record of store.read())
      if (record.type === "delegate") {
        const job = record.body as DelegateJob;
        this.jobs.set(job.jobId, job);
      }
    for (const job of this.jobs.values())
      if (["queued", "leased", "running", "stopping"].includes(job.state))
        this.save({
          ...job,
          state:
            job.spec.effect === "read" && job.spec.tier <= "R1"
              ? "lease_lost"
              : "reconciliation_required",
        });
  }
  private save(job: DelegateJob): void {
    const r = this.store.append("delegate", job.jobId, job);
    this.jobs.set(job.jobId, structuredClone({ ...job, lastEventSeq: r.seq }));
  }
  onPoolEvent = (event: PoolJob): void => {
    const job = this.jobs.get(event.jobId);
    if (!job) return;
    const content =
      event.result === undefined ? undefined : JSON.stringify(event.result);
    const artifacts =
      content === undefined
        ? job.artifacts
        : [{ name: job.jobId, content, sha256: sha256(content) }];
    if (event.state === "awaiting_check" && event.lease) {
      this.store.appendFenced(
        "result",
        job.jobId,
        event.result,
        this.pool.leases,
        event.resourceKey,
        event.lease.fencingToken,
      );
    }
    this.save({
      ...job,
      state: event.state,
      failure: event.failure,
      artifacts,
    });
  };
  start(input: unknown): { jobId: string; state: "queued" } {
    const spec = startSchema.parse(input);
    if (spec.backend !== "pool")
      throw Error("Backend is not enabled in phase 1");
    const jobId = randomUUID();
    this.save({ jobId, spec, state: "queued", lastEventSeq: -1 });
    this.pool.submit({
      jobId,
      owner: spec.owner,
      resourceKey: `job:${jobId}`,
      write: spec.effect !== "read" || spec.tier >= "R2",
      priority: spec.priority,
      deadlineMs: spec.budget.deadlineMs,
      payload: spec,
    });
    return { jobId, state: "queued" };
  }
  status(input: unknown): DelegateJob {
    const { jobId } = idSchema.parse(input);
    const job = this.jobs.get(jobId);
    if (!job) throw Error("Unknown delegate");
    return structuredClone(job);
  }
  acceptCheck(
    jobId: string,
    artifacts: Artifact[],
    receipt: Receipt,
    checkerKey: Buffer,
  ): boolean {
    const job = this.status({ jobId });
    if (
      job.state !== "awaiting_check" ||
      digest(artifacts) !== digest(job.artifacts ?? []) ||
      !isDone({ jobId, artifacts }, receipt, checkerKey)
    )
      return false;
    this.store.append("receipt", jobId, receipt);
    this.save({ ...job, state: "done" });
    return true;
  }
  stop(input: unknown): DelegateJob {
    const { jobId } = stopSchema.parse(input);
    this.pool.stop(jobId);
    return this.status({ jobId });
  }
  async summarize(input: unknown) {
    const { jobId } = idSchema.parse(input);
    this.status({ jobId });
    const text = await this.summarizer.update(jobId, true);
    return {
      rollingSummary: text ?? "",
      receipts: this.store
        .read()
        .filter((r) => r.id === jobId && r.type === "summary")
        .map((r) => r.body),
    };
  }
  log(input: unknown) {
    const { jobId, fromSeq, toSeq } = logSchema.parse(input);
    this.status({ jobId });
    return {
      untrusted: true as const,
      entries: this.store.read(fromSeq, toSeq).filter((r) => r.id === jobId),
    };
  }
  list(input: unknown = {}) {
    const query = listSchema.parse(input);
    return structuredClone(
      [...this.jobs.values()].filter(
        (j) =>
          (!query.state || j.state === query.state) &&
          (!query.parentJobId || j.spec.parentJobId === query.parentJobId),
      ),
    );
  }
}
