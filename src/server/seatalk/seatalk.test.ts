import { test } from "node:test";
import assert from "node:assert/strict";
import { seatalkChallengeHandler, seatalkDecisionHandler, type SeatalkWiring } from "./callback.ts";
import { sha256, signApprovalCallback, signEvent, verifyApprovalCallbackSignature, disabledAlertSender, ProviderDisabledError } from "./contract.ts";
import { disabledApprovalProvider, SeaTalkProviderError } from "./provider.ts";
import { MemoryApprovalStore, actorOf } from "./memory.ts";
import { makeBackend, type Backend } from "../backend.ts";
import { MemoryStore } from "../memory.ts";
import { runCommand } from "../commands.ts";
import { createRequest } from "../../domain/requests/lifecycle.ts";

const SECRET = "test-secret";
const NOW = new Date("2026-10-19T10:00:00Z");
const details = { clusterId: null, cluster: "C", region: "R", dockNo: "1", backlogs: 1, backlogsTimestamp: null, truckSize: "4W" as const, truckType: "WETLEASE" as const };

async function setup(enabled = true) {
  const store = new MemoryStore();
  store.now = () => NOW;
  const approvals = new MemoryApprovalStore();
  const backend = Object.assign(
    makeBackend({ store, authenticate: async () => null, now: () => NOW, features: { seatalkApproval: enabled, seatalkAlerts: false, googleSheets: false } }),
    { seatalk: { signature: { secret: SECRET, maxSkewSeconds: 300 }, eventSecret: "event-signing-secret", approvals } satisfies SeatalkWiring },
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

const URL_BASE = "http://t/api/v1/integrations/seatalk/approval";
/** Build a signed approve/reject callback exactly as the (assumed) SeaTalk scheme requires; the token rides on the URL. */
function signedRequest(action: "approve" | "reject", raw: string, opts: { secret?: string; date?: string; token?: string | null; tamper?: boolean } = {}) {
  const token = opts.token === undefined ? "good-token-123" : opts.token;
  const url = `${URL_BASE}/${action}${token ? `?token=${token}` : ""}`;
  const date = opts.date ?? NOW.toUTCString();
  const parts = { method: "POST", path: new URL(url).pathname, contentType: "application/json", date, xToken: "xt-1", search: new URL(url).search };
  const authorization = signApprovalCallback(opts.secret ?? SECRET, parts, raw);
  return new Request(url, {
    method: "POST",
    body: opts.tamper ? raw.replace("E100", "E999") : raw,
    headers: { "content-type": "application/json", date, "x-token": "xt-1", authorization },
  });
}
const post = (backend: Backend, action: "approve" | "reject", payload: Record<string, unknown>, opts: { secret?: string; date?: string; raw?: string; token?: string | null } = {}) => {
  const { token: urlToken, ...official } = payload as { token?: string }; // the token is never part of the official body
  const raw = opts.raw ?? JSON.stringify(official);
  return seatalkDecisionHandler(backend, signedRequest(action, raw, { ...opts, token: opts.token !== undefined ? opts.token : (urlToken ?? "good-token-123") }), action);
};
const body = (extra: Record<string, unknown> = {}) => ({ item_id: "item-1", token: "good-token-123", employee: { employee_code: "E100" }, event_id: "evt-1", ...extra });

test("disabled by default: provider stubs refuse, callback endpoint answers 503", async () => {
  await assert.rejects(disabledApprovalProvider.createItem({} as never), SeaTalkProviderError);
  await assert.rejects(disabledAlertSender.send({ dedupeKey: "k", requestId: "r", event: "e" }), ProviderDisabledError);
  const s = await setup(false);
  assert.equal((await post(s.backend, "approve", body())).status, 503);
  assert.equal(s.store.requests.get(s.reqId)?.status, "PENDING");
  assert.equal((await seatalkDecisionHandler(null, new Request("http://t"), "approve")).status, 503);
});

test("signature: valid accepted; wrong secret, tampered body, stale Date or missing headers rejected before any processing", async () => {
  const s = await setup();
  assert.equal((await post(s.backend, "approve", body({ event_id: "bad-1" }), { secret: "wrong" })).status, 401);
  const raw = JSON.stringify({ item_id: "item-1", employee: { employee_code: "E100" } });
  assert.equal((await seatalkDecisionHandler(s.backend, signedRequest("approve", raw, { tamper: true }), "approve")).status, 401, "tampered body");
  const stale = new Date(NOW.getTime() - 301_000).toUTCString();
  assert.equal((await post(s.backend, "approve", body({ event_id: "bad-3" }), { date: stale })).status, 401, "stale Date header");
  assert.equal((await seatalkDecisionHandler(s.backend, new Request(`${URL_BASE}/approve?token=good-token-123`, { method: "POST", body: raw }), "approve")).status, 401, "missing headers");
  assert.equal(s.approvals.callbacks.length, 0, "rejected callbacks are never recorded");
  assert.equal(s.store.requests.get(s.reqId)?.status, "PENDING");
  const req = signedRequest("approve", raw);
  assert.deepEqual(verifyApprovalCallbackSignature({ secret: SECRET, maxSkewSeconds: 300 }, req, raw, NOW), { ok: true });
  const moved = new Request(req.url.replace("good-token-123", "other-token-999"), { method: "POST", body: raw, headers: req.headers });
  assert.equal(verifyApprovalCallbackSignature({ secret: SECRET, maxSkewSeconds: 300 }, moved, raw, NOW).ok, false, "the query (token) is part of the signed string");
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
  const first = await approvals.recordCallback({ ...base, provider: "seatalk" });
  assert.equal(first.kind, "NEW");
  assert.equal((await approvals.recordCallback({ ...base, provider: "seatalk" })).kind, "RETRY", "unfinished callbacks are reprocessed, not acknowledged");
  await approvals.finishCallback((first as { id: string }).id, "PROCESSED");
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

test("event endpoint (official contract): handshake echoes only after the Signature header verifies; other events are acknowledged unprocessed", async () => {
  const s = await setup();
  const raw = JSON.stringify({ event_id: "e1", event_type: "event_verification", timestamp: 1, app_id: "a", event: { seatalk_challenge: "abc123" } });
  const sign = (b: string) => signEvent("event-signing-secret", b);
  const ok = await seatalkChallengeHandler(s.backend, new Request("http://t", { method: "POST", body: raw, headers: { signature: sign(raw) } }));
  assert.deepEqual(await ok.json(), { seatalk_challenge: "abc123" });
  assert.equal((await seatalkChallengeHandler(s.backend, new Request("http://t", { method: "POST", body: raw, headers: { signature: "0".repeat(64) } }))).status, 401);
  assert.equal((await seatalkChallengeHandler(s.backend, new Request("http://t", { method: "POST", body: raw }))).status, 401);
  const other = JSON.stringify({ event_id: "e2", event_type: "new_bot_subscriber", event: {} });
  const res = await seatalkChallengeHandler(s.backend, new Request("http://t", { method: "POST", body: other, headers: { signature: sign(other) } }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { code: 0 });
  // the official vector: sha256(body + secret), lowercase hex
  assert.equal(signEvent("s", "b"), (await import("node:crypto")).createHash("sha256").update("bs").digest("hex"));
});

test("retry semantics: failed or crashed callbacks are reprocessed on redelivery; only terminal outcomes are deduplicated", async () => {
  // Callback arrives before the assignment exists -> 404 now, success on the provider's retry.
  const s = await setup();
  const saved = s.approvals.assignments.get(s.assignmentId)!;
  s.approvals.assignments.delete(s.assignmentId);
  assert.equal((await post(s.backend, "approve", body({ event_id: "late-1" }))).status, 404);
  s.approvals.assignments.set(s.assignmentId, saved);
  const retry = await post(s.backend, "approve", body({ event_id: "late-1" }));
  assert.equal(retry.status, 200);
  assert.equal(s.store.requests.get(s.reqId)?.status, "REQUESTED", "approval not lost");
  assert.equal(s.approvals.callbacks.filter((c) => c.status === "PROCESSED").length, 1);
  assert.equal(s.store.eventLog.filter((e) => e.type === "REQUEST_APPROVED").length, 1);
  // A crash after recording (status stuck at RECEIVED) is reprocessed too.
  const s2 = await setup();
  const { callbackFingerprint } = await import("./contract.ts");
  await s2.approvals.recordCallback({ provider: "seatalk", eventId: "crash-1", fallbackHash: null, payloadHash: callbackFingerprint(JSON.stringify({ item_id: "item-1", employee: { employee_code: "E100" }, event_id: "crash-1" })), employeeCode: "E100", action: "approve" });
  assert.equal((await post(s2.backend, "approve", body({ event_id: "crash-1" }))).status, 200);
  assert.equal(s2.store.requests.get(s2.reqId)?.status, "REQUESTED");
});

test("a forged callback with a bad token cannot consume the legitimate callback identity (no event id)", async () => {
  const s = await setup();
  const noId = { item_id: "item-1", employee: { employee_code: "E100" } };
  assert.equal((await post(s.backend, "approve", { ...noId, token: "wrong-token-xyz" })).status, 403);
  assert.equal((await post(s.backend, "approve", { ...noId, token: "good-token-123" })).status, 200);
  assert.equal(s.store.requests.get(s.reqId)?.status, "REQUESTED");
});

test("transient VERSION_CONFLICT is not swallowed as a decision: provider gets a retryable error", async () => {
  const s = await setup();
  const original = s.store.transaction.bind(s.store);
  const { VersionConflictError } = await import("../store.ts");
  s.store.transaction = (async () => {
    throw new VersionConflictError();
  }) as never;
  const res = await post(s.backend, "approve", body({ event_id: "vc-1" }));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "RETRY_LATER");
  assert.equal(s.approvals.callbacks[0].status, "FAILED");
  s.store.transaction = original;
  assert.equal((await post(s.backend, "approve", body({ event_id: "vc-1" }))).status, 200);
  assert.equal(s.store.requests.get(s.reqId)?.status, "REQUESTED");
});

test("bounded bodies and fail-closed skew configuration", async () => {
  const s = await setup();
  const big = "x".repeat(70 * 1024);
  assert.equal((await seatalkDecisionHandler(s.backend, signedRequest("approve", big), "approve")).status, 413);
  const lying = await seatalkDecisionHandler(s.backend, new Request(`${URL_BASE}/approve`, { method: "POST", body: "{}", headers: { "content-length": "999999" } }), "approve");
  assert.equal(lying.status, 413);
  for (const bad of [Number.NaN, 0, -5]) {
    const req = signedRequest("approve", "{}");
    assert.equal(verifyApprovalCallbackSignature({ secret: SECRET, maxSkewSeconds: bad }, req, "{}", NOW).ok, false, `skew ${bad} must fail closed`);
  }
  assert.equal(verifyApprovalCallbackSignature({ secret: "", maxSkewSeconds: 300 }, signedRequest("approve", "{}"), "{}", NOW).ok, false, "empty secret fails closed");
});
