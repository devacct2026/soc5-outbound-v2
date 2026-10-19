// Supabase-backed Store + authentication. Verified by unit tests against a
// stubbed fetch (request shapes) and by DB tests for the SQL it calls. It has
// NOT been exercised against a live Supabase project (no credentials here).
import { localDate, DEFAULT_SCHEDULE, type Schedule } from "../../domain/kpi.ts";
import { encodeCursor, type Cursor } from "../../domain/pagination.ts";
import type { RequestRecord } from "../../domain/requests/lifecycle.ts";
import { countsAsAwaitingAction, type Actor, type Role } from "../../domain/requests/workflow.ts";
import { makeBackend, type Backend } from "../backend.ts";
import {
  ReportTooLargeError,
  VersionConflictError,
  withVersionRetry,
  type ClusterView,
  type CommandTx,
  type CommitInput,
  type ListQuery,
  type Metrics,
  type Page,
  type Replay,
  type Store,
} from "../store.ts";
import { fromRow, toRow } from "./mapping.ts";
import { Rest, RestError, q } from "./rest.ts";
import { SupabaseAdmin } from "../admin-ports.ts";
import { SupabaseApprovalStore } from "../seatalk/supabase.ts";

const ACTIVE_AWAITING = new Set(["PENDING", "REROUTED", "REQUESTED", "DOCKING"]);

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

const cursorFilter = (c: Cursor | null) =>
  c ? `&or=(created_at.lt.${encodeURIComponent(c.ts)},and(created_at.eq.${encodeURIComponent(c.ts)},id.lt.${q(c.id)}))` : "";

function pageOf(rows: RequestRecord[], limit: number): Page<RequestRecord> {
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);
  const last = data[data.length - 1];
  return { data, hasMore, nextCursor: hasMore && last ? encodeCursor({ ts: last.createdAt, id: last.id }) : null };
}

export class SupabaseStore implements Store {
  private rest: Rest;
  private now: () => Date;
  constructor(rest: Rest, now: () => Date = () => new Date()) {
    this.rest = rest;
    this.now = now;
  }

  async transaction<T>(requestId: string, fn: (tx: CommandTx) => Promise<T>): Promise<T> {
    return withVersionRetry(async () => {
      const rows = await this.rest.select("requests", `id=eq.${q(requestId)}&limit=1`);
      const loaded = rows[0] ? fromRow(rows[0]) : null;
      const tx: CommandTx = {
        request: loaded,
        replay: async (s): Promise<Replay> => {
          const hit = await this.rest.select(
            "idempotency_keys",
            `actor_id=eq.${q(s.actorId)}&method=eq.${q(s.method)}&path=eq.${q(s.path)}&key=eq.${q(s.key)}` +
              `&expires_at=gt.${encodeURIComponent(this.now().toISOString())}&limit=1`,
          );
          if (!hit[0]) return null;
          return hit[0].payload_hash === s.payloadHash
            ? { status: Number(hit[0].response_status), body: hit[0].response_body }
            : "CONFLICT";
        },
        commit: (c) => this.commit(c),
      };
      return fn(tx);
    });
  }

  private async commit(c: CommitInput) {
    const request = { ...toRow(c.request), row_version: c.expectedVersion === null ? 1 : c.expectedVersion };
    let res: { ok: boolean; code?: string };
    try {
      res = await this.rest.rpc("commit_transition", {
        p_request: request,
        p_expected_version: c.expectedVersion,
        p_event: {
          event_type: c.event.type,
          actor_id: c.event.actorId,
          creator_id: c.event.creatorId,
          from_status: c.event.fromStatus,
          to_status: c.event.toStatus,
          from_approval_status: c.event.fromApprovalStatus,
          to_approval_status: c.event.toApprovalStatus,
          approval_version: c.event.approvalVersion,
          metadata: { ...(c.event.metadata ?? {}), remarks: c.event.remarks, disposition: c.event.disposition, returnRole: c.event.returnRole },
          correlation_id: c.event.correlationId,
          created_at: c.event.at,
        },
        p_notifications: c.notifications.map((n) => ({
          dedupe_key: n.dedupeKey,
          event_type: n.event,
          title: n.title ?? n.event,
          body: "",
          recipient_user_id: n.recipientUserId ?? null,
          recipient_role: n.recipientRole ?? null,
        })),
        p_outbox: c.outbox.map((o) => ({
          idempotency_key: o.idempotencyKey,
          channel: o.channel,
          event_type: o.eventType,
          payload: o.payload,
        })),
        p_idem: c.idem
          ? {
              actor_id: c.idem.actorId,
              method: c.idem.method,
              path: c.idem.path,
              key: c.idem.key,
              payload_hash: c.idem.payloadHash,
              response_status: c.idem.response.status,
              response_body: c.idem.response.body,
            }
          : null,
      });
    } catch (e) {
      // 23505: a concurrent identical idempotent request committed first -> re-run and replay.
      if (e instanceof RestError && e.code === "23505") throw new VersionConflictError();
      throw e;
    }
    if (!res.ok) {
      if (res.code === "VERSION_CONFLICT") throw new VersionConflictError();
      throw new Error(`commit_transition failed: ${res.code}`);
    }
  }

  async getRequest(id: string) {
    const rows = await this.rest.select("requests", `id=eq.${q(id)}&limit=1`);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async events(requestId: string) {
    const rows = await this.rest.select(
      "request_events",
      `request_id=eq.${q(requestId)}&order=created_at.desc,id.desc&limit=500`,
    );
    return rows.map((e) => ({
      id: String(e.id),
      requestId: String(e.request_id),
      type: String(e.event_type),
      actorId: (e.actor_id as string | null) ?? null,
      fromStatus: (e.from_status as string | null) ?? null,
      toStatus: (e.to_status as string | null) ?? null,
      at: String(e.created_at),
      metadata: (e.metadata as Record<string, unknown>) ?? {},
      correlationId: (e.correlation_id as string | null) ?? null,
    }));
  }

  private scope(actor: Actor) {
    return actor.role === "ops_pic" ? `&created_by=eq.${q(actor.id)}` : "";
  }

  async listRequests(actor: Actor, l: ListQuery) {
    let f = this.scope(actor);
    if (l.status) f += `&status=eq.${q(l.status)}`;
    if (l.search) f += `&plate_number=ilike.*${q(l.search)}*`;
    if (l.dateFrom || l.dateTo) {
      const tz = DEFAULT_SCHEDULE.timezone;
      // Day bounds in the reporting timezone, expressed as instants.
      if (l.dateFrom) f += `&request_timestamp=gte.${encodeURIComponent(dayStart(l.dateFrom, tz))}`;
      if (l.dateTo) f += `&request_timestamp=lt.${encodeURIComponent(dayStart(nextDay(l.dateTo), tz))}`;
    }
    const rows = await this.rest.select(
      "requests",
      `order=created_at.desc,id.desc&limit=${l.limit + 1}${f}${cursorFilter(l.cursor)}`,
    );
    return pageOf(rows.map(fromRow), l.limit);
  }

  async queue(actor: Actor, l: { limit: number; cursor: Cursor | null }) {
    const rows = (await this.rest.rpc("queue_requests", {
      p_user: actor.id,
      p_role: actor.role,
      p_limit: l.limit + 1,
      p_cursor_ts: l.cursor?.ts ?? null,
      p_cursor_id: l.cursor?.id ?? null,
    })) as Record<string, unknown>[];
    return pageOf(rows.map(fromRow), l.limit);
  }

  async metrics(actor: Actor, f: { search?: string; dateFrom?: string; dateTo?: string }): Promise<Metrics> {
    const all: RequestRecord[] = [];
    let cursor: Cursor | null = null;
    for (let i = 0; ; i++) {
      const p = await this.listRequests(actor, { ...f, limit: 500, cursor });
      all.push(...p.data);
      if (!p.hasMore) break;
      if (i >= 19) throw new ReportTooLargeError(); // 10k rows: fail loudly, never undercount
      const last = p.data[p.data.length - 1];
      cursor = { ts: last.createdAt, id: last.id };
    }
    const by_status: Record<string, number> = {};
    let awaiting = 0;
    for (const r of all) {
      by_status[r.status] = (by_status[r.status] ?? 0) + 1;
      if (ACTIVE_AWAITING.has(r.status) || countsAsAwaitingAction(r)) awaiting++;
    }
    return { total: all.length, awaiting_action: awaiting, by_status };
  }

  async notifications(actor: Actor) {
    const rows = await this.rest.select(
      "notifications",
      `or=(recipient_user_id.eq.${q(actor.id)},recipient_role.eq.${q(actor.role)})&order=created_at.desc&limit=50`,
    );
    const ids = rows.map((r) => String(r.id));
    const reads = ids.length
      ? await this.rest.select("notification_reads", `user_id=eq.${q(actor.id)}&notification_id=in.(${ids.map(q).join(",")})`)
      : [];
    const readSet = new Set(reads.map((r) => String(r.notification_id)));
    const data = rows.map((n) => ({
      id: String(n.id),
      event: String(n.event_type),
      title: String(n.title),
      requestId: (n.request_id as string | null) ?? null,
      createdAt: String(n.created_at),
      read: readSet.has(String(n.id)),
    }));
    return { data, unread: data.filter((n) => !n.read).length };
  }

  async markNotificationsRead(actor: Actor, id: string | null) {
    const { data } = await this.notifications(actor);
    const targets = id ? data.filter((n) => n.id === id) : data.filter((n) => !n.read);
    if (id && !targets.length) return false;
    if (targets.length) {
      await this.rest.insert(
        "notification_reads",
        targets.map((n) => ({ notification_id: n.id, user_id: actor.id })),
        "resolution=ignore-duplicates,return=minimal",
      );
    }
    return true;
  }

  async clusterActive(id: string) {
    return (await this.rest.select("clusters", `id=eq.${q(id)}&active=eq.true&select=id&limit=1`)).length === 1;
  }

  async searchClusters(query: string): Promise<ClusterView[]> {
    const rows = await this.rest.select("clusters", `name=ilike.*${q(query)}*&active=eq.true&limit=12`);
    return rows.map((c) => ({
      id: String(c.id), name: String(c.name), hub: (c.hub_name as string | null) ?? null,
      region: String(c.region), dockNo: String(c.dock_no), backlogs: Number(c.backlogs),
    }));
  }

  async intraday(date: string) {
    const rows = await this.rest.select("intraday_dispatch", `dispatch_date=eq.${q(date)}`);
    return Array.from({ length: 24 }, (_, hour) => {
      const r = rows.find((x) => Number(x.hour) === hour);
      return { hour, orderQty: r ? Number(r.order_qty) : 0, syncedAt: r ? String(r.synced_at) : null };
    });
  }

  async schedules(): Promise<Schedule[]> {
    const rows = await this.rest.select("reporting_schedules", "order=effective_from.asc");
    return rows.length
      ? rows.map((r) => ({
          effectiveFrom: String(r.effective_from),
          shiftStart: String(r.shift_start).slice(0, 5),
          intervalCount: Number(r.interval_count),
          timezone: String(r.timezone),
        }))
      : [DEFAULT_SCHEDULE];
  }

  async upsertIntraday(rows: { date: string; hour: number; orderQty: number }[]) {
    await this.rest.insert(
      "intraday_dispatch?on_conflict=dispatch_date,hour",
      rows.map((r) => ({ dispatch_date: r.date, hour: r.hour, order_qty: r.orderQty, synced_at: this.now().toISOString() })),
      "resolution=merge-duplicates,return=minimal",
    );
  }

  async reportingRows(from: string, to: string) {
    const lo = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString();
    const hi = new Date(Date.parse(`${to}T00:00:00Z`) + 2 * 86_400_000).toISOString();
    const tz = (await this.schedules()).at(-1)?.timezone ?? DEFAULT_SCHEDULE.timezone;
    const rows: RequestRecord[] = [];
    let cursor: Cursor | null = null;
    for (let i = 0; ; i++) {
      const rs = await this.rest.select(
        "requests",
        `request_timestamp=gte.${encodeURIComponent(lo)}&request_timestamp=lt.${encodeURIComponent(hi)}` +
          `&order=created_at.desc,id.desc&limit=1001${cursorFilter(cursor)}`,
      );
      const page = pageOf(rs.map(fromRow), 1000);
      rows.push(...page.data);
      if (!page.hasMore) break;
      if (i >= 99) throw new ReportTooLargeError(); // 100k rows: fail loudly, never undercount
      const last = page.data[page.data.length - 1];
      cursor = { ts: last.createdAt, id: last.id };
    }
    return rows.filter((r) => {
      const d = localDate(r.requestTimestamp, tz);
      return d >= from && d <= to;
    });
  }
}

function nextDay(d: string) {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
}
function dayStart(d: string, tz: string) {
  // Local midnight of `d` in tz as an ISO instant.
  const base = Date.parse(`${d}T00:00:00Z`);
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const parts = Object.fromEntries(f.formatToParts(new Date(base)).map((p) => [p.type, p.value]));
  const seen = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return new Date(base - (seen - base)).toISOString();
}

/** Validate the bearer token with Supabase Auth, then load the CURRENT profile (no cache: revocation is immediate, OPS-3). */
export function makeAuthenticator(cfg: SupabaseConfig, rest: Rest) {
  const f = cfg.fetchImpl ?? fetch;
  return async (request: Request): Promise<Actor | null> => {
    const header = request.headers.get("authorization") ?? "";
    const m = /^Bearer ([A-Za-z0-9._~+/=-]{20,4096})$/.exec(header);
    if (!m) return null;
    let userId: string;
    try {
      const res = await f(`${cfg.url.replace(/\/$/, "")}/auth/v1/user`, {
        headers: { apikey: cfg.anonKey, authorization: `Bearer ${m[1]}` },
        signal: AbortSignal.timeout(8_000),
        cache: "no-store",
      });
      if (!res.ok) return null;
      const u = (await res.json()) as { id?: string };
      if (!u.id) return null;
      userId = u.id;
    } catch {
      return null;
    }
    const rows = await rest.select(
      "profiles",
      `id=eq.${q(userId)}&select=id,role,account_status,is_admin,reporting_permission&limit=1`,
    );
    const p = rows[0];
    if (!p) return null;
    const active = p.account_status === "ACTIVE" && !!p.role;
    if (!active) return null; // PENDING_APPROVAL / DISABLED: no operational access
    return {
      id: String(p.id),
      role: p.role as Role,
      active: true,
      isAdmin: p.is_admin === true,
      reportingPermission: p.reporting_permission === true,
    };
  };
}

export interface SupabaseBackendOptions {
  features?: Backend["features"];
  seatalkSecret?: string;
  seatalkMaxSkewSeconds?: number;
  actorLimiter?: Backend["actorLimiter"];
  anonLimiter?: Backend["anonLimiter"];
}

export function createSupabaseBackend(cfg: SupabaseConfig, opts: SupabaseBackendOptions = {}): Backend {
  const rest = new Rest({ url: cfg.url, serviceKey: cfg.serviceKey, fetchImpl: cfg.fetchImpl });
  return makeBackend({
    store: new SupabaseStore(rest),
    authenticate: makeAuthenticator(cfg, rest),
    admin: new SupabaseAdmin(rest),
    ...(opts.features ? { features: opts.features } : {}),
    ...(opts.actorLimiter ? { actorLimiter: opts.actorLimiter } : {}),
    ...(opts.anonLimiter ? { anonLimiter: opts.anonLimiter } : {}),
    ...(opts.seatalkSecret
      ? { seatalk: { signature: { secret: opts.seatalkSecret, maxSkewSeconds: opts.seatalkMaxSkewSeconds ?? 300 }, approvals: new SupabaseApprovalStore(rest) } }
      : {}),
  });
}
