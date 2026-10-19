import { test } from "node:test";
import assert from "node:assert/strict";
import { seatalkChallengeHandler, seatalkDecisionHandler, type SeatalkWiring } from "./callback.ts";
import { sha256, signCallback, verifyCallbackSignature, disabledApprovalProvider, disabledAlertSender, ProviderDisabledError } from "./contract.ts";
import { MemoryApprovalStore, actorOf } from "./memory.ts";
import { makeBackend, type Backend } from "../backend.ts";
import { MemoryStore } from "../memory.ts";
import { runCommand } from "../commands.ts";
import { createRequest } from "../../domain/requests/lifecycle.ts";

const SECRET = "test-secret";
const NOW = new Date("2026-10-19T10:00:00Z");
const ts = () => String(Math.floor(NOW.getTime() / 1000));
const details = { clusterId: null, cluster: "C", region: "R", dockNo: "1", backlogs: 1, backlogsTimestamp: null, truckSize: "4W" as const, truckType: "WETLEASE" as const };

async function setup(enabled = true) {
  const store = new MemoryStore();
  store.now = () => NOW;
  const approvals = new MemoryApprovalStore();
  const backend = Object.assign(
    makeBackend({ store, authenticate: async () => null, now: () => NOW, features: { seatalkApproval: enabled, seatalkAlerts: false, googleSheets: false } }),
    { seatalk: { signature: { secret: SECRET, maxSkewSeconds: 300 }, approvals } satisfies SeatalkWiring },
  ) as Backend & { seatalk: SeatalkWiring };
  const reqId = crypto.randomUUID();
  const pic = { id: "pic1", role: "ops_pic" as const, active: true };
  await runCommand(store, {
    actor: pic, requestId: reqId, creating: true, method: "POST", path: "/p", idempotencyKey: "seed-key-001", payload: {},
    authorize: () => true, decide: () => createRequest(pic, details, { now: NOW, correlationId: "c", newId: reqId }),
  });
  const assignmentId = approvals.addAssignment({
    requestId: reqId, actor: actorOf("ops1"), status: "PENDING", tokenHash: sha256("good-token-123"),
    expiresAt: new Date(NOW.getTime() + 180_000).toISOString(), providerItemId: "item-1", employeeCode: "E100",
  });
  return { store, approvals, backend, reqId, assignmentId };
}

const post = (backend: Backend, action: "approve" | "reject", payload: Record<string, unknown>, opts: { secret?: string; timestamp?: string; raw?: string } = {}) => {
  const raw = opts.raw ?? JSON.stringify(payload);
  const timestamp = opts.timestamp ?? ts();
  return seatalkDecisionHandler(backend, new Request("http://t/cb", {
    method: "POST", body: raw,
    headers: { "x-timestamp": timestamp, "x-signature": signCallback(opts.secret ?? SECRET, timestamp, raw) },
  }), action);
};
const body = (extra: Record<string, unknown> = {}) => ({ item_id: "item-1", token: "good-token-123", employee: { employee_code: "E100" }, event_id: "evt-1", ...extra });

test("disabled by default: provider stubs refuse, callback endpoint answers 503", async () => {
  await assert.rejects(disabledApprovalProvider.createItem("r", "E"), ProviderDisabledError);
  await assert.rejects(disabledAlertSender.send({ dedupeKey: "k", requestId: "r", event: "e" }), ProviderDisabledError);
  const s = await setup(false);
  assert.equal((await post(s.backend, "approve", body())).status, 503);
  assert.equal(s.store.requests.get(s.reqId)?.status, "PENDING");
  assert.equal((await seatalkDecisionHandler(null, new Request("http://t"), "approve")).status, 503);
});

test("signature: valid accepted; wrong secret, tampered body, stale or missing headers rejected before any processing", async () => {
  const s = await setup();
  assert.equal((await post(s.backend, "approve", body({ event_id: "bad-1" }), { secret: "wrong" })).status, 401);
  const raw = JSON.stringify(body({ event_id: "bad-2" }));
  const t = ts();
  const tampered = await seatalkDecisionHandler(s.backend, new Request("http://t", { method: "POST", body: raw.replace("E100", "E999"), headers: { "x-timestamp": t, "x-signature": signCallback(SECRET, t, raw) } }), "approve");
  assert.equal(tampered.status, 401);
  assert.equal((await post(s.backend, "approve", body({ event_id: "bad-3" }), { timestamp: String(Number(ts()) - 301) })).status, 401, "stale");
  assert.equal((await seatalkDecisionHandler(s.backend, new Request("http://t", { method: "POST", body: raw }), "approve")).status, 401, "missing");
  assert.equal(s.approvals.callbacks.length, 0, "rejected callbacks are never recorded");
  assert.equal(s.store.requests.get(s.reqId)?.status, "PENDING");
  assert.deepEqual(verifyCallbackSignature({ secret: SECRET, maxSkewSeconds: 300 }, new Headers({ "x-timestamp": "123", "x-signature": "zz" }), "{}", NOW), { ok: false, reason: "MISSING" });
});

test("valid approval applies the workflow once with SEATALK source and closes the assignment", async () => {
  const s = await setup();
  const res = await post(s.backend, "approve", body());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { code: 0 });
  const r = s.store.requests.get(s.reqId)!;
  assert.equal(r.status, "REQUESTED");
  assert.equal(r.approvalSource, "SEATALK");
  assert.equal(s.approvals.assignments.get(s.assignmentId)!.status, "APPROVED");
  assert.equal(s.approvals.callbacks[0].status, "PROCESSED");
});

test("duplicates (SEA-4): exact duplicate acknowledged without reprocessing; same id + different payload is a conflict", async () => {
  const s = await setup();
  await post(s.backend, "approve", body());
  const eventsBefore = s.store.eventLog.length;
  const dup = await post(s.backend, "approve", body());
  assert.equal(dup.status, 200);
  assert.equal(s.store.eventLog.length, eventsBefore, "no repeated workflow action");
  const conflict = await post(s.backend, "approve", body({ token: "good-token-123", employee: { employee_code: "E100" }, extra: "changed" }));
  assert.equal(conflict.status, 409);
  // content-based fallback only when the provider id is absent
  const s2 = await setup();
  const noId = { item_id: "item-1", token: "good-token-123", employee: { employee_code: "E100" } };
  await post(s2.backend, "approve", noId);
  const before = s2.store.eventLog.length;
  assert.equal((await post(s2.backend, "approve", { ...noId })).status, 200);
  assert.equal(s2.store.eventLog.length, before);
  assert.equal(s2.approvals.callbacks.length, 1);
});

test("provider-scoped: same event id from a different provider is not a duplicate", async () => {
  const approvals = new MemoryApprovalStore();
  const base = { eventId: "e1", fallbackHash: null, payloadHash: "h", employeeCode: "E", action: "approve" };
  assert.equal((await approvals.recordCallback({ ...base, provider: "seatalk" })).kind, "NEW");
  assert.equal((await approvals.recordCallback({ ...base, provider: "other" })).kind, "NEW");
  assert.equal((await approvals.recordCallback({ ...base, provider: "seatalk" })).kind, "DUPLICATE");
});

test("authorization at decision time: wrong employee, bad token, expired, inactive or wrong-role profile", async () => {
  let s = await setup();
  assert.equal((await post(s.backend, "approve", body({ employee: { employee_code: "E999" }, event_id: "a" }))).status, 404);
  assert.equal((await post(s.backend, "approve", body({ token: "wrong-token-xyz", event_id: "b" }))).status, 403);
  assert.equal(s.store.requests.get(s.reqId)?.status, "PENDING");
  s = await setup();
  s.approvals.assignments.get(s.assignmentId)!.expiresAt = new Date(NOW.getTime() - 1000).toISOString();
  assert.equal((await post(s.backend, "approve", body())).status, 200, "acknowledged");
  assert.equal(s.store.requests.get(s.reqId)?.status, "PENDING", "expired assignment never approves");
  assert.equal(s.approvals.callbacks[0].status, "IGNORED");
  s = await setup();
  s.approvals.assignments.get(s.assignmentId)!.actor = actorOf("ops1", "fte_ops", false);
  assert.equal((await post(s.backend, "approve", body())).status, 403, "disabled profile");
  s = await setup();
  s.approvals.assignments.get(s.assignmentId)!.actor = actorOf("mm1", "fte_mm");
  assert.equal((await post(s.backend, "approve", body())).status, 403, "role re-checked");
});

test("SEA-5: an already-decided request is not overwritten by a later callback", async () => {
  const s = await setup();
  // Request is cancelled in SOC5 before the callback arrives.
  const r = s.store.requests.get(s.reqId)!;
  s.store.requests.set(s.reqId, { ...r, status: "CANCELLED", approvalStatus: "CANCELLED" });
  const res = await post(s.backend, "approve", body());
  assert.equal(res.status, 200);
  assert.equal(s.store.requests.get(s.reqId)?.status, "CANCELLED");
  assert.equal(s.approvals.callbacks[0].reason, "REQUEST_ALREADY_DECIDED");
});

test("rejection callback requires a reason and applies APR-3 routing", async () => {
  const s = await setup();
  assert.equal((await post(s.backend, "reject", body({ reason: "" }))).status, 400);
  const res = await post(s.backend, "reject", body({ reason: "wrong cluster", event_id: "r1" }));
  assert.equal(res.status, 200);
  const r = s.store.requests.get(s.reqId)!;
  assert.equal(r.status, "REJECTED");
  assert.equal(r.rejectionDisposition, "RETURN_TO_OPS_PIC");
});

test("challenge endpoint echoes only after signature verification", async () => {
  const s = await setup();
  const raw = JSON.stringify({ event: { seatalk_challenge: "abc123" } });
  const t = ts();
  const ok = await seatalkChallengeHandler(s.backend, new Request("http://t", { method: "POST", body: raw, headers: { "x-timestamp": t, "x-signature": signCallback(SECRET, t, raw) } }));
  assert.deepEqual(await ok.json(), { seatalk_challenge: "abc123" });
  const bad = await seatalkChallengeHandler(s.backend, new Request("http://t", { method: "POST", body: raw, headers: { "x-timestamp": t, "x-signature": "0".repeat(64) } }));
  assert.equal(bad.status, 401);
});
