import { randomUUID } from "node:crypto";
import type { SealedLog } from "../store/sealed-log.js";
export interface Notifier {
  notify(item: { itemId: string; kind: string }): void;
}
export class InboxNotifier implements Notifier {
  constructor(private log: SealedLog) {}
  notify(item: { itemId: string; kind: string }): void {
    this.log.append("notification", randomUUID(), item);
  }
}
