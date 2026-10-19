import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterSyncHandler, parseClusterRows } from "./cluster-sync.ts";
import { createRequestHandler, notificationsHandler, markReadHandler, clustersHandler, updateRequestHandler } from "./api.ts";
import { makeBackend, type Backend } from "./backend.ts";
import { MemoryStore } from "./memory.ts";
import { signSync } from "./seatalk/contract.ts";
import { parseBacklogInstant, parseRequestDetails } from "../domain/requests/validation.ts";
import type { Actor } from "../domain/requests/workflow.ts";

const SECRET = "cluster-sync-secret";
const NOW = new Date("2026-10-19T10:00:00Z");
const actors: Record<string, Actor> = {
  pic1: { id: "pic1", role: "ops_pic", active: true },
  ops1: { id: "ops1", role: "fte_ops", active: true },
};
function setup() {
  const store = new MemoryStore();
  store.now = () => NOW;
  const backend = makeBackend({
    store, now: () => NOW, clusterSyncSecret: SECRET,
    authenticate: async (r) => actors[r.headers.get("authorization")?.replace("Bearer ", "") ?? ""] ?? null,
  });
  return { store, backend };
}
function syncRequest(rows: unknown, over: { secret?: string; source?: string | null; ts?: string; raw?: string } = {}) {
  const raw = over.raw ?? JSON.stringify(rows);
  const ts = over.ts ?? String(Math.floor(NOW.getTime() / 1000));
  const headers: Record<string, string> = { "x-sync-timestamp": ts, "x-sync-signature": signSync(over.secret ?? SECRET, ts, raw) };
  if (over.source !== null) headers["x-sync-source"] = over.source ?? "google-apps-script";
  return new Request("http://t/api/v1/integrations/clusters/sync", { method: "POST", headers, body: raw });
}
const row = (over: Record<string, unknown> = {}) => ({ cluster_name: "Alpha Hub", region: "NCR", dock_number: "7", backlogs: 40, backlogs_ts: "2026-10-19T08:30:15Z", ...over });
const good = { cluster: "Alpha Hub", region: "NCR", dock_no: "7", backlogs: 4, truck_size: "4W", truck_type: "WETLEASE" };

test("backlog instants keep the time of day: ISO offset, zone-less business time, bare date; reject impossible values", () => {
  assert.equal(parseBacklogInstant("2026-10-19T08:30:15Z"), "2026-10-19T08:30:15.000Z");
  assert.equal(parseBacklogInstant("2026-10-19T16:30:15+08:00"), "2026-10-19T08:30:15.000Z");
  assert.equal(parseBacklogInstant("2026-10-19 16:30"), "2026-10-19T08:30:00.000Z", "zone-less values are Asia/Manila wall-clock time");
  assert.equal(parseBacklogInstant("2026-10-19"), "2026-10-18T16:00:00.000Z", "bare date = start of the business day");
  for (const bad of ["2026-02-30T10:00:00Z", "2026-10-19T25:00:00Z", "yesterday", "", "2026-10-19T10:00:00+99", "2026-13-01"]) {
    assert.equal(parseBacklogInstant(bad), null, bad);
  }
  const r = parseRequestDetails({ ...good, backlogs_timestamp: "2026-10-19T16:30:15+08:00" });
  assert.equal(r.ok && r.value.backlogsTimestamp, "2026-10-19T08:30:15.000Z");
  assert.equal(parseRequestDetails({ ...good, backlogs_timestamp: "nope" }).ok, false);
});

test("backlog date/time survives create -> read -> edit through the API unchanged", async () => {
  const { backend, store } = setup();
  const res = await createRequestHandler(backend, new Request("http://t/r", { method: "POST", headers: { authorization: "Bearer pic1", "content-type": "application/json", "idempotency-key": "key-backlog-1" }, body: JSON.stringify({ ...good, backlogs_timestamp: "2026-10-19T16:30:15+08:00" }) }));
  assert.equal(res.status, 201);
  const created = (await res.json()).request;
  assert.equal(created.backlogs_timestamp, "2026-10-19T08:30:15.000Z");
  assert.equal(store.requests.get(created.id)!.backlogsTimestamp, "2026-10-19T08:30:15.000Z");
  const upd = await updateRequestHandler(backend, new Request("http://t/r", { method: "PUT", headers: { authorization: "Bearer ops1", "content-type": "application/json", "idempotency-key": "key-backlog-2" }, body: JSON.stringify({ ...good, backlogs: 5, backlogs_timestamp: "2026-10-19T17:45:00+08:00" }) }), { id: created.id });
  assert.equal(upd.status, 200);
  assert.equal((await upd.json()).request.backlogs_timestamp, "2026-10-19T09:45:00.000Z");
});

test("cluster sync: signature, source header, size/row limits, validation, last-duplicate-wins, atomic import", async () => {
  const { backend, store } = setup();
  assert.equal((await clusterSyncHandler(backend, syncRequest([row()], { secret: "wrong" }))).status, 401);
  assert.equal((await clusterSyncHandler(backend, syncRequest([row()], { source: null }))).status, 403);
  assert.equal((await clusterSyncHandler(backend, syncRequest([row()], { source: "browser" }))).status, 403);
  assert.equal((await clusterSyncHandler(backend, syncRequest([row()], { ts: String(Math.floor(NOW.getTime() / 1000) - 301) }))).status, 401, "stale");
  assert.equal((await clusterSyncHandler(backend, syncRequest("{not json", { raw: "{not json" }))).status, 400);
  assert.equal((await clusterSyncHandler(backend, syncRequest({ nope: 1 }))).status, 400);
  assert.equal((await clusterSyncHandler(backend, syncRequest(Array.from({ length: 1001 }, () => row())))).status, 413);
  assert.equal((await clusterSyncHandler(backend, syncRequest([{ cluster_name: "", region: "x" }]))).status, 422, "no valid rows");
  assert.equal((await clusterSyncHandler(makeBackend({ store, authenticate: async () => null }), syncRequest([row()]))).status, 503, "no secret configured = disabled");
  const ok = await clusterSyncHandler(backend, syncRequest([row({ backlogs: 1 }), row({ backlogs: 2 }), row({ cluster_name: "No Dock", dock_number: null, backlogs: "", backlogs_ts: "" }), row({ cluster_name: "Bad", backlogs: -3 }), row({ cluster_name: "Bad TS", backlogs_ts: "not a date" })]));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { success: true, received: 5, processed: 2, rejected: 2, duplicatesRemoved: 1, fields: ["cluster_name", "region", "dock_number", "backlogs", "backlogs_ts"] });
  const alpha = store.clusters.find((c) => c.name === "Alpha Hub")!;
  assert.equal(alpha.backlogs, 2, "last duplicate wins");
  assert.equal(alpha.backlogsTimestamp, "2026-10-19T08:30:15.000Z");
  assert.equal(store.clusters.find((c) => c.name === "No Dock")!.dockNo, null);
});

test("backlog propagation: matching open requests follow the cluster (audited, versioned); terminal and unrelated untouched", async () => {
  const { backend, store } = setup();
  const make = async (cluster: string) => {
    const r = await createRequestHandler(backend, new Request("http://t/r", { method: "POST", headers: { authorization: "Bearer pic1", "content-type": "application/json", "idempotency-key": `k-${crypto.randomUUID()}` }, body: JSON.stringify({ ...good, cluster }) }));
    return (await r.json()).request.id as string;
  };
  const a = await make("Alpha Hub");
  const b = await make("Beta Hub");
  const c = await make("Alpha Hub");
  store.requests.set(c, { ...store.requests.get(c)!, status: "CANCELLED", approvalStatus: "CANCELLED" });
  const v0 = store.requests.get(a)!.rowVersion;
  await clusterSyncHandler(backend, syncRequest([row({ backlogs: 90, backlogs_ts: "2026-10-19T09:00:00Z" })]));
  assert.equal(store.requests.get(a)!.backlogs, 90);
  assert.equal(store.requests.get(a)!.backlogsTimestamp, "2026-10-19T09:00:00.000Z");
  assert.equal(store.requests.get(a)!.rowVersion, v0 + 1);
  assert.equal(store.requests.get(b)!.backlogs, 4, "other clusters untouched");
  assert.equal(store.requests.get(c)!.backlogs, 4, "terminal rows are immutable");
  const events = store.eventLog.filter((e) => e.type === "BACKLOG_PROPAGATED");
  assert.equal(events.length, 1);
  assert.deepEqual((events[0].metadata as { changes: { backlogs: unknown } }).changes.backlogs, { before: 4, after: 90 });
  await clusterSyncHandler(backend, syncRequest([row({ backlogs: 90, backlogs_ts: "2026-10-19T09:00:00Z" })]));
  assert.equal(store.eventLog.filter((e) => e.type === "BACKLOG_PROPAGATED").length, 1, "re-import is idempotent");
});

test("cluster lookup returns the backlog timestamp and matches hub names too", async () => {
  const { backend, store } = setup();
  await clusterSyncHandler(backend, syncRequest([row()]));
  const res = await clustersHandler(backend, new Request("http://t/c?search=alpha", { headers: { authorization: "Bearer pic1" } }));
  assert.deepEqual((await res.json()).data[0], { id: store.clusters[0].id, cluster_name: "Alpha Hub", hub_name: "Alpha Hub", region: "NCR", dock_number: "7", backlogs: 40, backlogs_ts: "2026-10-19T08:30:15.000Z" });
});

test("notifications: unread counts every visible notice, pages with limit/before, mark-all covers beyond the first page", async () => {
  const { backend, store } = setup();
  let t = NOW.getTime();
  store.now = () => new Date((t += 1000));
  for (let i = 0; i < 7; i++) {
    await createRequestHandler(backend, new Request("http://t/r", { method: "POST", headers: { authorization: "Bearer pic1", "content-type": "application/json", "idempotency-key": `k-${i}-${crypto.randomUUID()}` }, body: JSON.stringify(good) }));
  }
  const get = async (q: string) => (await notificationsHandler(backend, new Request(`http://t/n${q}`, { headers: { authorization: "Bearer ops1" } }))).json();
  const p1 = await get("?limit=3");
  assert.equal(p1.data.length, 3);
  assert.equal(p1.unread, 7, "unread is not limited to the page");
  assert.equal(p1.has_more, true);
  const p2 = await get(`?limit=3&before=${encodeURIComponent(p1.data[2].created_at)}`);
  assert.equal(p2.data.length, 3);
  assert.equal(p2.data.some((n: { id: string }) => p1.data.some((m: { id: string }) => m.id === n.id)), false, "no overlap between pages");
  assert.equal((await notificationsHandler(backend, new Request("http://t/n?limit=0", { headers: { authorization: "Bearer ops1" } }))).status, 422);
  assert.equal((await notificationsHandler(backend, new Request("http://t/n?before=zzz", { headers: { authorization: "Bearer ops1" } }))).status, 422);
  await markReadHandler(backend, new Request("http://t/n/all", { method: "PATCH", headers: { authorization: "Bearer ops1", "idempotency-key": "k-readall-1" } }), { id: "all" });
  assert.equal((await get("?limit=3")).unread, 0, "mark-all covers notices outside the first page");
  const pic = await (await notificationsHandler(backend, new Request("http://t/n", { headers: { authorization: "Bearer pic1" } }))).json();
  assert.equal(pic.unread, 0, "ops_pic has no role-wide notices here");
  void (null as unknown as Backend);
});

test("parseClusterRows is a pure validator", () => {
  const out = parseClusterRows([row(), row({ backlogs: 3 }), null, 5, { cluster_name: "x" }]);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].backlogs, 3);
  assert.equal(out.rejected, 3);
  assert.equal(out.duplicatesRemoved, 1);
});
