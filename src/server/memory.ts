// In-memory Store for tests and local development. Not a persistence layer.
import { canView } from "../domain/permissions.ts";
import { localDate, DEFAULT_SCHEDULE, type Schedule } from "../domain/kpi.ts";
import { paginate, type Cursor } from "../domain/pagination.ts";
import type { RequestRecord } from "../domain/requests/lifecycle.ts";
import {
  countsAsAwaitingAction,
  isActionableForRole,
  type Actor,
  type NotificationIntent,
  type RequestEvent,
} from "../domain/requests/workflow.ts";
import {
  VersionConflictError,
  withVersionRetry,
  type ClusterImportRow,
  type ClusterView,
  type CommandTx,
  type CommitInput,
  type IdemScope,
  type ListQuery,
  type Metrics,
  type NotificationView,
  type OutboxIntent,
  type Page,
  type Replay,
  type Store,
  type StoredEvent,
  type StoredResponse,
} from "./store.ts";

const DAY = 24 * 3_600_000;
const ACTIVE_AWAITING = new Set(["PENDING", "REROUTED", "REQUESTED", "DOCKING"]);

interface StoredNotification extends NotificationIntent {
  id: string;
  requestId: string;
  createdAt: string;
  title: string;
}

export interface MemoryOutbox extends OutboxIntent {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "DEAD_LETTER" | "ABANDONED";
  attempts: number;
  availableAt: number;
  lastError: string | null;
}

export class MemoryStore implements Store {
  requests = new Map<string, RequestRecord>();
  eventLog: (RequestEvent & { id: string })[] = [];
  notificationLog: StoredNotification[] = [];
  outbox: MemoryOutbox[] = [];
  idempotency = new Map<string, { hash: string; response: StoredResponse; at: number }>();
  reads = new Set<string>();
  clusters: (ClusterView & { active: boolean })[] = [];
  dispatch = new Map<string, { hour: number; orderQty: number; syncedAt: string | null }[]>();
  scheduleList: Schedule[] = [DEFAULT_SCHEDULE];
  now: () => Date = () => new Date();
  private seq = 0;

  constructor(initial: RequestRecord[] = []) {
    for (const r of initial) this.requests.set(r.id, r);
  }

  private idemKey(s: IdemScope) {
    return `${s.actorId}|${s.method}|${s.path}|${s.key}`;
  }

  async transaction<T>(requestId: string, fn: (tx: CommandTx) => Promise<T>): Promise<T> {
    return withVersionRetry(async () => {
      const loaded = this.requests.get(requestId) ?? null;
      const tx: CommandTx = {
        request: loaded ? { ...loaded } : null,
        replay: async (scope): Promise<Replay> => {
          const hit = this.idempotency.get(this.idemKey(scope));
          if (!hit || this.now().getTime() - hit.at > DAY) return null; // OPS-4: 24h retention
          return hit.hash === scope.payloadHash ? hit.response : "CONFLICT";
        },
        commit: async (c: CommitInput) => {
          const current = this.requests.get(c.request.id) ?? null;
          if ((current?.rowVersion ?? null) !== c.expectedVersion) throw new VersionConflictError();
          this.requests.set(c.request.id, { ...c.request, rowVersion: (current?.rowVersion ?? 0) + 1 });
          this.eventLog.push({ ...c.event, id: String(++this.seq) }); // append-only
          for (const n of c.notifications) {
            if (this.notificationLog.some((x) => x.dedupeKey === n.dedupeKey)) continue;
            this.notificationLog.push({
              ...n,
              id: `n${++this.seq}`,
              requestId: c.request.id,
              createdAt: this.now().toISOString(),
              title: n.title ?? n.event,
            });
          }
          for (const o of c.outbox) {
            if (this.outbox.some((x) => x.idempotencyKey === o.idempotencyKey)) continue;
            this.outbox.push({ ...o, id: `o${++this.seq}`, status: "PENDING", attempts: 0, availableAt: 0, lastError: null });
          }
          if (c.idem) {
            this.idempotency.set(this.idemKey(c.idem), {
              hash: c.idem.payloadHash,
              response: c.idem.response,
              at: this.now().getTime(),
            });
          }
        },
      };
      return fn(tx);
    });
  }

  async getRequest(id: string) {
    const r = this.requests.get(id);
    return r ? { ...r } : null;
  }

  async events(requestId: string): Promise<StoredEvent[]> {
    return this.eventLog
      .filter((e) => e.requestId === requestId)
      .map((e) => ({
        id: e.id,
        requestId: e.requestId,
        type: e.type,
        actorId: e.actorId,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        at: e.at,
        metadata: { ...(e.metadata ?? {}), remarks: e.remarks, disposition: e.disposition, returnRole: e.returnRole },
        correlationId: e.correlationId,
      }))
      .reverse();
  }

  private visible(actor: Actor) {
    return [...this.requests.values()].filter((r) => canView(actor, r));
  }

  private toPage(rows: RequestRecord[], limit: number, cursor: Cursor | null): Page<RequestRecord> {
    const p = paginate(
      rows.map((r) => ({ ts: r.createdAt, id: r.id, r })),
      limit,
      cursor,
    );
    return { data: p.data.map((x) => x.r), hasMore: p.hasMore, nextCursor: p.nextCursor };
  }

  async listRequests(actor: Actor, q: ListQuery) {
    const tz = DEFAULT_SCHEDULE.timezone;
    const rows = this.visible(actor).filter(
      (r) =>
        (!q.status || r.status === q.status) &&
        (!q.search || (r.plateNumber ?? "").toLowerCase().includes(q.search.toLowerCase())) &&
        (!q.dateFrom || localDate(r.requestTimestamp, tz) >= q.dateFrom) &&
        (!q.dateTo || localDate(r.requestTimestamp, tz) <= q.dateTo),
    );
    return this.toPage(rows, q.limit, q.cursor);
  }

  async queue(actor: Actor, q: { limit: number; cursor: Cursor | null }) {
    const rows = this.visible(actor).filter((r) => isActionableForRole(r, actor.role, actor.id));
    return this.toPage(rows, q.limit, q.cursor);
  }

  async metrics(actor: Actor, f: { search?: string; dateFrom?: string; dateTo?: string }): Promise<Metrics> {
    const page = await this.listRequests(actor, { ...f, limit: Number.MAX_SAFE_INTEGER, cursor: null });
    const by_status: Record<string, number> = {};
    let awaiting = 0;
    for (const r of page.data) {
      by_status[r.status] = (by_status[r.status] ?? 0) + 1;
      if (ACTIVE_AWAITING.has(r.status) || countsAsAwaitingAction(r)) awaiting++;
    }
    return { total: page.data.length, awaiting_action: awaiting, by_status };
  }

  async notifications(actor: Actor, opts: { limit?: number; before?: string | null } = {}) {
    const all = this.notificationLog
      .filter((n) => n.recipientUserId === actor.id || (n.recipientRole && n.recipientRole === actor.role))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
    const page = all.filter((n) => !opts.before || n.createdAt < opts.before).slice(0, Math.min(Math.max(opts.limit ?? 50, 1), 100));
    const view = (n: StoredNotification): NotificationView => ({
      id: n.id, event: n.event, title: n.title, body: "", requestId: n.requestId, createdAt: n.createdAt,
      read: this.reads.has(`${n.id}:${actor.id}`),
    });
    return { data: page.map(view), unread: all.filter((n) => !this.reads.has(`${n.id}:${actor.id}`)).length };
  }

  async markNotificationsRead(actor: Actor, id: string | null) {
    const mine = this.notificationLog.filter(
      (n) => n.recipientUserId === actor.id || (n.recipientRole && n.recipientRole === actor.role),
    );
    const targets = id ? mine.filter((n) => n.id === id) : mine;
    if (id && !targets.length) return false; // caller must be an eligible recipient
    for (const n of targets) this.reads.add(`${n.id}:${actor.id}`);
    return true;
  }

  async clusterActive(id: string) {
    return this.clusters.some((c) => c.id === id && c.active);
  }
  async searchClusters(query: string) {
    const q = query.toLowerCase();
    return this.clusters
      .filter((c) => c.active && (c.name.toLowerCase().includes(q) || (c.hub ?? "").toLowerCase().includes(q)))
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .slice(0, 12);
  }

  async importClusters(rows: ClusterImportRow[], source: string) {
    void source;
    const byName = new Map(rows.map((r) => [r.name, r])); // the last duplicate wins
    for (const r of byName.values()) {
      const prior = this.clusters.find((c) => c.name === r.name);
      const view = { name: r.name, hub: r.name, region: r.region, dockNo: r.dockNo, backlogs: r.backlogs, backlogsTimestamp: r.backlogsTimestamp, active: true };
      const cluster = prior ? Object.assign(prior, view) : this.clusters[this.clusters.push({ id: crypto.randomUUID(), ...view }) - 1];
      // Mirror of the database trigger: audited propagation to matching, non-terminal requests.
      for (const q of this.requests.values()) {
        const terminal = q.status === "CANCELLED" || q.rejectionDisposition === "FINAL_NO_ROUTE" || q.rejectionDisposition === "LEGACY_UNRESOLVED";
        if (terminal || (q.clusterId !== cluster.id && q.cluster !== cluster.name)) continue;
        if (q.backlogs === cluster.backlogs && q.backlogsTimestamp === cluster.backlogsTimestamp) continue;
        this.eventLog.push({
          id: String(++this.seq), type: "BACKLOG_PROPAGATED", requestId: q.id, actorId: "system", creatorId: q.createdBy, at: this.now().toISOString(),
          fromStatus: q.status, toStatus: q.status, fromApprovalStatus: q.approvalStatus, toApprovalStatus: q.approvalStatus,
          remarks: null, disposition: null, returnRole: null, approvalVersion: q.approvalVersion, correlationId: "cluster-import",
          metadata: { source: "cluster_import", clusterId: cluster.id, changes: {
            backlogs: { before: q.backlogs, after: cluster.backlogs },
            backlogsTimestamp: { before: q.backlogsTimestamp, after: cluster.backlogsTimestamp } } },
        });
        this.requests.set(q.id, { ...q, backlogs: cluster.backlogs, backlogsTimestamp: cluster.backlogsTimestamp, rowVersion: q.rowVersion + 1 });
      }
    }
    return { processed: byName.size };
  }
  async intraday(date: string) {
    const rows = this.dispatch.get(date) ?? [];
    return Array.from({ length: 24 }, (_, hour) => rows.find((r) => r.hour === hour) ?? { hour, orderQty: 0, syncedAt: null });
  }
  async schedules() {
    return this.scheduleList;
  }
  async upsertIntraday(rows: { date: string; hour: number; orderQty: number }[]) {
    for (const r of rows) {
      const list = this.dispatch.get(r.date) ?? [];
      const next = list.filter((x) => x.hour !== r.hour);
      next.push({ hour: r.hour, orderQty: r.orderQty, syncedAt: this.now().toISOString() });
      this.dispatch.set(r.date, next);
    }
  }
  async reportingRows(from: string, to: string) {
    const tz = DEFAULT_SCHEDULE.timezone;
    return [...this.requests.values()].filter((r) => {
      const d = localDate(r.requestTimestamp, tz);
      return d >= from && d <= to;
    });
  }
}
