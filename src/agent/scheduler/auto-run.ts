import { canAutoRun, type RiskStep } from "../policy/risk.js";
import type { ApprovalInbox } from "../approvals/inbox.js";
export interface SchedulerTimers {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
const timers: SchedulerTimers = {
  now: Date.now,
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
};
export class AutoRunScheduler {
  private entries = new Map<
    string,
    { spec: RiskStep; intervalMs: number; due: number }
  >();
  private handle?: unknown;
  constructor(
    private inbox: ApprovalInbox,
    private submit: (spec: RiskStep) => Promise<unknown>,
    private timer: SchedulerTimers = timers,
  ) {}
  add(id: string, spec: RiskStep, intervalMs: number): void {
    if (intervalMs <= 0) throw Error("Invalid recurrence");
    this.entries.set(id, {
      spec: structuredClone(spec),
      intervalMs,
      due: this.timer.now() + intervalMs,
    });
  }
  async tick(): Promise<void> {
    for (const entry of this.entries.values())
      if (entry.due <= this.timer.now()) {
        entry.due = this.timer.now() + entry.intervalMs;
        if (canAutoRun(entry.spec))
          await this.submit(structuredClone(entry.spec));
        else this.inbox.request({ kind: "scheduled", spec: entry.spec });
      }
  }
  start(): void {
    if (this.handle === undefined)
      this.handle = this.timer.setInterval(() => {
        void this.tick().catch(() => {});
      }, 1000);
  }
  stop(): void {
    if (this.handle !== undefined) this.timer.clearInterval(this.handle);
    this.handle = undefined;
  }
}
