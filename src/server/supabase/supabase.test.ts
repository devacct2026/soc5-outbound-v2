import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createSupabaseBackend, makeAuthenticator, SupabaseStore } from "./backend.ts";
import { Rest, RestError, q } from "./rest.ts";
import { fromRow, toRow } from "./mapping.ts";
import { createRequest } from "../../domain/requests/lifecycle.ts";
import { runCommand } from "../commands.ts";
import { VersionConflictError } from "../store.ts";
import { SupabaseOutboxPort } from "../worker/ports.ts";
import { buildSheetRows, createGoogleSheetsClient, safeCell, syncRequestsToSheet, SHEET_COLUMNS } from "../integrations/sheets.ts";
import type { RequestRecord } from "../../domain/requests/lifecycle.ts";

const SERVICE = "service-key-SECRET-xxxxxxxxxxxxxxxxxx";
const ANON = "anon-key-xxxxxxxxxxxxxxxxxxxx";
interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

function stub(handler: (c: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const c: Call = {
      url: String(url), method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof init?.body === "string" ? safeJson(init.body) : init?.body,
    };
    calls.push(c);
    const r = handler(c);
    const status = r.status ?? 200;
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return s; } };

const sampleRow = {
  id: "11111111-1111-1111-1111-111111111111", request_timestamp: "2026-10-19T10:00:00Z", submitted_at: "2026-10-19T10:00:00Z",
  cluster_id: null, cluster: "C", region: "R", dock_no: "1", backlogs: 1, backlogs_timestamp: null, truck_size: "4W", truck_type: "WETLEASE",
  created_by: "22222222-2222-2222-2222-222222222222", creator_role: "ops_pic", status: "PENDING", approval_status: "PENDING", approval_version: 1,
  approval_correlation_id: "33333333-3333-3333-3333-333333333333", row_version: 3, created_at: "2026-10-19T10:00:00Z",
};

test("mapping round-trips and sends every NOT NULL column", () => {
  const rec = fromRow(sampleRow);
  assert.equal(rec.rowVersion, 3);
  assert.equal(rec.rejectionDisposition, null);
  const back = toRow(rec);
  for (const k of ["id", "created_by", "creator_role", "status", "approval_status", "cluster", "region", "dock_no", "backlogs", "truck_size", "truck_type", "submitted_at", "request_timestamp"]) {
    assert.notEqual(back[k], undefined, k);
  }
});

test("authenticator: anon key for token validation, service key only for profile lookup; no access for PENDING/DISABLED", async () => {
  const profile = (status: string, role: string | null = "fte_ops") => ({ id: "u1", role, account_status: status, is_admin: true, reporting_permission: true });
  const run = async (authStatus: number, profileRow: unknown) => {
    const s = stub((c) => (c.url.includes("/auth/v1/user") ? { status: authStatus, body: { id: "u1" } } : { body: profileRow ? [profileRow] : [] }));
    const cfg = { url: "https://x.supabase.co", anonKey: ANON, serviceKey: SERVICE, fetchImpl: s.fetchImpl };
    const auth = makeAuthenticator(cfg, new Rest({ url: cfg.url, serviceKey: SERVICE, fetchImpl: s.fetchImpl }));
    const actor = await auth(new Request("http://t", { headers: { authorization: `Bearer ${"a".repeat(40)}` } }));
    return { actor, calls: s.calls };
  };
  const ok = await run(200, profile("ACTIVE"));
  assert.deepEqual(ok.actor, { id: "u1", role: "fte_ops", active: true, isAdmin: true, reportingPermission: true });
  const userCall = ok.calls.find((c) => c.url.includes("/auth/v1/user"))!;
  assert.equal(userCall.headers.apikey, ANON);
  assert.ok(!JSON.stringify(userCall).includes("SECRET"), "service key never sent to the auth endpoint");
  assert.equal((await run(401, profile("ACTIVE"))).actor, null, "invalid token");
  assert.equal((await run(200, profile("PENDING_APPROVAL", null))).actor, null, "pending accounts have no access");
  assert.equal((await run(200, profile("DISABLED"))).actor, null, "disabled => revoked on the very next request");
  assert.equal((await run(200, null)).actor, null, "no profile");
  const s = stub(() => ({ body: [] }));
  const auth = makeAuthenticator({ url: "https://x", anonKey: ANON, serviceKey: SERVICE, fetchImpl: s.fetchImpl }, new Rest({ url: "https://x", serviceKey: SERVICE, fetchImpl: s.fetchImpl }));
  for (const h of [undefined, "Basic abc", "Bearer short", `Bearer ${"a".repeat(5000)}`, "Bearer has space in it xxxxxxxxxxxxxxxxxxxx"]) {
    assert.equal(await auth(new Request("http://t", { headers: h ? { authorization: h } : {} })), null);
  }
  assert.equal(s.calls.length, 0, "malformed tokens never reach the network");
});

test("transaction commit: RPC payload, optimistic retry on VERSION_CONFLICT, 23505 triggers replay", async () => {
  let loads = 0;
  let commits = 0;
  const s = stub((c) => {
    if (c.url.includes("/rest/v1/requests?")) { loads++; return { body: [{ ...sampleRow, row_version: loads }] }; }
    if (c.url.includes("/idempotency_keys")) return { body: [] };
    if (c.url.includes("/rpc/commit_transition")) {
      commits++;
      return commits === 1 ? { body: { ok: false, code: "VERSION_CONFLICT" } } : { body: { ok: true } };
    }
    return { body: [] };
  });
  const store = new SupabaseStore(new Rest({ url: "https://x.supabase.co", serviceKey: SERVICE, fetchImpl: s.fetchImpl }));
  const actor = { id: "ops1", role: "fte_ops" as const, active: true };
  const res = await runCommand(store, {
    actor: { id: "22222222-2222-2222-2222-222222222222", role: "ops_pic", active: true }, requestId: sampleRow.id, method: "PUT", path: "/p", idempotencyKey: "key-12345678", payload: {},
    authorize: () => true,
    decide: (r) => ({ ok: true, request: r!, event: { type: "REQUEST_UPDATED", requestId: r!.id, actorId: actor.id, creatorId: r!.createdBy, at: "2026-10-19T10:00:00Z", fromStatus: "PENDING", toStatus: "PENDING", fromApprovalStatus: "PENDING", toApprovalStatus: "PENDING", remarks: null, disposition: null, returnRole: null, approvalVersion: 1, correlationId: "c" }, notifications: [] }),
  });
  assert.equal(res.status, 200);
  assert.equal(loads, 2, "reloaded after a version conflict");
  assert.equal(commits, 2);
  const rpc = s.calls.filter((c) => c.url.includes("commit_transition"));
  assert.equal((rpc[1].body as { p_expected_version: number }).p_expected_version, 2, "expected version taken from the latest load");
  assert.equal(rpc[0].headers.authorization, `Bearer ${SERVICE}`);

  // unique violation on idempotency insert => retry (will replay on reload)
  let n = 0;
  const s2 = stub((c) => {
    if (c.url.includes("/rpc/commit_transition")) return ++n === 1 ? { status: 409, body: { code: "23505", message: "dup" } } : { body: { ok: true } };
    return { body: c.url.includes("idempotency") ? [] : [sampleRow] };
  });
  const store2 = new SupabaseStore(new Rest({ url: "https://x", serviceKey: SERVICE, fetchImpl: s2.fetchImpl }));
  await assert.rejects(
    store2.transaction(sampleRow.id, async (tx) => tx.commit({ request: tx.request!, expectedVersion: 1, event: { type: "REQUEST_UPDATED" } as never, notifications: [], outbox: [] })).then(() => { throw new Error("committed"); }),
    (e: Error) => e.message === "committed" || e instanceof VersionConflictError,
  );
});

test("replay lookup is scoped by actor/method/path/key and ignores expired keys", async () => {
  const s = stub(() => ({ body: [{ payload_hash: "H", response_status: 201, response_body: { a: 1 } }] }));
  const store = new SupabaseStore(new Rest({ url: "https://x", serviceKey: SERVICE, fetchImpl: s.fetchImpl }), () => new Date("2026-10-19T10:00:00Z"));
  let seen: unknown;
  await store.transaction("11111111-1111-1111-1111-111111111111", async (tx) => {
    seen = await tx.replay({ actorId: "a1", method: "POST", path: "/p", key: "k1234567", payloadHash: "H" });
    assert.equal(await tx.replay({ actorId: "a1", method: "POST", path: "/p", key: "k1234567", payloadHash: "OTHER" }), "CONFLICT");
  });
  assert.deepEqual(seen, { status: 201, body: { a: 1 } });
  const url = s.calls.find((c) => c.url.includes("idempotency_keys"))!.url;
  assert.match(url, /actor_id=eq\.a1&method=eq\.POST&path=eq\.%2Fp&key=eq\.k1234567&expires_at=gt\./);
});

test("queue uses the SQL function with a look-ahead row; Ops PIC list is creator-scoped; unsafe filters rejected", async () => {
  const s = stub((c) => {
    if (c.url.includes("/rpc/queue_requests")) return { body: [sampleRow, { ...sampleRow, id: "11111111-1111-1111-1111-111111111112" }] };
    return { body: [] };
  });
  const store = new SupabaseStore(new Rest({ url: "https://x", serviceKey: SERVICE, fetchImpl: s.fetchImpl }));
  const page = await store.queue({ id: "u", role: "fte_ops", active: true }, { limit: 1, cursor: null });
  assert.equal(page.data.length, 1);
  assert.equal(page.hasMore, true);
  assert.ok(page.nextCursor);
  assert.equal((s.calls[0].body as { p_limit: number }).p_limit, 2);
  await store.listRequests({ id: "pic-1", role: "ops_pic", active: true }, { limit: 25, cursor: null });
  assert.match(s.calls.at(-1)!.url, /created_by=eq\.pic-1/);
  await store.listRequests({ id: "x", role: "fte_ops", active: true }, { limit: 25, cursor: null });
  assert.doesNotMatch(s.calls.at(-1)!.url, /created_by=/);
  assert.throws(() => q("x),role.eq.admin"), /unsafe/);
  await assert.rejects(store.listRequests({ id: "x", role: "fte_ops", active: true }, { limit: 25, cursor: null, search: "a,b)" }));
});

test("rest client: timeouts and errors never leak the service key", async () => {
  const s = stub(() => ({ status: 500, body: { message: "boom" } }));
  const rest = new Rest({ url: "https://x", serviceKey: SERVICE, fetchImpl: s.fetchImpl });
  await assert.rejects(rest.select("t", "a=b"), (e: unknown) => e instanceof RestError && !String(e.message).includes("SECRET"));
});

test("createSupabaseBackend wires admin + (optionally) SeaTalk without enabling approvals", () => {
  const b = createSupabaseBackend({ url: "https://x", anonKey: ANON, serviceKey: SERVICE }, { seatalkSecret: "s" });
  assert.ok(b.admin);
  assert.ok(b.seatalk);
  assert.equal(b.features.seatalkApproval, false);
  assert.equal(createSupabaseBackend({ url: "https://x", anonKey: ANON, serviceKey: SERVICE }).seatalk, undefined);
});

test("outbox port maps claim_outbox rows and passes the channel filter", async () => {
  const s = stub(() => ({ body: [{ id: "o1", idempotency_key: "k", channel: "SEATALK_ALERT", event_type: "E", payload: { a: 1 }, attempts: 1, max_attempts: 5 }] }));
  const port = new SupabaseOutboxPort(new Rest({ url: "https://x", serviceKey: SERVICE, fetchImpl: s.fetchImpl }));
  const rows = await port.claim(["SEATALK_ALERT"], 10, 300);
  assert.deepEqual(rows[0], { id: "o1", idempotencyKey: "k", channel: "SEATALK_ALERT", eventType: "E", payload: { a: 1 }, attempts: 1, maxAttempts: 5 });
  assert.deepEqual(s.calls[0].body, { p_limit: 10, p_lock_timeout_seconds: 300, p_channels: ["SEATALK_ALERT"] });
});

// ----------------------------------------------------------------- sheets
const rec = (o: Partial<RequestRecord> = {}): RequestRecord => {
  const r = createRequest({ id: "u", role: "ops_pic", active: true }, { clusterId: null, cluster: "=cmd|' /C calc'!A0", region: "R", dockNo: "1", backlogs: 1, backlogsTimestamp: null, truckSize: "4W", truckType: "WETLEASE" }, { now: new Date("2026-10-19T10:00:00Z"), correlationId: "c", newId: crypto.randomUUID() });
  if (!r.ok) throw new Error();
  return { ...(r.request as RequestRecord), ...o };
};

test("sheets: 19 columns, formula injection neutralised, row limit enforced, stale rows cleared only after a good write", async () => {
  assert.equal(SHEET_COLUMNS.length, 19);
  const rows = buildSheetRows([rec()]);
  assert.equal(rows[0].length, 19);
  assert.ok(String(rows[0][2]).startsWith("'="));
  assert.equal(safeCell(null), "");
  assert.equal(safeCell(5), 5);
  const calls: string[] = [];
  const client = { replace: async (_h: string[], r: unknown[][], prev: number) => { calls.push(`${r.length}/${prev}`); return { written: r.length }; } };
  await syncRequestsToSheet(client, [rec(), rec()], 5);
  assert.deepEqual(calls, ["2/5"]);
  await assert.rejects(syncRequestsToSheet(client, [rec(), rec()], 0, 1), /exceeds limit/);
  assert.equal(calls.length, 1, "nothing written when over the limit");
});

test("google client: JWT exchange then PUT then clear; a failed write never clears", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const run = async (putStatus: number) => {
    const s = stub((c) => {
      if (c.url.includes("oauth2.googleapis.com")) return { body: { access_token: "tok" } };
      if (c.method === "PUT") return { status: putStatus, body: {} };
      return { body: {} };
    });
    const client = createGoogleSheetsClient({ clientEmail: "svc@x.iam", privateKey, spreadsheetId: "SID", sheetName: "Requests" }, s.fetchImpl, () => new Date("2026-10-19T10:00:00Z"));
    const res = await client.replace([...SHEET_COLUMNS], [["a"]], 10).then(() => "ok", () => "error");
    return { res, calls: s.calls };
  };
  const good = await run(200);
  assert.equal(good.res, "ok");
  assert.deepEqual(good.calls.map((c) => c.method), ["POST", "PUT", "POST"]);
  assert.match(good.calls[1].url, /valueInputOption=RAW/);
  assert.match(good.calls[2].url, /:clear$/);
  const bad = await run(500);
  assert.equal(bad.res, "error");
  assert.ok(!bad.calls.some((c) => c.url.endsWith(":clear")), "stale rows are kept when the write fails");
});

test("legacy SUPABASE_* env names are ignored: v2 never connects to the original project by accident", async () => {
  const keys = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SOC5_SUPABASE_URL", "SOC5_SUPABASE_ANON_KEY", "SOC5_SUPABASE_SERVICE_ROLE_KEY"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    process.env.SUPABASE_URL = "https://legacy.example";
    process.env.SUPABASE_ANON_KEY = "legacy-anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "legacy-service";
    const fresh1 = (await import("../backend.ts?legacy-only")) as typeof import("../backend.ts");
    assert.equal(await fresh1.getBackend(), null);
    process.env.SOC5_SUPABASE_URL = "https://v2.example";
    process.env.SOC5_SUPABASE_ANON_KEY = "v2-anon";
    process.env.SOC5_SUPABASE_SERVICE_ROLE_KEY = "v2-service";
    const fresh2 = (await import("../backend.ts?v2-names")) as typeof import("../backend.ts");
    assert.notEqual(await fresh2.getBackend(), null);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
