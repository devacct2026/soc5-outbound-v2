// Transport-level handlers. Route files are thin wrappers so the whole API
// surface is testable with plain Request objects and a MemoryStore.
import { decodeCursor, parsePageSize } from "../domain/pagination.ts";
import { OPERATIONAL_ROLES, canReadAnalytics, canReadIntraday, canView, isAdmin } from "../domain/permissions.ts";
import {
  approve,
  assignDriver,
  assignTruck,
  cancel,
  createRequest,
  dock,
  editRequest,
  overrideSafeguards,
  reassignDriver,
  rejectRecord,
  type RequestRecord,
} from "../domain/requests/lifecycle.ts";
import {
  isUuid,
  parseBulkIds,
  parseDriver,
  parseEmpty,
  parseRemarks,
  parseRequestDetails,
  parseTrip,
  parseTruck,
  isRealDate,
  type Parsed,
} from "../domain/requests/validation.ts";
import { fail, type Actor, type Role, type WorkflowResult } from "../domain/requests/workflow.ts";
import { kpiDaily, kpiHourly, kpiSummary, lastDays, monthToDate, scheduleFor, toCsv } from "../domain/kpi.ts";
import { toApiRequest } from "./api-shape.ts";
import type { Backend } from "./backend.ts";
import { errorResponse, runCommand, type CommandSpec } from "./commands.ts";
import { ReportTooLargeError, type StoredResponse } from "./store.ts";
import { clientKey } from "./rate-limit.ts";
import { readBodyLimited } from "./http-body.ts";

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...SECURITY_HEADERS, ...extra },
  });
const send = (r: StoredResponse) => json(r.status, r.body);
const err = (code: string, details?: unknown) => send(errorResponse(code, details));
const invalid = (errors: Record<string, string>) => err("VALIDATION_FAILED", errors);

type Handler = (backend: Backend | null, request: Request, params?: Record<string, string>) => Promise<Response>;

async function authed(
  backend: Backend | null,
  request: Request,
): Promise<{ backend: Backend; actor: Actor } | Response> {
  if (!backend) return err("BACKEND_NOT_CONFIGURED");
  // Throttle by address first so unauthenticated token guessing is bounded.
  if (backend.anonLimiter && !backend.anonLimiter.allow(clientKey(request))) return err("RATE_LIMITED");
  const actor = await backend.authenticate(request);
  if (!actor || !actor.active) return err("UNAUTHENTICATED");
  if (backend.actorLimiter && !backend.actorLimiter.allow(`actor:${actor.id}`)) return err("RATE_LIMITED");
  return { backend, actor };
}

const TOO_LARGE = Symbol.for("payload-too-large");
async function body(request: Request): Promise<unknown> {
  const text = await readBodyLimited(request, 256 * 1024);
  if (text === null) return TOO_LARGE;
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return Symbol.for("invalid-json");
  }
}
const badJson = (b: unknown) => typeof b === "symbol";
const tooLarge = (b: unknown) => b === TOO_LARGE;

/** OPS-4: every state-changing call needs an Idempotency-Key. */
function idemKey(request: Request): string | null {
  const k = request.headers.get("idempotency-key");
  return k && k.length >= 8 && k.length <= 200 && /^[\x21-\x7e]+$/.test(k) ? k : null;
}

const actionPath = (id: string, action: string) => `/api/v1/requests/${id}/${action}`;

interface ActionDef {
  roles: Role[];
  /** Parse client payload into a decision. */
  build(
    b: unknown,
    actor: Actor,
    request: RequestRecord,
  ): Parsed<(r: RequestRecord, ctx: { now: Date; correlationId: string }) => WorkflowResult>;
  creatorOnly?: boolean;
}

const wrap = <T>(p: Parsed<T>, f: (v: T) => (r: RequestRecord, c: { now: Date; correlationId: string }) => WorkflowResult) =>
  p.ok ? ({ ok: true, value: f(p.value) } as const) : p;

function actionFor(action: string, actor: Actor): ActionDef | null {
  switch (action) {
    case "approve":
      return { roles: ["fte_ops"], build: (b) => wrap(parseEmpty(b), () => (r, c) => approve(r, actor, c, "WEB")) };
    case "reject-ops":
      return {
        roles: ["fte_ops"],
        build: (b) => wrap(parseRemarks(b, "rejection_remarks", true), (m) => (r, c) => rejectRecord(r, actor, m ?? "", c)),
      };
    case "reject-mm":
      return {
        roles: ["fte_mm"],
        build: (b) => wrap(parseRemarks(b, "rejection_remarks", true), (m) => (r, c) => rejectRecord(r, actor, m ?? "", c)),
      };
    case "cancel":
      return {
        roles: ["ops_pic", "fte_ops", "fte_mm"],
        build: (b) =>
          wrap(parseRemarks(b, "cancellation_remarks", actor.role === "fte_mm"), (m) => (r, c) => cancel(r, actor, m, c)),
      };
    case "assign-truck":
      return { roles: ["fte_mm"], build: (b) => wrap(parseTruck(b), (t) => (r, c) => assignTruck(r, actor, t, c)) };
    case "assign-driver":
      return { roles: ["doc_officer"], build: (b) => wrap(parseDriver(b), (d) => (r, c) => assignDriver(r, actor, d, c)) };
    case "reassign-driver":
      return { roles: ["doc_officer"], build: (b) => wrap(parseDriver(b), (d) => (r, c) => reassignDriver(r, actor, d, c)) };
    case "dock":
      return {
        roles: ["ops_pic"],
        creatorOnly: true,
        build: (b) => wrap(parseTrip(b), (t) => (r, c) => dock(r, actor, t, c)),
      };
    case "reject": // alias of the earlier APR-3 route: role selects the stage
      if (actor.role === "fte_mm") return actionFor("reject-mm", actor);
      return actionFor("reject-ops", actor);
    case "mark-docked": // compatibility adapter: role-dependent semantics (04-api-contracts)
      if (actor.role === "doc_officer") return actionFor("assign-driver", actor);
      if (actor.role === "ops_pic") return actionFor("dock", actor);
      return { roles: [], build: () => ({ ok: false, errors: {} }) };
    default:
      return null;
  }
}

/** POST /api/v1/requests */
export const createRequestHandler: Handler = async (backend, request) => {
  const a = await authed(backend, request);
  if (a instanceof Response) return a;
  const { actor } = a;
  const key = idemKey(request);
  if (!key) return err("IDEMPOTENCY_KEY_REQUIRED");
  if (actor.role !== "ops_pic" && actor.role !== "fte_ops") return err("FORBIDDEN");
  const b = await body(request);
  if (tooLarge(b)) return err("PAYLOAD_TOO_LARGE");
  if (badJson(b)) return err("BAD_REQUEST");
  const parsed = parseRequestDetails(b);
  if (!parsed.ok) return invalid(parsed.errors);
  // HUB-6: a registered-cluster reference must exist; free text never grants access.
  if (parsed.value.clusterId && !(await a.backend.store.clusterActive(parsed.value.clusterId))) {
    return invalid({ cluster_id: "unknown or inactive cluster" });
  }
  const id = crypto.randomUUID();
  const correlationId = crypto.randomUUID();
  const now = a.backend.now();
  return send(
    await runCommand(a.backend.store, {
      actor,
      requestId: id,
      creating: true,
      method: "POST",
      path: "/api/v1/requests",
      idempotencyKey: key,
      payload: b,
      authorize: () => true,
      decide: () => createRequest(actor, parsed.value, { now, correlationId, newId: id }),
      successStatus: 201,
      features: a.backend.features,
    }),
  );
};

/** PUT /api/v1/requests/{id}: edit / correct / post-dock edit. */
export const updateRequestHandler: Handler = async (backend, request, params) => {
  const a = await authed(backend, request);
  if (a instanceof Response) return a;
  const { actor } = a;
  const id = params?.id ?? "";
  if (!isUuid(id)) return err("NOT_FOUND");
  const key = idemKey(request);
  if (!key) return err("IDEMPOTENCY_KEY_REQUIRED");
  const b = await body(request);
  if (tooLarge(b)) return err("PAYLOAD_TOO_LARGE");
  if (badJson(b)) return err("BAD_REQUEST");
  const parsed = parseRequestDetails(b);
  if (!parsed.ok) return invalid(parsed.errors);
  if (parsed.value.clusterId && !(await a.backend.store.clusterActive(parsed.value.clusterId))) {
    return invalid({ cluster_id: "unknown or inactive cluster" });
  }
  const now = a.backend.now();
  const correlationId = crypto.randomUUID();
  return send(
    await runCommand(a.backend.store, {
      actor,
      requestId: id,
      method: "PUT",
      path: `/api/v1/requests/${id}`,
      idempotencyKey: key,
      payload: b,
      authorize: (act, r) => !!r && canView(act, r),
      decide: (r) => (r ? editRequest(r, actor, parsed.value, { now, correlationId }) : fail("INVALID_STATE")),
      features: a.backend.features,
    }),
  );
};

/** POST /api/v1/requests/{id}/{action} */
export const actionHandler: Handler = async (backend, request, params) => {
  const a = await authed(backend, request);
  if (a instanceof Response) return a;
  const { actor } = a;
  const id = params?.id ?? "";
  const action = params?.action ?? "";
  if (!isUuid(id)) return err("NOT_FOUND");
  const def = actionFor(action, actor);
  if (!def) return err("NOT_FOUND");
  const key = idemKey(request);
  if (!key) return err("IDEMPOTENCY_KEY_REQUIRED");
  const b = await body(request);
  if (tooLarge(b)) return err("PAYLOAD_TOO_LARGE");
  if (badJson(b)) return err("BAD_REQUEST");

  // Optional administrator override (HUB-4): strictly an envelope around a valid transition.
  let override: Record<string, unknown> | null = null;
  let effective = actor;
  const overrideHeader = request.headers.get("x-admin-override");
  if (overrideHeader !== null) {
    if (!isAdmin(actor)) return err("FORBIDDEN");
    const asRoleRaw = request.headers.get("x-override-role");
    if (asRoleRaw !== null && !OPERATIONAL_ROLES.includes(asRoleRaw as Role)) return invalid({ "x-override-role": "unknown role" });
    const asRole = asRoleRaw as Role | null;
    const verified = await a.backend.identity.verifyStrongIdentity(actor, request);
    const g = overrideSafeguards(actor, { justification: overrideHeader, identityVerified: verified, asRole: asRole ?? actor.role });
    if (!g.ok) return err(g.code);
    effective = g.actingAs;
    override = g.metadata;
  }
  const useDef = effective === actor ? def : actionFor(action, effective);
  if (!useDef) return err("NOT_FOUND");

  const now = a.backend.now();
  const correlationId = crypto.randomUUID();
  const features = a.backend.features;

  // SEA-1: no internal approval bypass. Web approval requires the SeaTalk gate.
  const gated = action === "approve";
  const spec: CommandSpec = {
    actor,
    requestId: id,
    method: "POST",
    path: actionPath(id, action),
    idempotencyKey: key,
    // The override role and justification are part of the hashed payload: a replay can never
    // return an earlier response for a different override.
    payload: { body: b ?? null, override: override ?? false },
    authorize: (act, r) => {
      if (!r) return false;
      const e = override ? effective : act;
      if (!useDef.roles.includes(e.role) || !e.active) return false;
      if (override) return true;
      return canView(act, r) && (!useDef.creatorOnly || act.id === r.createdBy);
    },
    decide: (r) => {
      if (!r) return fail("INVALID_STATE");
      const built = useDef.build(b, effective, r);
      if (!built.ok) return { ok: false, code: "VALIDATION_FAILED" } as WorkflowResult;
      const out = built.value(r, { now, correlationId });
      if (out.ok && override) out.event.metadata = { ...(out.event.metadata ?? {}), ...override };
      return out;
    },
    features,
  };

  // Validate payload shape up front so field errors are reported precisely.
  const probe = useDef.build(b, effective, {} as RequestRecord);
  if (!probe.ok && Object.keys(probe.errors).length) return invalid(probe.errors);

  if (gated) {
    const peek = await a.backend.store.getRequest(id);
    if (!peek || !canView(actor, peek)) return err("NOT_FOUND"); // same masking as runCommand
    if (!spec.authorize(actor, peek)) return err("FORBIDDEN");
    const gate = await a.backend.approvalGate.authorizeWebApproval(effective, peek);
    if (!gate.ok) return err(gate.code);
  }
  return send(await runCommand(a.backend.store, spec));
};

/** POST /api/v1/requests/bulk-approve (FTE Ops only; same transition service). */
export const bulkApproveHandler: Handler = async (backend, request) => {
  const a = await authed(backend, request);
  if (a instanceof Response) return a;
  const { actor } = a;
  if (actor.role !== "fte_ops") return err("FORBIDDEN");
  const key = idemKey(request);
  if (!key) return err("IDEMPOTENCY_KEY_REQUIRED");
  const b = await body(request);
  if (tooLarge(b)) return err("PAYLOAD_TOO_LARGE");
  if (badJson(b)) return err("BAD_REQUEST");
  const ids = parseBulkIds(b);
  if (!ids.ok) return invalid(ids.errors);
  const data: unknown[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const id of ids.value) {
    const peek = await a.backend.store.getRequest(id);
    if (!peek) { failed.push({ id, error: "NOT_FOUND" }); continue; }
    const gate = await a.backend.approvalGate.authorizeWebApproval(actor, peek);
    if (!gate.ok) { failed.push({ id, error: gate.code }); continue; }
    const now = a.backend.now();
    const res = await runCommand(a.backend.store, {
      actor, requestId: id, method: "POST", path: actionPath(id, "approve"),
      idempotencyKey: `${key}:${id}`.slice(0, 200), payload: null,
      authorize: (act, r) => !!r && act.role === "fte_ops",
      decide: (r) => (r ? approve(r, actor, { now, correlationId: crypto.randomUUID() }, "WEB") : fail("INVALID_STATE")),
      features: a.backend.features,
    });
    if (res.status === 200) data.push((res.body as { request: unknown }).request);
    else failed.push({ id, error: (res.body as { error: string }).error });
  }
  return json(200, { data, failed });
};

const STATUS_VALUES = new Set(["PENDING", "REROUTED", "REQUESTED", "REJECTED", "CANCELLED", "DOCKING", "DOCKED", "ASSIGNED", "APPROVED", "REJECTED_BY_MM", "FOR_DOCKING", "CONFIRMED"]);
/** Plate-number / cluster search: conservative charset so it can never alter a PostgREST filter. */
const SEARCH_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

function filterParams(url: URL): { ok: true; value: { status?: string; search?: string; dateFrom?: string; dateTo?: string } } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const status = url.searchParams.get("status") ?? undefined;
  const search = url.searchParams.get("search") ?? undefined;
  const dateFrom = url.searchParams.get("date_from") ?? undefined;
  const dateTo = url.searchParams.get("date_to") ?? undefined;
  if (status !== undefined && !STATUS_VALUES.has(status)) errors.status = "unknown status";
  if (search !== undefined && !SEARCH_RE.test(search)) errors.search = "1-40 letters, digits, space . _ -";
  if (dateFrom !== undefined && !isRealDate(dateFrom)) errors.date_from = "YYYY-MM-DD required";
  if (dateTo !== undefined && !isRealDate(dateTo)) errors.date_to = "YYYY-MM-DD required";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { status, search, dateFrom, dateTo } };
}

const listParams = (url: URL) => {
  const size = parsePageSize(url.searchParams.get("limit") ?? url.searchParams.get("per_page"));
  const cursor = decodeCursor(url.searchParams.get("cursor"));
  return { size, cursor };
};

const pageBody = (p: { data: RequestRecord[]; hasMore: boolean; nextCursor: string | null }, actor: Actor, limit: number) => ({
  data: p.data.map((r) => toApiRequest(r, actor)),
  has_more: p.hasMore,
  next_cursor: p.nextCursor,
  limit,
});

export const queueHandler: Handler = async (backend, request) => {
  const a = await authed(backend, request);
  if (a instanceof Response) return a;
  const { size, cursor } = listParams(new URL(request.url));
  if (!size.ok) return invalid({ limit: "must be 25, 50 or 100" });
  if (!cursor.ok) return invalid({ cursor: "invalid cursor" });
  const page = await a.backend.store.queue(a.actor, { limit: size.value, cursor: cursor.value });
  return json(200, pageBody(page, a.actor, size.value));
};

export const listHandler: Handler = async (backend, request) => {
  const a = await authed(backend, request);
  if (a instanceof Response) return a;
  const url = new URL(request.url);
  const { size, cursor } = listParams(url);
  if (!size.ok) return invalid({ limit: "must be 25, 50 or 100" });
  if (!cursor.ok) return invalid({ cursor: "invalid cursor" });
  const f = filterParams(url);
  if (!f.ok) return invalid(f.errors);
  const page = await a.backend.store.listRequests(a.actor, { ...f.value, limit: size.value, cursor: cursor.value });
  return json(200, pageBody(page, a.actor, size.value));
};

export const getRequestHandler: Handler = async (backend, request, params) => {
  const a = await authed(backend, request);
  if (a instanceof Response) return a;
  const id = params?.id ?? "";
  const r = isUuid(id) ? await a.backend.store.getRequest(id) : null;
  if (!r || !canView(a.actor, r)) return err("NOT_FOUND"); // no existence oracle
  return json(200, { request: toApiRequest(r, a.actor) });
};

export const eventsHandler: Handler = async (backend, request, params) => {
  const a = await authed(backend, request);
  if (a instanceof Response) return a;
  const id = params?.id ?? "";
  const r = isUuid(id) ? await a.backend.store.getRequest(id) : null;
  if (!r || !canView(a.actor, r)) return err("NOT_FOUND");
  return json(200, { data: await a.backend.store.events(id) });
};

export const metricsHandler: Handler = async (backend, request) => {
  const a = await authed(backend, request);
  if (a instanceof Response) return a;
  const f = filterParams(new URL(request.url));
  if (!f.ok) return invalid(f.errors);
  try {
    return json(200, await a.backend.store.metrics(a.actor, f.value));
  } catch (e) {
    if (e instanceof ReportTooLargeError) return err("RANGE_TOO_LARGE");
    throw e;
  }
};

export const notificationsHandler: Handler = async (backend, request) => {
  const a = await authed(backend, request);
  if (a instanceof Response) return a;
  return json(200, await a.backend.store.notifications(a.actor));
};

export const markReadHandler: Handler = async (backend, request, params) => {
  const a = await authed(backend, request);
  if (a instanceof Response) return a;
  const id = params?.id ?? null;
  if (id !== null && id !== "all" && !isUuid(id) && !/^n\d+$/.test(id)) return err("NOT_FOUND");
  const ok = await a.backend.store.markNotificationsRead(a.actor, id === "all" ? null : id);
  return ok ? json(200, { ok: true }) : err("NOT_FOUND");
};

export const clustersHandler: Handler = async (backend, request) => {
  const a = await authed(backend, request);
  if (a instanceof Response) return a;
  const q = new URL(request.url).searchParams.get("search") ?? "";
  if (q.length < 3 || q.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(q)) return invalid({ search: "3-80 letters, digits, space . _ -" });
  return json(200, { data: await a.backend.store.searchClusters(q) });
};

export const intradayHandler: Handler = async (backend, request) => {
  const a = await authed(backend, request);
  if (a instanceof Response) return a;
  if (!canReadIntraday(a.actor)) return err("FORBIDDEN");
  const date = new URL(request.url).searchParams.get("date") ?? "";
  if (!isRealDate(date)) return invalid({ date: "YYYY-MM-DD required" });
  const rows = await a.backend.store.intraday(date);
  return json(200, { data: rows.map((r) => ({ date, hour: r.hour, orderQty: r.orderQty, syncedAt: r.syncedAt })) });
};

/** KPI endpoints: reporting permission required (KPI-6), independent of role. */
async function reporting(
  backend: Backend | null,
  request: Request,
): Promise<{ backend: Backend; actor: Actor; from: string; to: string; tz: string } | Response> {
  const a = await authed(backend, request);
  if (a instanceof Response) return a;
  if (!canReadAnalytics(a.actor)) return err("FORBIDDEN");
  const schedules = await a.backend.store.schedules();
  const now = a.backend.now();
  const tz = scheduleFor(now.toISOString().slice(0, 10), schedules).timezone;
  const u = new URL(request.url);
  const def = u.pathname.endsWith("/daily") ? lastDays(now, tz) : monthToDate(now, tz);
  const from = u.searchParams.get("date_from") ?? def.from;
  const to = u.searchParams.get("date_to") ?? def.to;
  if (!isRealDate(from) || !isRealDate(to) || from > to) return invalid({ date: "valid YYYY-MM-DD range required" });
  // Bounded range: reports are aggregated in memory, so an unbounded window is a DoS vector.
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 400) return invalid({ date: "range may not exceed 400 days" });
  return { backend: a.backend, actor: a.actor, from, to, tz };
}

/** Load reporting rows; a range that exceeds the safe cap fails loudly instead of under-counting. */
async function rows(b: Backend, from: string, to: string, f: (rows: RequestRecord[]) => Response): Promise<Response> {
  try {
    return f(await b.store.reportingRows(from, to));
  } catch (e) {
    if (e instanceof ReportTooLargeError) return err("RANGE_TOO_LARGE");
    throw e;
  }
}

export const kpiSummaryHandler: Handler = async (backend, request) => {
  const r = await reporting(backend, request);
  if (r instanceof Response) return r;
  return rows(r.backend, r.from, r.to, (x) => json(200, kpiSummary(x, r.from, r.to, r.tz)));
};
export const kpiDailyHandler: Handler = async (backend, request) => {
  const r = await reporting(backend, request);
  if (r instanceof Response) return r;
  return rows(r.backend, r.from, r.to, (x) => json(200, { data: kpiDaily(x, r.from, r.to, r.tz) }));
};
export const kpiHourlyHandler: Handler = async (backend, request) => {
  const r = await reporting(backend, request);
  if (r instanceof Response) return r;
  const date = new URL(request.url).searchParams.get("date") ?? r.to;
  if (!isRealDate(date)) return invalid({ date: "YYYY-MM-DD required" });
  const schedules = await r.backend.store.schedules();
  // Fetch a window wide enough to cover a shift that crosses midnight.
  const rows = await r.backend.store.reportingRows(date, new Date(Date.parse(`${date}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10));
  return json(200, kpiHourly(rows, date, schedules));
};
/** Same permission as analytics (KPI-6: exports share the restriction). */
export const kpiExportHandler: Handler = async (backend, request) => {
  const r = await reporting(backend, request);
  if (r instanceof Response) return r;
  return rows(r.backend, r.from, r.to, (data) => csvResponse(r.from, r.to, data));
};
function csvResponse(from: string, to: string, rows: RequestRecord[]): Response {
  const csv = toCsv(
    ["id", "request_timestamp", "status", "approval_status", "cluster", "region", "truck_size", "truck_type", "plate_number"],
    rows.map((x) => [x.id, x.requestTimestamp, x.status, x.approvalStatus, x.cluster, x.region, x.truckSize, x.truckType, x.plateNumber]),
  );
  return new Response(csv, {
    status: 200,
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="requests_${from}_${to}.csv"`, ...SECURITY_HEADERS },
  });
}

export const markAllReadHandler: Handler = (backend, request) => markReadHandler(backend, request, { id: "all" });

export const meHandler: Handler = async (backend, request) => {
  const a = await authed(backend, request);
  if (a instanceof Response) return a;
  const { id, role, isAdmin: admin, reportingPermission } = a.actor;
  return json(200, { id, role, is_admin: !!admin, reporting_permission: !!reportingPermission });
};
