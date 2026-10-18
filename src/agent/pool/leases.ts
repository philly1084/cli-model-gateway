import { randomUUID } from "node:crypto";
export interface Lease {
  leaseId: string;
  fencingToken: number;
  key: string;
  holder: string;
  expiresAt: number;
}
export class LeaseManager {
  private leases = new Map<string, Lease>();
  private fences = new Map<string, number>();
  constructor(private readonly clock = Date.now) {}
  acquire(key: string, holder: string, ttlMs: number): Lease | { busy: true } {
    if (ttlMs <= 0) throw Error("Invalid TTL");
    this.sweep(this.clock());
    if (this.leases.has(key)) return { busy: true };
    const fencingToken = (this.fences.get(key) ?? 0) + 1;
    this.fences.set(key, fencingToken);
    const lease = {
      key,
      holder,
      leaseId: randomUUID(),
      fencingToken,
      expiresAt: this.clock() + ttlMs,
    };
    this.leases.set(key, lease);
    return { ...lease };
  }
  renew(key: string, leaseId: string, ttlMs: number): boolean {
    const l = this.leases.get(key);
    if (
      !l ||
      l.leaseId !== leaseId ||
      l.expiresAt <= this.clock() ||
      ttlMs <= 0
    )
      return false;
    l.expiresAt = this.clock() + ttlMs;
    return true;
  }
  release(key: string, leaseId: string): boolean {
    if (this.leases.get(key)?.leaseId !== leaseId) return false;
    return this.leases.delete(key);
  }
  sweep(now = this.clock()): void {
    for (const [key, lease] of this.leases)
      if (lease.expiresAt <= now) this.leases.delete(key);
  }
  assertFence(key: string, token: number): void {
    const l = this.leases.get(key);
    if (!l || l.fencingToken !== token || l.expiresAt <= this.clock())
      throw Error("Stale fencing token");
  }
}
