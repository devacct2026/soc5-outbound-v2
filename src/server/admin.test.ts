import { test } from "node:test";
import assert from "node:assert/strict";
import { approveAccountHandler, disableAccountHandler, outboxActionHandler, outboxStatusHandler } from "./admin.ts";
import { MemoryAdmin } from "./admin-ports.ts";
import { makeBackend, type Backend } from "./backend.ts";
import { MemoryStore } from "./memory.ts";
import { aggregateRows, intradaySyncHandler } from "./intraday-sync.ts";
import { signCallback } from "./seatalk/contract.ts";
import { evaluateRegistration } from "../domain/accounts.ts";
import type { Actor } from "../domain/requests/workflow.ts";

const NOW = new Date("2026-10-19T10:00:00Z");
const actors: Record<string, Actor> = {
  adm: { id: "adm", role: "fte_ops", active: true, isAdmin: true },
  ops: { id: "ops", role: "fte_ops", active: true },
};
function setup() {
  const store = new MemoryStore();
  store.now = () => NOW;
  const admin = new MemoryAdmin(store);
  admin.accounts.set("adm", { id: "adm", role: "fte_ops", status: "ACTIVE", isAdmin: true });
  admin.accounts.set("ops", { id: "ops", role: "fte_ops", status: "ACTIVE", isAdmin: false });
  const backend = makeBackend({
    store, admin, now: () => NOW,
    authenticate: async (r) => actors[r.headers.get("authorization")?.replace("Bearer ", "") ?? ""] ?? null,
  });
  return { store, admin, backend };
}
const UUID = "11111111-1111-1111-1111-111111111111";
const post = (backend: Backend, h: typeof approveAccountHandler, who: string, body: unknown, params: Record<string, string>, key: string | null = "idem-key-0001") =>
  h(backend, new Request("http://t", { method: "POST", headers: { authorization: `Bearer ${who}`, ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) }), params);

test("outbox admin actions: admin-only, reasoned, only dead letters, audited; automatic retries untouched", async () => {
  const { store, admin, backend } = setup();
  store.outbox.push({ id: "o1", idempotencyKey: "k", channel: "SEATALK_ALERT", eventType: "e", payload: {}, status: "DEAD_LETTER", attempts: 5, availableAt: 0, lastError: "x" });
  store.outbox.push({ id: "o2", idempotencyKey: "k2", channel: "SEATALK_ALERT", eventType: "e", payload: {}, status: "PENDING", attempts: 1, availableAt: 0, lastError: null });
  const p = { id: "o1", action: "retry" };
  assert.equal((await post(backend, outboxActionHandler, "ops", { reason: "provider back" }, p)).status, 403, "non-admin");
  assert.equal((await post(backend, outboxActionHandler, "adm", {}, p)).status, 422, "reason required");
  assert.equal((await post(backend, outboxActionHandler, "adm", { reason: "ok" }, p)).status, 422, "reason too short");
  assert.equal((await post(backend, outboxActionHandler, "adm", { reason: "provider back", extra: 1 }, p)).status, 422, "unknown field");
  assert.equal((await post(backend, outboxActionHandler, "adm", { reason: "provider back" }, p, null)).status, 400, "idempotency key");
  assert.equal((await post(backend, outboxActionHandler, "adm", { reason: "provider back" }, { id: "o2", action: "retry" })).status, 409, "only dead letters");
  assert.equal((await post(backend, outboxActionHandler, "adm", { reason: "provider back" }, p)).status, 200);
  assert.equal(store.outbox[0].status, "PENDING");
  assert.equal(admin.audit.at(-1)?.type, "OUTBOX_RETRY");
  assert.equal(admin.audit.at(-1)?.reason, "provider back");
  assert.equal((await post(backend, outboxActionHandler, "adm", { reason: "give up here" }, { id: "o1", action: "abandon" })).status, 409, "no longer dead-lettered");
  assert.equal((await post(backend, outboxActionHandler, "adm", { reason: "give up here" }, { id: "o1", action: "explode" })).status, 404);
});

test("outbox status exposes counts only, to admins only", async () => {
  const { store, backend } = setup();
  store.outbox.push({ id: "o1", idempotencyKey: "k", channel: "SEATALK_ALERT", eventType: "e", payload: { secret: "PAYLOAD" }, status: "DEAD_LETTER", attempts: 5, availableAt: 0, lastError: "x" });
  const call = (who: string) => outboxStatusHandler(backend, new Request("http://t", { headers: { authorization: `Bearer ${who}` } }));
  assert.equal((await call("ops")).status, 403);
  const res = await call("adm");
  const text = await res.text();
  assert.equal(JSON.parse(text).deadLetter, 1);
  assert.ok(!text.includes("PAYLOAD"));
});

test("account approval (SEA-7): pending until an admin approves AND assigns a valid role; disable revokes", async () => {
  const { admin, backend } = setup();
  admin.accounts.set(UUID, { id: UUID, role: null, status: "PENDING_APPROVAL", isAdmin: false });
  const p = { id: UUID };
  assert.equal((await post(backend, approveAccountHandler, "ops", { role: "fte_mm", reason: "verified employee" }, p)).status, 403);
  assert.equal((await post(backend, approveAccountHandler, "adm", { reason: "verified employee" }, p)).status, 422, "explicit role required");
  assert.equal((await post(backend, approveAccountHandler, "adm", { role: "superuser", reason: "verified employee" }, p)).status, 422);
  assert.equal(admin.accounts.get(UUID)?.status, "PENDING_APPROVAL");
  assert.equal((await post(backend, approveAccountHandler, "adm", { role: "fte_mm", reason: "verified employee" }, p)).status, 200);
  assert.equal(admin.accounts.get(UUID)?.role, "fte_mm");
  assert.equal((await post(backend, approveAccountHandler, "adm", { role: "fte_mm", reason: "verified employee" }, p)).status, 409, "not re-approvable");
  assert.equal((await post(backend, disableAccountHandler, "adm", { reason: "left the company" }, p)).status, 200);
  assert.equal(admin.accounts.get(UUID)?.status, "DISABLED");
  assert.deepEqual(admin.audit.map((a) => a.type), ["ACCOUNT_APPROVED", "ACCOUNT_DISABLED"]);
});

test("registration policy: always PENDING_APPROVAL without a role; domain/org/identity enforced", () => {
  const ok = evaluateRegistration({ email: "a@shopee.com", organizationMember: true, oauthIdentityVerified: true }, ["shopee.com"]);
  assert.deepEqual(ok, { allow: true, accountStatus: "PENDING_APPROVAL", role: null });
  const deny = (i: Partial<Parameters<typeof evaluateRegistration>[0]>, d = ["shopee.com"]) =>
    evaluateRegistration({ email: "a@shopee.com", organizationMember: true, oauthIdentityVerified: true, ...i }, d);
  assert.deepEqual(deny({ organizationMember: false }), { allow: false, reason: "NOT_ORG_MEMBER" });
  assert.deepEqual(deny({ oauthIdentityVerified: false }), { allow: false, reason: "IDENTITY_UNVERIFIED" });
  assert.deepEqual(deny({ email: "a@evil.com" }), { allow: false, reason: "DOMAIN_NOT_ALLOWED" });
  assert.deepEqual(deny({ email: "a@shopee.com.evil.com" }), { allow: false, reason: "DOMAIN_NOT_ALLOWED" });
  assert.deepEqual(deny({}, []), { allow: false, reason: "DOMAIN_NOT_ALLOWED" }, "empty allow-list denies everyone");
  assert.deepEqual(deny({ email: "nope" }), { allow: false, reason: "INVALID_EMAIL" });
});

// ---------------------------------------------------------------- intraday sync
const SECRET = "intraday-secret";
const sync = (backend: Backend | null, rows: unknown, o: { source?: string; secret?: string; ts?: string; raw?: string } = {}) => {
  const raw = o.raw ?? JSON.stringify({ rows });
  const ts = o.ts ?? String(Math.floor(NOW.getTime() / 1000));
  return intradaySyncHandler(backend, new Request("http://t", {
    method: "POST", body: raw,
    headers: { "x-source": o.source ?? "google-apps-script", "x-timestamp": ts, "x-signature": signCallback(o.secret ?? SECRET, ts, raw) },
  }));
};

test("intraday sync: signature, source allowlist, skew, size/row limits, validation, aggregation", async () => {
  const { store, backend } = setup();
  backend.intradaySecret = SECRET;
  assert.equal((await sync(backend, [], { source: "curl" })).status, 403);
  assert.equal((await sync(backend, [], { secret: "wrong" })).status, 401);
  assert.equal((await sync(backend, [], { ts: String(Math.floor(NOW.getTime() / 1000) - 400) })).status, 401);
  assert.equal((await sync(backend, [], { raw: "{bad" })).status, 400, "validly signed but malformed body");
  assert.equal((await sync(backend, Array.from({ length: 1001 }, () => ({})))).status, 413);
  const res = await sync(backend, [
    { date: "2026-10-19", hour: 6, order_qty: 10, status: "SOC_LHTransporting" },
    { date: "2026-10-19", hour: 6, order_qty: 5 },
    { date: "2026-10-19", hour: 7, order_qty: 3, status: "OTHER" },
    { date: "2026-10-19", hour: 24, order_qty: 3 },
    { date: "2026-02-30", hour: 1, order_qty: 3 },
    { date: "2026-10-19", hour: 8, order_qty: -1 },
    "junk",
  ]);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: 7, processed: 1, rejected: 5 });
  const d = await store.intraday("2026-10-19");
  assert.equal(d[6].orderQty, 15, "duplicate date/hour keys aggregate");
  assert.equal(d[7].orderQty, 0);
  assert.deepEqual(aggregateRows([{ date: "2026-10-19", hour: 1, order_qty: 2 }]).rows, [{ date: "2026-10-19", hour: 1, orderQty: 2 }]);
});

test("intraday sync is disabled without a configured secret", async () => {
  const { backend } = setup();
  assert.equal((await sync(backend, [])).status, 503);
  assert.equal((await sync(null, [])).status, 503);
});
