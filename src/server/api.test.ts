import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionHandler,
  bulkApproveHandler,
  clustersHandler,
  createRequestHandler,
  eventsHandler,
  getRequestHandler,
  intradayHandler,
  kpiExportHandler,
  kpiSummaryHandler,
  listHandler,
  markReadHandler,
  metricsHandler,
  notificationsHandler,
  queueHandler,
  updateRequestHandler,
} from "./api.ts";
import { makeBackend, type ApprovalGate, type Backend } from "./backend.ts";
import { MemoryStore } from "./memory.ts";
import type { Actor } from "../domain/requests/workflow.ts";

const actors: Record<string, Actor> = {
  pic1: { id: "pic1", role: "ops_pic", active: true },
  pic2: { id: "pic2", role: "ops_pic", active: true },
  ops1: { id: "ops1", role: "fte_ops", active: true },
  ops2: { id: "ops2", role: "fte_ops", active: true },
  mm1: { id: "mm1", role: "fte_mm", active: true },
  doc1: { id: "doc1", role: "doc_officer", active: true },
  rep1: { id: "rep1", role: "doc_officer", active: true, reportingPermission: true },
  adm1: { id: "adm1", role: "fte_ops", active: true, isAdmin: true },
};
const openGate: ApprovalGate = { authorizeWebApproval: async () => ({ ok: true }) };

function setup(over: Partial<Backend> = {}) {
  const store = new MemoryStore();
  let t = Date.parse("2026-10-19T10:00:00Z");
  const backend = makeBackend({
    store,
    authenticate: async (req) => actors[req.headers.get("authorization")?.replace("Bearer ", "") ?? ""] ?? null,
    approvalGate: openGate,
    now: () => new Date((t += 60_000)),
    ...over,
  });
  store.now = backend.now;
  return { store, backend };
}

let seq = 0;
const call = async (
  backend: Backend | null, handler: (b: Backend | null, r: Request, p?: Record<string, string>) => Promise<Response>, who: string | null, method: string, url: string,
  body?: unknown, params?: Record<string, string>, headers: Record<string, string> = {},
) => {
  const h: Record<string, string> = { "content-type": "application/json", ...headers };
  if (who) h.authorization = `Bearer ${who}`;
  if (method !== "GET" && !("idempotency-key" in h)) h["idempotency-key"] = `key-${++seq}-${Math.random().toString(36).slice(2)}`;
  const res: Response = await handler(backend, new Request(`http://t${url}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), params);
  const text = await res.text();
  let parsed: unknown = null; try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON (csv) */ }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: parsed as Record<string, any>, headers: res.headers, text };
};

const good = { cluster: "C1", region: "NCR", dock_no: "D1", backlogs: 4, truck_size: "4W", truck_type: "WETLEASE" };
const create = async (b: Backend, who = "pic1") => (await call(b, createRequestHandler, who, "POST", "/api/v1/requests", good)).body.request as { id: string };
const act = (b: Backend, who: string, id: string, action: string, body: unknown = {}, headers = {}) =>
  call(b, actionHandler, who, "POST", `/api/v1/requests/${id}/${action}`, body, { id, action }, headers);

test("401 without/invalid token; 503 when backend unconfigured; secure headers", async () => {
  const { backend } = setup();
  assert.equal((await call(backend, queueHandler, null, "GET", "/q")).status, 401);
  assert.equal((await call(backend, queueHandler, "bogus", "GET", "/q")).status, 401);
  const r = await call(null, queueHandler, "pic1", "GET", "/q");
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});

test("create: 201, server-derived creator, validation, role gate, idempotency key required", async () => {
  const { backend, store } = setup();
  const r = await call(backend, createRequestHandler, "pic1", "POST", "/api/v1/requests", { ...good });
  assert.equal(r.status, 201);
  assert.equal(r.body.request.status, "PENDING");
  assert.equal(r.body.request.created_by, "pic1");
  assert.equal(store.eventLog.length, 1);
  assert.equal(store.notificationLog[0].recipientRole, "fte_ops");
  // client cannot inject provenance/status
  assert.equal((await call(backend, createRequestHandler, "pic1", "POST", "/x", { ...good, created_by: "evil" })).status, 422);
  assert.equal((await call(backend, createRequestHandler, "pic1", "POST", "/x", { ...good, status: "DOCKED" })).status, 422);
  assert.equal((await call(backend, createRequestHandler, "pic1", "POST", "/x", { ...good, backlogs: -1 })).status, 422);
  assert.equal((await call(backend, createRequestHandler, "mm1", "POST", "/x", good)).status, 403);
  assert.equal((await call(backend, createRequestHandler, "pic1", "POST", "/x", good, undefined, { "idempotency-key": "short" })).status, 400);
  assert.equal((await call(backend, createRequestHandler, "pic1", "POST", "/x", good, undefined, { "idempotency-key": "k".repeat(201) })).status, 400);
  // unregistered cluster reference rejected (HUB-6); free text accepted
  assert.equal((await call(backend, createRequestHandler, "pic1", "POST", "/x", { ...good, cluster_id: "11111111-1111-1111-1111-111111111111" })).status, 422);
});

test("idempotency (OPS-4): replay original, reject conflicting payload, no duplicate effects", async () => {
  const { backend, store } = setup();
  const headers = { "idempotency-key": "same-key-0001" };
  const a = await call(backend, createRequestHandler, "pic1", "POST", "/x", good, undefined, headers);
  const b = await call(backend, createRequestHandler, "pic1", "POST", "/x", good, undefined, headers);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.deepEqual(b.body, a.body, "original result replayed");
  assert.equal(store.requests.size, 1);
  assert.equal(store.eventLog.length, 1);
  assert.equal(store.notificationLog.length, 1);
  const c = await call(backend, createRequestHandler, "pic1", "POST", "/x", { ...good, backlogs: 99 }, undefined, headers);
  assert.equal(c.status, 409);
  assert.equal(c.body.error, "IDEMPOTENCY_CONFLICT");
  // scoped per actor: another actor's identical key is independent
  const d = await call(backend, createRequestHandler, "ops1", "POST", "/x", good, undefined, headers);
  assert.equal(d.status, 201);
  // expires after 24h
  store.now = () => new Date("2026-10-21T00:00:00Z");
  const e = await call(backend, createRequestHandler, "pic1", "POST", "/x", good, undefined, headers);
  assert.equal(e.status, 201);
  assert.equal(store.requests.size, 3, "expired key no longer replays");
});

test("authorization precedes replay: a forbidden actor cannot read a replay", async () => {
  const { backend } = setup();
  const r = await create(backend);
  const headers = { "idempotency-key": "approve-key-1" };
  assert.equal((await act(backend, "ops1", r.id, "approve", {}, headers)).status, 200);
  assert.equal((await act(backend, "pic1", r.id, "approve", {}, headers)).status, 403);
  assert.equal((await act(backend, "ops1", r.id, "approve", {}, headers)).status, 200, "owner replay ok");
});

test("SEA-1: approval is refused (503) while the SeaTalk gate is disabled; no bypass", async () => {
  const { backend, store } = setup({ approvalGate: undefined as never });
  const b2 = makeBackend({ store, authenticate: backend.authenticate });
  const r = await create(b2);
  const out = await act(b2, "ops1", r.id, "approve");
  assert.equal(out.status, 503);
  assert.equal(out.body.error, "APPROVAL_PROVIDER_DISABLED");
  assert.equal(store.requests.get(r.id)?.status, "PENDING", "approval stays pending");
  assert.equal((await call(b2, bulkApproveHandler, "ops1", "POST", "/b", { ids: [r.id] })).body.failed[0].error, "APPROVAL_PROVIDER_DISABLED");
  // rejection does not approve anything and remains available
  assert.equal((await act(b2, "ops1", r.id, "reject-ops", { rejection_remarks: "bad" })).status, 200);
});

test("full five-stage flow over HTTP handlers with role/ownership enforcement", async () => {
  const { backend, store } = setup();
  const { id } = await create(backend);
  assert.equal((await act(backend, "ops1", id, "approve")).body.request.status, "REQUESTED");
  assert.equal((await act(backend, "ops1", id, "approve")).status, 409, "double approve is a conflict");
  assert.equal((await act(backend, "doc1", id, "mark-docked", { driver_id: "1" })).status, 409, "driver before truck");
  const truck = await act(backend, "mm1", id, "assign-truck", { plate_number: "abc 123", truck_size: "6W", truck_type: "DRYLEASE", provide_time: "2000-01-01T00:00:00Z" });
  assert.equal(truck.status, 200);
  assert.equal(truck.body.request.status, "DOCKING");
  assert.equal(truck.body.request.display_status, "ASSIGNED", "FTE MM label");
  assert.notEqual(truck.body.request.provide_time, "2000-01-01T00:00:00.000Z", "provide_time is server-side");
  assert.equal((await act(backend, "pic1", id, "mark-docked", { linehaul_trip_no: "T-1" })).body.error, "NO_DRIVER_ASSIGNED");
  assert.equal((await act(backend, "doc1", id, "mark-docked", { driver_id: "x1" })).status, 422);
  const drv = await act(backend, "doc1", id, "mark-docked", { driver_id: "12345" });
  assert.equal(drv.body.request.status, "DOCKING");
  assert.equal((await act(backend, "doc1", id, "assign-driver", { driver_id: "9" })).status, 409);
  assert.equal((await act(backend, "doc1", id, "reassign-driver", { driver_id: "9" })).status, 200);
  assert.equal((await act(backend, "pic2", id, "mark-docked", { linehaul_trip_no: "T-1" })).status, 404, "non-creator Ops PIC cannot even see it");
  const done = await act(backend, "pic1", id, "mark-docked", { linehaul_trip_no: "T-1" });
  assert.equal(done.body.request.status, "DOCKED");
  assert.equal(store.eventLog.map((e) => e.type).join(), "REQUEST_CREATED,REQUEST_APPROVED,TRUCK_ASSIGNED,DRIVER_ASSIGNED,DRIVER_REASSIGNED,TRUCK_DOCKED");
  // visibility
  assert.equal((await call(backend, getRequestHandler, "pic2", "GET", `/r/${id}`, undefined, { id })).status, 404, "no existence oracle");
  assert.equal((await call(backend, getRequestHandler, "doc1", "GET", `/r/${id}`, undefined, { id })).status, 200);
  const ev = await call(backend, eventsHandler, "pic1", "GET", `/r/${id}/events`, undefined, { id });
  assert.equal(ev.body.data.length, 6);
  assert.equal(ev.body.data[0].type, "TRUCK_DOCKED", "newest first");
  // post-dock edit keeps DOCKED and audits before/after
  const edit = await call(backend, updateRequestHandler, "pic1", "PUT", `/r/${id}`, { ...good, dock_no: "D9" }, { id });
  assert.equal(edit.body.request.status, "DOCKED");
  assert.equal(edit.body.request.dock_no, "D9");
  assert.equal((store.eventLog.at(-1)!.metadata as { changes: { dockNo: unknown } }).changes.dockNo !== undefined, true);
});

test("APR-3 over HTTP: final FTE Ops rejection cannot be edited, cancelled or queued", async () => {
  const { backend } = setup();
  const { id } = await create(backend, "ops1");
  assert.equal((await act(backend, "ops1", id, "reject-ops", {})).status, 422, "remarks required");
  assert.equal((await act(backend, "ops1", id, "reject-ops", { rejection_remarks: "x", return_role: "ops_pic" })).status, 422, "client route fields refused");
  const rej = await act(backend, "ops2", id, "reject-ops", { rejection_remarks: "duplicate" });
  assert.equal(rej.body.request.rejection_disposition, "FINAL_NO_ROUTE");
  assert.equal(rej.body.request.next_action_role, null);
  for (const who of ["ops1", "ops2", "pic1", "mm1", "adm1"]) {
    const put = await call(backend, updateRequestHandler, who, "PUT", `/r/${id}`, good, { id });
    assert.ok([403, 404, 409].includes(put.status), `${who} edit -> ${put.status}`);
    assert.equal((await act(backend, who, id, "cancel", {})).status >= 400, true);
  }
  for (const who of ["ops1", "ops2", "pic1", "mm1", "doc1"]) {
    const q = await call(backend, queueHandler, who, "GET", "/q");
    assert.equal(q.body.data.some((r: { id: string }) => r.id === id), false, `${who} queue`);
  }
  const m = await call(backend, metricsHandler, "ops1", "GET", "/m");
  assert.equal(m.body.awaiting_action, 0);
  assert.equal(m.body.by_status.REJECTED, 1, "retained in history/reporting");
  const hist = await call(backend, listHandler, "ops1", "GET", "/l?status=REJECTED");
  assert.equal(hist.body.data.length, 1);
  assert.equal(hist.body.data[0].rejection_disposition, "FINAL_NO_ROUTE");
});

test("APR-3 routed rejections: Ops PIC creator corrects; FTE MM returns to FTE Ops", async () => {
  const { backend } = setup();
  const { id } = await create(backend, "pic1");
  await act(backend, "ops1", id, "reject-ops", { rejection_remarks: "fix cluster" });
  assert.equal((await call(backend, queueHandler, "pic1", "GET", "/q")).body.data.length, 1);
  assert.equal((await call(backend, queueHandler, "pic2", "GET", "/q")).body.data.length, 0);
  assert.equal((await call(backend, updateRequestHandler, "pic2", "PUT", `/r/${id}`, good, { id })).status, 404);
  const fixed = await call(backend, updateRequestHandler, "pic1", "PUT", `/r/${id}`, { ...good, backlogs: 7 }, { id });
  assert.equal(fixed.body.request.status, "PENDING");
  assert.equal(fixed.body.request.approval_version, 2);
  await act(backend, "ops1", id, "approve");
  const rej = await act(backend, "mm1", id, "reject-mm", { rejection_remarks: "no trucks" });
  assert.equal(rej.body.request.rejection_disposition, "RETURN_TO_FTE_OPS");
  assert.equal((await call(backend, queueHandler, "ops2", "GET", "/q")).body.data.length, 1);
  assert.equal((await call(backend, updateRequestHandler, "ops2", "PUT", `/r/${id}`, good, { id })).body.request.status, "PENDING");
  // legacy alias of the earlier route
  const { id: id2 } = await create(backend, "pic1");
  assert.equal((await act(backend, "ops1", id2, "reject", { rejection_remarks: "x" })).status, 200);
});

test("cancel rules over HTTP: FTE MM needs remarks", async () => {
  const { backend } = setup();
  const { id } = await create(backend);
  await act(backend, "ops1", id, "approve");
  assert.equal((await act(backend, "mm1", id, "cancel", {})).status, 422);
  assert.equal((await act(backend, "mm1", id, "cancel", { cancellation_remarks: "no capacity" })).body.request.status, "CANCELLED");
});

test("queue: only 25/50/100, opaque cursor pagination without gaps/duplicates, role scoping", async () => {
  const { backend } = setup();
  for (let i = 0; i < 60; i++) await create(backend, i % 2 ? "pic1" : "pic2");
  for (const bad of ["10", "101", "abc", "0", "-1", "1000"]) {
    assert.equal((await call(backend, queueHandler, "ops1", "GET", `/q?limit=${bad}`)).status, 422, bad);
  }
  assert.equal((await call(backend, queueHandler, "ops1", "GET", "/q?cursor=not-a-cursor")).status, 422);
  const seen: string[] = [];
  let cursor = "";
  for (let i = 0; i < 5; i++) {
    const p = await call(backend, queueHandler, "ops1", "GET", `/q?limit=25${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(p.status, 200);
    seen.push(...p.body.data.map((r: { id: string }) => r.id));
    if (!p.body.has_more) break;
    cursor = p.body.next_cursor;
  }
  assert.equal(seen.length, 60);
  assert.equal(new Set(seen).size, 60);
  assert.equal((await call(backend, queueHandler, "ops1", "GET", "/q?limit=100")).body.data.length, 60);
  assert.equal((await call(backend, queueHandler, "doc1", "GET", "/q")).body.data.length, 0);
  // Ops PIC list is creator-scoped
  assert.equal((await call(backend, listHandler, "pic1", "GET", "/l?limit=100")).body.data.length, 30);
});

test("notifications: role + user targeting, per-user read receipts, ineligible recipients denied", async () => {
  const { backend } = setup();
  const { id } = await create(backend, "pic1");
  const n1 = await call(backend, notificationsHandler, "ops1", "GET", "/n");
  assert.equal(n1.body.unread, 1);
  assert.equal((await call(backend, notificationsHandler, "mm1", "GET", "/n")).body.data.length, 0);
  assert.equal((await call(backend, markReadHandler, "mm1", "PATCH", "/n", undefined, { id: n1.body.data[0].id })).status, 404, "not an eligible recipient");
  await call(backend, markReadHandler, "ops1", "PATCH", "/n", undefined, { id: n1.body.data[0].id });
  assert.equal((await call(backend, notificationsHandler, "ops1", "GET", "/n")).body.unread, 0);
  assert.equal((await call(backend, notificationsHandler, "ops2", "GET", "/n")).body.unread, 1, "read receipts are per user");
  await act(backend, "ops1", id, "approve");
  assert.equal((await call(backend, notificationsHandler, "pic1", "GET", "/n")).body.data.some((n: { event: string }) => n.event === "REQUEST_APPROVED"), true);
});

test("KPI + exports require the reporting permission, independent of role (KPI-6); intraday for all four roles (HUB-5)", async () => {
  const { backend, store } = setup();
  const { id } = await create(backend, "pic1");
  await act(backend, "ops1", id, "approve");
  for (const who of ["pic1", "ops1", "mm1", "doc1", "adm1"]) {
    assert.equal((await call(backend, kpiSummaryHandler, who, "GET", "/k")).status, 403, who);
    assert.equal((await call(backend, kpiExportHandler, who, "GET", "/k")).status, 403, who);
  }
  const k = await call(backend, kpiSummaryHandler, "rep1", "GET", "/k");
  assert.equal(k.status, 200);
  assert.equal(k.body.total, 1);
  assert.ok(k.body.averageApprovalMinutes > 0, "approval minutes use latest submission");
  const csv = await call(backend, kpiExportHandler, "rep1", "GET", "/k");
  assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
  assert.equal(csv.text.split("\r\n")[0].startsWith("id,request_timestamp"), true);
  assert.equal((await call(backend, kpiSummaryHandler, "rep1", "GET", "/k?date_from=2026-13-01")).status, 422);
  store.dispatch.set("2026-10-19", [{ hour: 7, orderQty: 12, syncedAt: null }]);
  for (const who of ["pic1", "ops1", "mm1", "doc1"]) {
    const d = await call(backend, intradayHandler, who, "GET", "/d?date=2026-10-19");
    assert.equal(d.status, 200);
    assert.equal(d.body.data.length, 24);
    assert.equal(d.body.data[7].orderQty, 12);
  }
  assert.equal((await call(backend, intradayHandler, "pic1", "GET", "/d?date=bad")).status, 422);
});

test("clusters search bounds; bulk approve limits and FTE Ops only", async () => {
  const { backend, store } = setup();
  store.clusters.push({ id: "c1", name: "Alpha Cluster", hub: null, region: "R", dockNo: "1", backlogs: 0, active: true });
  assert.equal((await call(backend, clustersHandler, "pic1", "GET", "/c?search=al")).status, 422);
  assert.equal((await call(backend, clustersHandler, "pic1", "GET", "/c?search=alpha")).body.data.length, 1);
  const a = await create(backend), b = await create(backend);
  assert.equal((await call(backend, bulkApproveHandler, "mm1", "POST", "/b", { ids: [a.id] })).status, 403);
  assert.equal((await call(backend, bulkApproveHandler, "ops1", "POST", "/b", { ids: [] })).status, 422);
  assert.equal((await call(backend, bulkApproveHandler, "ops1", "POST", "/b", { ids: [a.id, a.id] })).status, 422);
  const ok = await call(backend, bulkApproveHandler, "ops1", "POST", "/b", { ids: [a.id, b.id, "11111111-1111-1111-1111-111111111111"] });
  assert.equal(ok.body.data.length, 2);
  assert.equal(ok.body.failed[0].error, "NOT_FOUND");
});

test("admin override: requires admin, justification, strong identity verification; audited", async () => {
  const verified = { verifyStrongIdentity: async () => true };
  const { backend, store } = setup({ identity: verified });
  const { id } = await create(backend);
  await act(backend, "ops1", id, "approve");
  // non-admin cannot use the header
  assert.equal((await act(backend, "mm1", id, "assign-truck", { plate_number: "A1", truck_size: "4W", truck_type: "WETLEASE" }, { "x-admin-override": "because", "x-override-role": "fte_mm" })).status, 403);
  const o = await act(backend, "adm1", id, "assign-truck", { plate_number: "A1", truck_size: "4W", truck_type: "WETLEASE" }, { "x-admin-override": "MM on leave", "x-override-role": "fte_mm" });
  assert.equal(o.status, 200);
  const meta = store.eventLog.at(-1)!.metadata as { override: { by: string; justification: string } };
  assert.equal(meta.override.by, "adm1");
  assert.equal(meta.override.justification, "MM on leave");
  // default verifier denies => override unavailable until configured
  const { backend: b2 } = setup();
  const r2 = await create(b2);
  await act(b2, "ops1", r2.id, "approve");
  assert.equal((await act(b2, "adm1", r2.id, "assign-truck", { plate_number: "A1", truck_size: "4W", truck_type: "WETLEASE" }, { "x-admin-override": "x", "x-override-role": "fte_mm" })).status, 403);
  // an override still obeys workflow validation
  assert.equal((await act(backend, "adm1", id, "assign-truck", { plate_number: "A2", truck_size: "4W", truck_type: "WETLEASE" }, { "x-admin-override": "retry", "x-override-role": "fte_mm" })).status, 409);
});

test("concurrent identical commands commit exactly once", async () => {
  const { backend, store } = setup();
  const { id } = await create(backend);
  const key = { "idempotency-key": "race-key-0001" };
  const results = await Promise.all([1, 2, 3, 4].map(() => act(backend, "ops1", id, "approve", {}, key)));
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200]);
  assert.equal(store.eventLog.filter((e) => e.type === "REQUEST_APPROVED").length, 1);
  // different keys racing: exactly one wins, the rest conflict
  const { backend: b2, store: s2 } = setup();
  const r2 = await create(b2);
  const racing = await Promise.all([1, 2, 3].map(() => act(b2, "ops1", r2.id, "approve")));
  assert.equal(racing.filter((r) => r.status === 200).length, 1);
  assert.equal(racing.filter((r) => r.status === 409).length, 2);
  assert.equal(s2.eventLog.filter((e) => e.type === "REQUEST_APPROVED").length, 1);
});

test("malformed JSON and unknown routes are handled safely", async () => {
  const { backend } = setup();
  const res = await actionHandler(backend, new Request("http://t/x", { method: "POST", headers: { authorization: "Bearer pic1", "idempotency-key": "badjson-0001" }, body: "{not json" }), { id: "11111111-1111-1111-1111-111111111111", action: "cancel" });
  assert.equal(res.status, 400);
  const { id } = await create(backend);
  assert.equal((await act(backend, "ops1", id, "teleport")).status, 404);
  assert.equal((await act(backend, "ops1", "not-a-uuid", "approve")).status, 404);
});
