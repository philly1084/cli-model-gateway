import { LeaseManager, type Lease } from "./leases.js";
import type { ContainerRunner } from "./runners.js";
import { hasSecret } from "../checker/checker.js";
import { canonicalJSON } from "../crypto/sealed.js";
export type JobState =
  | "queued"
  | "leased"
  | "running"
  | "awaiting_check"
  | "done"
  | "needs_rework"
  | "failed"
  | "stopping"
  | "stopped"
  | "lease_lost"
  | "reconciliation_required"
  | "awaiting_approval";
export interface PoolJob {
  jobId: string;
  owner: string;
  resourceKey: string;
  write: boolean;
  priority: number;
  deadlineMs: number;
  payload: unknown;
  state: JobState;
  attempts: number;
  lease?: Lease;
  result?: unknown;
  failure?: string;
}
export class WorkerPool {
  private queue: PoolJob[] = [];
  private running = new Map<
    string,
    { controller: AbortController; job: PoolJob }
  >();
  private jobs = new Map<string, PoolJob>();
  private closed = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  constructor(
    readonly leases: LeaseManager,
    private runner: ContainerRunner,
    readonly maxConcurrency = 4,
    private perOwnerCap = maxConcurrency,
    private ttlMs = 3000,
    private event: (job: PoolJob) => void = () => {},
  ) {
    if (maxConcurrency < 1 || perOwnerCap < 1)
      throw Error("Invalid concurrency");
  }
  submit(input: Omit<PoolJob, "state" | "attempts">): PoolJob {
    if (this.closed || this.jobs.has(input.jobId))
      throw Error("Cannot submit job");
    const job: PoolJob = { ...input, state: "queued", attempts: 0 };
    this.jobs.set(job.jobId, job);
    this.queue.push(job);
    this.event(job);
    this.pump();
    return job;
  }
  get(id: string): PoolJob {
    const job = this.jobs.get(id);
    if (!job) throw Error("Unknown job");
    return structuredClone(job);
  }
  stop(id: string): void {
    const job = this.jobs.get(id);
    if (!job) throw Error("Unknown job");
    if (
      ["done", "failed", "stopped", "reconciliation_required"].includes(
        job.state,
      )
    )
      return;
    const active = this.running.get(id);
    if (active) {
      job.state = "stopping";
      this.event(job);
      active.controller.abort(Error("stopped"));
    } else {
      this.queue = this.queue.filter((j) => j.jobId !== id);
      job.state = "stopped";
      this.event(job);
    }
  }
  private pump(): void {
    if (this.closed) return;
    this.queue.sort((a, b) => b.priority - a.priority);
    while (this.running.size < this.maxConcurrency) {
      const index = this.queue.findIndex(
        (j) =>
          [...this.running.values()].filter((r) => r.job.owner === j.owner)
            .length < this.perOwnerCap,
      );
      if (index < 0) break;
      const job = this.queue.splice(index, 1)[0]!;
      const lease = this.leases.acquire(job.resourceKey, job.jobId, this.ttlMs);
      if ("busy" in lease) {
        this.queue.push(job);
        if (!this.retryTimer)
          this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            this.pump();
          }, this.ttlMs);
        break;
      }
      job.lease = lease;
      job.state = "leased";
      this.event(job);
      const controller = new AbortController();
      this.running.set(job.jobId, { controller, job });
      void this.execute(job, controller);
    }
  }
  private async execute(
    job: PoolJob,
    controller: AbortController,
  ): Promise<void> {
    const lease = job.lease!;
    job.state = "running";
    job.attempts++;
    this.event(job);
    const deadline = setTimeout(
      () => controller.abort(Error("timeout")),
      job.deadlineMs,
    );
    const heartbeat = setInterval(
      () => {
        if (!this.leases.renew(job.resourceKey, lease.leaseId, this.ttlMs))
          controller.abort(Error("lease_lost"));
      },
      Math.max(1, Math.floor(this.ttlMs / 3)),
    );
    let cancel: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      cancel = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", cancel, { once: true });
      if (controller.signal.aborted) cancel();
    });
    let retry = false;
    try {
      const result = await Promise.race([
        this.runner.run(
          { jobId: job.jobId, payload: job.payload },
          controller.signal,
        ),
        aborted,
      ]);
      if (hasSecret(canonicalJSON(result))) {
        job.failure = "secret_detected";
        job.state = "failed";
        return;
      }
      job.result = result;
      this.leases.assertFence(job.resourceKey, lease.fencingToken);
      job.state = "awaiting_check";
    } catch (error) {
      const reason = controller.signal.aborted
        ? String((controller.signal.reason as Error)?.message)
        : "crash";
      job.failure = reason;
      if (reason === "timeout") job.state = "failed";
      else if (reason === "stopped" || reason === "shutdown")
        job.state = job.write ? "reconciliation_required" : "stopped";
      else if (job.write) job.state = "reconciliation_required";
      else if (job.attempts <= 2 && !this.closed) {
        job.state = "queued";
        retry = true;
      } else job.state = reason === "lease_lost" ? "lease_lost" : "failed";
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      controller.signal.removeEventListener("abort", cancel);
      try {
        this.event(job);
      } finally {
        this.leases.release(job.resourceKey, lease.leaseId);
        this.running.delete(job.jobId);
      }
      if (retry) this.queue.push(job);
      this.pump();
    }
  }
  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const { controller } of this.running.values())
      controller.abort(Error("shutdown"));
    for (const j of this.queue) {
      j.state = "stopped";
      this.event(j);
    }
    this.queue = [];
  }
}
