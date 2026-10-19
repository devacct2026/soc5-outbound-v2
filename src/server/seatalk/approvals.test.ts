import { test } from "node:test";
import assert from "node:assert/strict";
import { actionHandler, createRequestHandler, heartbeatHandler } from "../api.ts";
import { createSeatalkApprovalGate, makeBackend, type Backend } from "../backend.ts";
import { MemoryStore } from "../memory.ts";
import type { Actor } from "../../domain/requests/workflow.ts";
import { ApprovalCoordinator } from "./approvals.ts";
import { MemoryApprovalPort } from "./approvals-ports.ts";
import { MemoryApprovalStore } from "./memory.ts";
import { reconcileApprovals } from "./reconcile.ts";
import { approvalToken, buildCreateBody, createSeaTalkProvider, DEFAULT_SEATALK_PATHS, itemIdFor, SeaTalkProviderError, type ApprovalItemInput, type ApprovalProvider, type ProviderItem } from "./provider.ts";
import { sha256 } from "./contract.ts";

const T0 = Date.parse("2026-10-19T10:00:00Z");
const SECRET = "x".repeat(40);
const actors: Record<string, Actor> = {
  pic1: { id: "pic1", role: "ops_pic", active: true },
  ops1: { id: "ops1", role: "fte_ops", active: true },
  ops2: { id: "ops2", role: "fte_ops", active: true },
  mm1: { id: "mm1", role: "fte_mm", active: true },
};

class FakeProvider implements ApprovalProvider {
  created: ApprovalItemInput[] = [];
  items = new Map<string, ProviderItem>();
  failCreate = 0;
  failGet = false;
  async createItem(i: ApprovalItemInput) {
    if (this.failCreate > 0) {
      this.failCreate--;
      throw new SeaTalkProviderError("TRANSIENT", "boom");
    }
    this.created.push(i);
    if (!this.items.has(i.itemId)) this.items.set(i.itemId, { itemId: i.itemId, state: 0, approved: [], rejected: [], comments: {} });
  }
  async getItem(id: string) {
    if (this.failGet) throw new SeaTalkProviderError("TRANSIENT", "outage");
    const it = this.items.get(id);
    if (!it) throw new SeaTalkProviderError("VALIDATION", "unknown item");
    return it;
  }
}

function setup(syncMode: "off" | "recreate" = "off") {
  let now = T0;
  const clock = { now: () => new Date(now) };
  const store = new MemoryStore();
  store.now = clock.now;
  const port = new MemoryApprovalPort();
  port.approvers = [
    { id: "ops1", name: "Olivia Ops", employeeCode: "E1", role: "fte_ops", active: true, lastSeenAt: null },
    { id: "ops2", name: "Omar Ops", employeeCode: "E2", role: "fte_ops", active: true, lastSeenAt: null },
  ];
  const provider = new FakeProvider();
  const coordinator = new ApprovalCoordinator({
    port, provider, requests: store, clock,
    config: { tokenSecret: SECRET, approveUrl: "https://app.test/api/v1/integrations/seatalk/approval/approve", rejectUrl: "https://app.test/api/v1/integrations/seatalk/approval/reject", syncMode, retrySeconds: 300 },
  });
  const approvals = new MemoryApprovalStore();
  const features = { seatalkApproval: true, seatalkAlerts: false, googleSheets: false };
  const backend: Backend = makeBackend({
    store, now: clock.now, features, approvals: coordinator,
    authenticate: async (r) => actors[r.headers.get("authorization")?.replace("Bearer ", "") ?? ""] ?? null,
    approvalGate: createSeatalkApprovalGate(coordinator, { ...approvals, closeAssignment: async (id: string, st: "APPROVED" | "REJECTED") => { port.rows.find((x) => x.id === id)!.status = st; } } as never),
  });
  const advance = (ms: number) => { now += ms; };
  return { store, port, provider, coordinator, backend, advance, approvals, clock };
}

const call = async (backend: Backend, handler: typeof actionHandler, who: string, method: string, url: string, body?: unknown, params?: Record<string, string>) => {
  const res = await handler(backend, new Request(`http://t${url}`, { method, headers: { authorization: `Bearer ${who}`, "content-type": "application/json", "idempotency-key": `k-${crypto.randomUUID()}` }, body: body === undefined ? undefined : JSON.stringify(body) }), params);
  return { status: res.status, body: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const good = { cluster: "C1", region: "NCR", dock_no: "D1", backlogs: 4, truck_size: "4W", truck_type: "WETLEASE" };
async function newRequest(s: ReturnType<typeof setup>) {
  const r = await call(s.backend, createRequestHandler, "pic1", "POST", "/api/v1/requests", good);
  const id = r.body.request.id as string;
  s.port.routable.set(id, true);
  return id;
}

// ------------------------------------------------------------ provider contract
test("provider: official create payload, bearer token cached and refreshed once on 401, errors classified, no secrets in errors", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let tokenCalls = 0;
  let createStatus = [401, 200];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/auth/app_access_token")) { tokenCalls++; return Response.json({ code: 0, app_access_token: `tok-${tokenCalls}`, expire_in: 7200 }); }
    if (url.endsWith("/approval_center/v2/create")) { const st = createStatus.shift() ?? 200; return st === 200 ? Response.json({ code: 0 }) : new Response("", { status: st }); }
    return Response.json({ code: 0, item: { status: { state: 1 }, approved_list: [{ employee_code: "E1", ts: 5 }], rejected_list: [], approval_chain: { approvers: [{ employee_code: "E1", comment: "ok" }] } } });
  }) as typeof fetch;
  const p = createSeaTalkProvider({ appId: "app", appSecret: "SECRET-VALUE", ...DEFAULT_SEATALK_PATHS, timeoutMs: 1000, baseUrl: "https://openapi.seatalk.io" }, f);
  const input: ApprovalItemInput = {
    itemId: "a_abc", applicantName: "Pat", title: "Truck request AB12", subtitle: "C1 · Dock D1", createdAtSec: 1, updatedAtSec: 2, state: 0,
    approveUrl: "https://app.test/a?token=t", rejectUrl: "https://app.test/r?token=t", pending: [{ employeeCode: "E1", ts: 3 }], approved: [], rejected: [], chain: [],
  };
  await p.createItem(input);
  assert.equal(tokenCalls, 2, "token refreshed exactly once after a 401");
  const create = calls.filter((c) => c.url.endsWith("/create")).at(-1)!;
  assert.equal(create.url, "https://openapi.seatalk.io/approval_center/v2/create");
  assert.equal((create.init.headers as Record<string, string>).authorization, "Bearer tok-2");
  const sent = JSON.parse(create.init.body as string);
  for (const k of ["item_id", "created_at", "updated_at", "applicant_name", "title", "status", "approve_url", "reject_url", "pending_list", "approved_list", "rejected_list"]) assert.ok(k in sent, `official field ${k}`);
  assert.deepEqual(sent.status, { state: 0, text: { en: "Pending" } });
  assert.deepEqual(sent.pending_list, [{ employee_code: "E1", ts: 3 }]);
  const item = await p.getItem("a_abc");
  assert.equal(calls.at(-1)!.url, "https://openapi.seatalk.io/approval_center/v2/get?item_id=a_abc");
  assert.deepEqual([item.state, item.approved[0].employeeCode, item.comments.E1], [1, "E1", "ok"]);
  // Failure classes never leak the secret.
  for (const [status, cat] of [[403, "PERMISSION"], [429, "RATE_LIMIT"], [500, "TRANSIENT"], [400, "VALIDATION"]] as const) {
    createStatus = [status];
    tokenCalls = 0;
    const bad = createSeaTalkProvider({ appId: "app", appSecret: "SECRET-VALUE", ...DEFAULT_SEATALK_PATHS, timeoutMs: 1000, baseUrl: "https://openapi.seatalk.io" }, f);
    await assert.rejects(bad.createItem(input), (e: Error) => e instanceof SeaTalkProviderError && e.category === cat && !e.message.includes("SECRET-VALUE"));
  }
  const codeFail = createSeaTalkProvider({ appId: "a", appSecret: "s", ...DEFAULT_SEATALK_PATHS, timeoutMs: 100, baseUrl: "https://openapi.seatalk.io" }, (async (u: string) => u.endsWith("token") || u.includes("app_access_token") ? Response.json({ code: 0, app_access_token: "t" }) : Response.json({ code: 10001 })) as typeof fetch);
  await assert.rejects(codeFail.createItem(input), (e: Error) => e instanceof SeaTalkProviderError && e.category === "VALIDATION");
  const net = createSeaTalkProvider({ appId: "a", appSecret: "s", ...DEFAULT_SEATALK_PATHS, timeoutMs: 100, baseUrl: "https://openapi.seatalk.io" }, (async () => { throw new Error("ECONNRESET https://openapi.seatalk.io secret"); }) as never);
  await assert.rejects(net.createItem(input), (e: Error) => e instanceof SeaTalkProviderError && e.category === "TRANSIENT" && !/secret|https/.test(e.message));
});

test("provider payload limits: item_id <= 30 chars, https callbacks, <= 100 list entries; text clipped by characters", () => {
  const base: ApprovalItemInput = { itemId: "a", applicantName: "P", title: "T", createdAtSec: 1, updatedAtSec: 1, state: 0, approveUrl: "https://x/a", rejectUrl: "https://x/r", pending: [], approved: [], rejected: [], chain: [] };
  assert.throws(() => buildCreateBody({ ...base, itemId: "x".repeat(31) }), SeaTalkProviderError);
  assert.throws(() => buildCreateBody({ ...base, approveUrl: "http://insecure/a" }), SeaTalkProviderError);
  assert.throws(() => buildCreateBody({ ...base, pending: Array.from({ length: 101 }, (_, i) => ({ employeeCode: `E${i}`, ts: 1 })) }), SeaTalkProviderError);
  const clipped = buildCreateBody({ ...base, title: "é".repeat(150) }) as { title: { en: string } };
  assert.equal(Array.from(clipped.title.en).length, 100);
  assert.equal(itemIdFor(crypto.randomUUID()).length, 30);
});

// ------------------------------------------------------------ presence + routing + provisioning
test("provisioning: nobody present -> skipped; present approver -> item created for them with a verifiable one-time token; idempotent", async () => {
  const s = setup();
  const id = await newRequest(s);
  assert.equal(await s.coordinator.provision(id), "skipped", "no present approver, nothing is faked");
  assert.equal(s.provider.created.length, 0);
  await s.coordinator.heartbeat("ops1");
  assert.equal(await s.coordinator.provision(id), "delivered");
  const item = s.provider.created[0];
  assert.deepEqual(item.pending.map((p) => p.employeeCode), ["E1"]);
  const row = s.port.rows[0];
  const token = new URL(item.approveUrl).searchParams.get("token")!;
  assert.equal(sha256(token), row.tokenHash, "URL token matches the stored hash; the secret never leaves the server");
  assert.equal(token, approvalToken(SECRET, row.id));
  assert.equal(new URL(item.rejectUrl).searchParams.get("token"), token);
  assert.equal(item.itemId, itemIdFor(row.id));
  assert.equal(await s.coordinator.provision(id), "already-delivered");
  assert.equal(s.provider.created.length, 1, "no duplicate items");
});

test("delivery failure: assignment stays open, retry re-delivers the SAME item; no duplicate assignment", async () => {
  const s = setup();
  const id = await newRequest(s);
  await s.coordinator.heartbeat("ops1");
  s.provider.failCreate = 1;
  await assert.rejects(s.coordinator.provision(id), SeaTalkProviderError);
  assert.equal(s.port.rows.length, 1);
  assert.equal(s.port.rows[0].delivered, false);
  assert.equal(await s.coordinator.provision(id), "delivered");
  assert.equal(s.port.rows.length, 1, "retry reuses the open assignment");
  assert.equal(s.provider.created[0].itemId, itemIdFor(s.port.rows[0].id));
});

test("round robin: successive requests rotate across present approvers; stale heartbeats are skipped", async () => {
  const s = setup();
  await s.coordinator.heartbeat("ops1");
  await s.coordinator.heartbeat("ops2");
  const order: string[] = [];
  for (let i = 0; i < 4; i++) {
    const id = await newRequest(s);
    await s.coordinator.provision(id);
    order.push(s.port.rows.find((r) => r.requestId === id)!.assigneeId);
  }
  assert.deepEqual(order, ["ops1", "ops2", "ops1", "ops2"]);
  s.advance(61_000); // ops1's heartbeat is now stale; only ops2 refreshes
  await s.coordinator.heartbeat("ops2");
  const id = await newRequest(s);
  await s.coordinator.provision(id);
  assert.equal(s.port.rows.find((r) => r.requestId === id)!.assigneeId, "ops2");
});

test("expiry + reassignment: an unanswered assignment expires after 180 s and moves to the other present approver, then a new cycle", async () => {
  const s = setup();
  await s.coordinator.heartbeat("ops1");
  await s.coordinator.heartbeat("ops2");
  const id = await newRequest(s);
  await s.coordinator.provision(id);
  assert.equal(s.port.rows[0].assigneeId, "ops1");
  s.advance(100_000);
  assert.deepEqual(await s.coordinator.maintain(), { expired: 0, routed: 0, failed: 0 }, "not due yet");
  s.advance(81_000); // 181 s since assignment
  await s.coordinator.heartbeat("ops1");
  await s.coordinator.heartbeat("ops2");
  const m = await s.coordinator.maintain();
  assert.equal(m.expired, 1);
  assert.equal(m.routed, 1);
  assert.deepEqual(s.port.rows.map((r) => [r.assigneeId, r.status]), [["ops1", "EXPIRED"], ["ops2", "PENDING"]]);
  s.advance(181_000);
  await s.coordinator.heartbeat("ops1");
  await s.coordinator.heartbeat("ops2");
  await s.coordinator.maintain();
  assert.equal(s.port.rows.length, 3, "everyone attempted: a new cycle starts");
  assert.equal(s.port.rows[2].cycle, 2);
});

test("maintenance routes orphaned requests once an approver is present, and skips decided requests", async () => {
  const s = setup();
  const a = await newRequest(s);
  const b = await newRequest(s);
  s.port.routable.set(b, false); // already decided
  assert.deepEqual(await s.coordinator.maintain(), { expired: 0, routed: 0, failed: 0 }, "nobody present");
  await s.coordinator.heartbeat("ops1");
  const m = await s.coordinator.maintain();
  assert.equal(m.routed, 1);
  assert.equal(s.port.rows[0].requestId, a);
});

test("heartbeat endpoint: FTE Ops only, records presence, reports the active window", async () => {
  const s = setup();
  const noSea = makeBackend({ store: s.store, authenticate: s.backend.authenticate });
  assert.equal((await call(noSea, heartbeatHandler as never, "ops1", "POST", "/api/v1/presence/heartbeat")).status, 503);
  for (const who of ["pic1", "mm1"]) assert.equal((await call(s.backend, heartbeatHandler as never, who, "POST", "/api/v1/presence/heartbeat")).status, 403);
  const ok = await call(s.backend, heartbeatHandler as never, "ops1", "POST", "/api/v1/presence/heartbeat");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.active_for_seconds, 60);
  assert.equal(s.port.approvers[0].lastSeenAt, T0);
});

// ------------------------------------------------------------ SEA-1: no internal approval bypass
test("web approve is only the application of a verified SeaTalk decision (never a local bypass)", async () => {
  const s = setup();
  const id = await newRequest(s);
  await s.coordinator.heartbeat("ops1");
  await s.coordinator.provision(id);
  const itemId = s.port.rows[0].itemId;
  const approve = (who: string) => call(s.backend, actionHandler, who, "POST", `/api/v1/requests/${id}/approve`, {}, { id, action: "approve" });
  assert.equal((await approve("ops1")).body.error, "NOT_APPROVED_IN_SEATALK", "SeaTalk has not recorded an approval");
  assert.equal((await approve("ops2")).body.error, "NOT_ASSIGNED_APPROVER", "not the routed approver");
  s.provider.failGet = true;
  const outage = await approve("ops1");
  assert.equal(outage.status, 503, "provider outage leaves the request pending");
  assert.equal(outage.body.error, "PROVIDER_UNAVAILABLE");
  s.provider.failGet = false;
  assert.equal(s.store.requests.get(id)?.status, "PENDING");
  s.provider.items.set(itemId, { itemId, state: 1, approved: [{ employeeCode: "E1", ts: 1 }], rejected: [], comments: {} });
  const done = await approve("ops1");
  assert.equal(done.status, 200);
  assert.equal(s.store.requests.get(id)?.approvalSource, "SEATALK");
  assert.equal(s.port.rows[0].status, "APPROVED");
  // outbox: provision on create, sync on approve
  const channels = s.store.outbox.map((o) => o.channel);
  assert.deepEqual(channels.filter((c) => c === "SEATALK_APPROVAL_PROVISION").length, 1);
  assert.deepEqual(channels.filter((c) => c === "SEATALK_APPROVAL_SYNC").length, 1);
});

test("outbox intents are created only when the SeaTalk feature is enabled", async () => {
  const s = setup();
  const off = makeBackend({ store: s.store, authenticate: s.backend.authenticate, now: s.clock.now });
  await call(off, createRequestHandler as never, "pic1", "POST", "/api/v1/requests", good);
  assert.equal(s.store.outbox.filter((o) => o.channel.startsWith("SEATALK_APPROVAL")).length, 0);
});

// ------------------------------------------------------------ synchronization
test("syncDecision: off by default (unverified provider update semantics); recreate mode posts the final state", async () => {
  const off = setup("off");
  const id1 = await newRequest(off);
  await off.coordinator.heartbeat("ops1");
  await off.coordinator.provision(id1);
  assert.equal(await off.coordinator.syncDecision(id1), "skipped");
  const on = setup("recreate");
  const id = await newRequest(on);
  await on.coordinator.heartbeat("ops1");
  await on.coordinator.provision(id);
  on.store.requests.set(id, { ...on.store.requests.get(id)!, status: "CANCELLED", approvalStatus: "CANCELLED" });
  assert.equal(await on.coordinator.syncDecision(id), "synced");
  const last = on.provider.created.at(-1)!;
  assert.equal(last.state, 4);
  assert.equal(last.itemId, on.provider.created[0].itemId, "same item id is re-posted");
  assert.deepEqual(last.pending, []);
});

// ------------------------------------------------------------ reconciliation (SEA-5)
test("reconcile applies a missed approval exactly once, ignores expired/decided, flags reason-less rejections, survives outages", async () => {
  const s = setup();
  const id = await newRequest(s);
  await s.coordinator.heartbeat("ops1");
  await s.coordinator.provision(id);
  const row = s.port.rows[0];
  const wiring = {
    signature: { secret: "x", maxSkewSeconds: 300 },
    approvals: {
      findAssignment: async (itemId: string, code: string) => (itemId === row.itemId && code === row.employeeCode ? { id: row.id, requestId: id, actor: actors.ops1, status: row.status as "PENDING", tokenHash: row.tokenHash, expiresAt: row.expiresAt } : null),
      closeAssignment: async (aid: string, st: "APPROVED" | "REJECTED") => { s.port.rows.find((x) => x.id === aid)!.status = st; },
    },
  } as never;
  const run = () => reconcileApprovals({ backend: s.backend, wiring, coordinator: s.coordinator });
  assert.equal((await run()).applied, 0, "provider still pending: nothing to do");
  s.provider.failGet = true;
  assert.equal((await run()).providerErrors, 1);
  assert.equal(s.store.requests.get(id)?.status, "PENDING", "an outage never decides anything");
  s.provider.failGet = false;
  s.provider.items.set(row.itemId, { itemId: row.itemId, state: 1, approved: [{ employeeCode: "E1", ts: 1 }], rejected: [], comments: {} });
  assert.equal((await run()).applied, 1);
  assert.equal(s.store.requests.get(id)?.status, "REQUESTED");
  assert.equal((await run()).checked, 0, "the assignment is closed: no repeat");
  assert.equal(s.store.eventLog.filter((e) => e.type === "REQUEST_APPROVED").length, 1);
  // rejection without a reason cannot be applied automatically
  const id2 = await newRequest(s);
  await s.coordinator.provision(id2);
  const row2 = s.port.rows.find((r) => r.requestId === id2)!;
  s.provider.items.set(row2.itemId, { itemId: row2.itemId, state: 2, approved: [], rejected: [{ employeeCode: row2.employeeCode, ts: 1 }], comments: {} });
  const w2 = { ...(wiring as object), approvals: { ...(wiring as { approvals: object }).approvals, findAssignment: async () => ({ id: row2.id, requestId: id2, actor: actors.ops1, status: "PENDING" as const, tokenHash: row2.tokenHash, expiresAt: row2.expiresAt }) } } as never;
  assert.equal((await reconcileApprovals({ backend: s.backend, wiring: w2, coordinator: s.coordinator })).manualReview, 1);
  assert.equal(s.store.requests.get(id2)?.status, "PENDING");
});
