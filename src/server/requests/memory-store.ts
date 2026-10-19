// In-memory RequestStore for tests only. Not a persistence implementation.
import type {
  NotificationIntent,
  RequestEvent,
  WorkflowRequest,
} from "../../domain/requests/workflow.ts";
import type { RejectOutcome, RequestStore, RequestTx } from "./service.ts";

export class MemoryStore implements RequestStore {
  requests = new Map<string, WorkflowRequest>();
  events: RequestEvent[] = [];
  notifications = new Map<string, NotificationIntent>();
  idempotency = new Map<string, RejectOutcome>();

  constructor(initial: WorkflowRequest[] = []) {
    for (const r of initial) this.requests.set(r.id, r);
  }

  async transaction<T>(
    requestId: string,
    fn: (tx: RequestTx) => Promise<T>,
  ): Promise<T> {
    return fn({
      request: this.requests.get(requestId) ?? null,
      replay: async (key) => this.idempotency.get(key) ?? null,
      commit: async (next, event, notifications, idem) => {
        this.requests.set(next.id, next);
        this.events.push(event); // append-only
        for (const n of notifications) this.notifications.set(n.dedupeKey, n);
        if (idem) this.idempotency.set(idem.key, idem.outcome);
      },
    });
  }
}
