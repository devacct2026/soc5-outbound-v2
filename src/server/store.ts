// Persistence ports. Two implementations: memory (tests/dev) and Supabase
// (PostgREST + transactional RPC). Services depend only on these interfaces.
import type { RequestRecord } from "../domain/requests/lifecycle.ts";
import type { Actor, NotificationIntent, RequestEvent } from "../domain/requests/workflow.ts";
import type { Cursor } from "../domain/pagination.ts";
import type { Schedule } from "../domain/kpi.ts";

export interface StoredResponse {
  status: number;
  body: unknown;
}
export type Replay = StoredResponse | "CONFLICT" | null;

export interface IdemScope {
  actorId: string;
  method: string;
  path: string;
  key: string;
  payloadHash: string;
}

export interface OutboxIntent {
  idempotencyKey: string;
  channel: "SEATALK_ALERT" | "SEATALK_APPROVAL_SYNC" | "SEATALK_APPROVAL_PROVISION" | "GOOGLE_SHEETS";
  eventType: string;
  payload: Record<string, unknown>;
}

export interface CommitInput {
  request: RequestRecord;
  /** Row version the decision was computed from; null when creating. */
  expectedVersion: number | null;
  event: RequestEvent;
  notifications: NotificationIntent[];
  outbox: OutboxIntent[];
  idem?: IdemScope & { response: StoredResponse };
}

export interface CommandTx {
  request: RequestRecord | null;
  replay(scope: IdemScope): Promise<Replay>;
  commit(input: CommitInput): Promise<void>;
}

/** Thrown by commit when the row changed after it was loaded. */
export class VersionConflictError extends Error {
  constructor() {
    super("VERSION_CONFLICT");
  }
}

export interface Page<T> {
  data: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ListQuery {
  status?: string;
  search?: string; // plate number
  dateFrom?: string; // YYYY-MM-DD, business timezone
  dateTo?: string;
  limit: number;
  cursor: Cursor | null;
}

export interface Metrics {
  total: number;
  awaiting_action: number;
  by_status: Record<string, number>;
}

export interface StoredEvent {
  id: string;
  requestId: string;
  type: string;
  actorId: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  at: string;
  metadata: Record<string, unknown>;
  correlationId: string | null;
}

export interface NotificationView {
  id: string;
  event: string;
  title: string;
  body: string;
  requestId: string | null;
  createdAt: string;
  read: boolean;
}

export interface ClusterImportRow {
  name: string;
  region: string;
  dockNo: string | null;
  backlogs: number;
  backlogsTimestamp: string | null; // full UTC instant
}

export interface ClusterView {
  id: string;
  name: string;
  hub: string | null;
  region: string;
  dockNo: string | null;
  backlogs: number;
  backlogsTimestamp: string | null;
}

export interface Store {
  transaction<T>(requestId: string, fn: (tx: CommandTx) => Promise<T>): Promise<T>;
  getRequest(id: string): Promise<RequestRecord | null>;
  events(requestId: string): Promise<StoredEvent[]>;
  listRequests(actor: Actor, q: ListQuery): Promise<Page<RequestRecord>>;
  queue(actor: Actor, q: { limit: number; cursor: Cursor | null }): Promise<Page<RequestRecord>>;
  metrics(actor: Actor, f: { search?: string; dateFrom?: string; dateTo?: string }): Promise<Metrics>;
  /** `unread` counts EVERY visible notification, not just the returned page. `before` pages backwards (createdAt). */
  notifications(actor: Actor, opts?: { limit?: number; before?: string | null }): Promise<{ data: NotificationView[]; unread: number }>;
  markNotificationsRead(actor: Actor, id: string | null): Promise<boolean>;
  clusterActive(id: string): Promise<boolean>;
  searchClusters(query: string): Promise<ClusterView[]>;
  /** Atomic upsert by cluster name; backlog changes propagate to matching requests (audited). */
  importClusters(rows: ClusterImportRow[], source: string): Promise<{ processed: number }>;
  intraday(date: string): Promise<{ hour: number; orderQty: number; syncedAt: string | null }[]>;
  schedules(): Promise<Schedule[]>;
  upsertIntraday(rows: { date: string; hour: number; orderQty: number }[]): Promise<void>;
  /** Raw rows for reporting; the service applies KPI definitions + authorization. */
  reportingRows(from: string, to: string): Promise<RequestRecord[]>;
}

/** Raised when a reporting window exceeds the safe row cap; never silently truncate. */
export class ReportTooLargeError extends Error {
  constructor() {
    super("RANGE_TOO_LARGE");
  }
}

/** Retry wrapper shared by adapters: the transaction body is pure and re-runnable. */
export async function withVersionRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof VersionConflictError && i < attempts - 1) continue;
      throw e;
    }
  }
}
