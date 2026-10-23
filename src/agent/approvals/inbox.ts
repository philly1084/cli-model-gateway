import { digest } from "../crypto/sealed.js";
import type { SealedLog } from "../store/sealed-log.js";
export interface InboxItem {
  id: string;
  actionDigest: string;
  action: unknown;
  createdAt: number;
  expiresAt: number;
  state: "pending" | "approved" | "denied" | "expired" | "consumed";
}
export class ApprovalInbox {
  private items = new Map<string, InboxItem>();
  constructor(
    private log: SealedLog,
    private ttlMs = 86400000,
    private clock = Date.now,
  ) {
    for (const r of log.read())
      if (r.type === "inbox") {
        const item = r.body as InboxItem;
        this.items.set(item.id, item);
      }
  }
  private save(item: InboxItem): InboxItem {
    this.log.append("inbox", item.id, item);
    this.items.set(item.id, structuredClone(item));
    return structuredClone(item);
  }
  request(action: unknown): InboxItem {
    const actionDigest = digest(action);
    const existing = this.list().find(
      (i) =>
        i.actionDigest === actionDigest &&
        ["pending", "approved"].includes(i.state),
    );
    if (existing) return existing;
    return this.save({
      id: actionDigest,
      actionDigest,
      action,
      createdAt: this.clock(),
      expiresAt: this.clock() + this.ttlMs,
      state: "pending",
    });
  }
  list(): InboxItem[] {
    for (const item of this.items.values())
      if (
        ["pending", "approved"].includes(item.state) &&
        item.expiresAt <= this.clock()
      )
        this.save({ ...item, state: "expired" });
    return structuredClone([...this.items.values()]);
  }
  private decide(id: string, state: "approved" | "denied"): InboxItem {
    this.list();
    const item = this.items.get(id);
    if (!item || item.state !== "pending") throw Error("Approval unavailable");
    return this.save({ ...item, state });
  }
  approve(id: string): InboxItem {
    return this.decide(id, "approved");
  }
  deny(id: string): InboxItem {
    return this.decide(id, "denied");
  }
  consume(actionDigest: string): boolean {
    const item = this.list().find(
      (i) => i.actionDigest === actionDigest && i.state === "approved",
    );
    if (!item) return false;
    this.save({ ...item, state: "consumed" });
    return true;
  }
}
