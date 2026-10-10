import { readOutputLimit } from "./output-limit.js";
import { z } from "zod";

export const gatewayPolicySchema = z.object({
  operationId: z.string().regex(/^[\w.-]{1,128}$/),
  allowFallback: z.boolean(),
  maxAttempts: z.number().int().min(1).max(8),
  maxLatencyMs: z.number().int().min(1).max(600000),
  maxEvidenceAgeMs: z.number().int().min(1).max(86400000).optional(),
}).strict();
export type ExecutionReceipt = Record<string, string | number | boolean>;
export class ExecutionPolicy {
  readonly signal: AbortSignal;
  readonly allowFallback: boolean;
  readonly maxAttempts: number;
  readonly deadline: number;
  readonly operationId: string;
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private detach: () => void;
  private attempts = 0;
  private dispatched = false;
  private selectedModel?: string;
  private terminal = false;
  private cause = "cancelled";
  constructor(private options: { metadata?: Record<string, unknown>; signal?: AbortSignal; receivedAt?: number; requestId: string; model: string; receipt?: (value: ExecutionReceipt) => void; clock?: () => number }) {
    readOutputLimit(options.metadata);
    const policy = options.metadata?.gateway_policy === undefined ? undefined : gatewayPolicySchema.parse(options.metadata.gateway_policy);
    this.operationId = policy?.operationId ?? options.requestId;
    this.allowFallback = policy?.allowFallback ?? true;
    this.maxAttempts = policy?.maxAttempts ?? Infinity;
    this.deadline = policy ? (options.receivedAt ?? this.now()) + policy.maxLatencyMs : Infinity;
    this.signal = this.controller.signal;
    const cancel = () => { if (this.signal.aborted) return; this.cause = "cancelled"; this.controller.abort(Error("Request cancelled")); };
    options.signal?.addEventListener("abort", cancel, { once: true });
    this.detach = () => options.signal?.removeEventListener("abort", cancel);
    if (options.signal?.aborted) cancel();
    if (Number.isFinite(this.deadline)) {
      const remaining = this.deadline - this.now();
      if (remaining <= 0) this.expire();
      else this.timer = setTimeout(() => this.expire(), remaining);
    }
  }
  private now() { return (this.options.clock ?? Date.now)(); }
  private expire() { if (this.signal.aborted) return; this.cause = "deadline_exceeded"; this.controller.abort(Error("Request deadline exceeded")); }
  check() { if (this.now() >= this.deadline && !this.signal.aborted) this.expire(); this.signal.throwIfAborted(); }
  attempt(model = this.options.model, providerId = "unknown") {
    this.check(); if (this.attempts >= this.maxAttempts) throw Error("Request attempt budget exhausted"); this.attempts++; this.selectedModel = model;
    this.options.receipt?.({ type: "gateway.execution.attempt", operationId: this.operationId, requestId: this.options.requestId, model, providerId, attempt: this.attempts, at: this.now() });
  }
  canFallback() { this.check(); return this.allowFallback && this.attempts < this.maxAttempts; }
  dispatch() { this.check(); this.dispatched = true;
    this.options.receipt?.({ type: "gateway.execution.dispatch", operationId: this.operationId, requestId: this.options.requestId, model: this.selectedModel ?? this.options.model, attempt: this.attempts, at: this.now(), providerReceiptConfirmed: false });
  }
  cleanup(localProcessGroupAbsent: boolean) {
    this.options.receipt?.({ type: "gateway.execution.cleanup", operationId: this.operationId, requestId: this.options.requestId, localProcessGroupAbsent, providerOutcome: "unknown" });
  }
  async wait<T>(work: Promise<T>): Promise<T> {
    // Attach before checking an already-expired budget: late failures stay observed.
    void work.catch(() => {});
    this.check();
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(this.signal.reason); this.signal.addEventListener("abort", abort, { once: true }); if (this.signal.aborted) abort(); });
    try { const result = await Promise.race([work, cancelled]); this.check(); return result; }
    finally { this.signal.removeEventListener("abort", abort); }
  }
  finish(success: boolean) {
    if (this.terminal) return;
    this.terminal = true;
    if (this.timer) clearTimeout(this.timer); this.detach();
    this.options.receipt?.({ type: "gateway.execution.terminal", operationId: this.operationId, requestId: this.options.requestId, requestedModel: this.options.model, selectedModel: this.selectedModel ?? this.options.model, attempts: this.attempts, at: this.now(),
      status: this.signal.aborted ? this.cause : success ? "succeeded" : "failed",
      providerOutcome: success && !this.signal.aborted ? "completed" : this.dispatched ? "unknown" : "not_started",
      cancellationRequested: this.signal.aborted, replaySafe: !this.dispatched });
  }
}
