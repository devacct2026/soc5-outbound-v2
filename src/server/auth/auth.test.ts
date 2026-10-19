import { test } from "node:test";
import assert from "node:assert/strict";
import { createGoTrue } from "./gotrue.ts";
import {
  accessRequestHandler, accountStatusHandler, backroomLoginHandler, createUserHandler, disableUserHandler, generatePassword, googleStartHandler,
  listUsersHandler, makeState, otpRequestHandler, otpVerifyHandler, passwordChangedHandler, resetPasswordHandler, seatalkCallbackHandler,
  seatalkConfigHandler, updateUserHandler, verifyState, type AuthServices,
} from "./handlers.ts";
import type { ProfileRow, UserOpResult, UserPort } from "./users.ts";
import { makeBackend, type Backend } from "../backend.ts";
import { meHandler, queueHandler } from "../api.ts";
import { MemoryStore } from "../memory.ts";
import { createRateLimiter } from "../rate-limit.ts";
import type { Actor } from "../../domain/requests/workflow.ts";
import { SeaTalkProviderError, type SeaTalkEmployee } from "../seatalk/provider.ts";

const NOW = new Date("2026-10-19T10:00:00Z");
const WEB = "https://app.example";
const BACKROOM = "backroom.soc5.internal";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

class FakeUsers implements UserPort {
  rows = new Map<string, ProfileRow>();
  domains = ["spxexpress.com"];
  accessRequests: [string, string][] = [];
  failCreate = false;
  audit: string[] = [];
  add(p: Partial<ProfileRow> & { id: string }) {
    const row: ProfileRow = { fullName: "", email: `${p.id}@spxexpress.com`, role: null, opsId: null, accountStatus: "PENDING_APPROVAL", mustChangePassword: false, seatalkEmployeeCode: null, ...p };
    this.rows.set(row.id, row);
    return row;
  }
  private find(f: (r: ProfileRow) => boolean) { return [...this.rows.values()].find(f) ?? null; }
  async backroomProfile(ops: string) { return this.find((r) => r.opsId === ops.toLowerCase() && r.accountStatus === "ACTIVE" && (r.role === "ops_pic" || r.role === "doc_officer")); }
  async profileByEmail(e: string) { return this.find((r) => r.email === e.toLowerCase()); }
  async profileBySeatalk(c: string) { return this.find((r) => r.seatalkEmployeeCode === c); }
  async profileById(id: string) { return this.rows.get(id) ?? null; }
  async bindSeatalk(id: string, code: string) { if (this.find((r) => r.seatalkEmployeeCode === code)) return false; this.rows.get(id)!.seatalkEmployeeCode = code; return true; }
  async allowedDomains() { return this.domains; }
  async list() { return [...this.rows.values()]; }
  async createBackroom(a: { id: string; name: string; opsId: string; role: "ops_pic" | "doc_officer" | "fte_ops" | "fte_mm"; actorId: string }): Promise<UserOpResult> {
    if (this.failCreate) return { ok: false, code: "VALIDATION_FAILED" };
    if (this.find((r) => r.opsId === a.opsId)) return { ok: false, code: "OPS_ID_TAKEN" };
    this.add({ id: a.id, fullName: a.name, opsId: a.opsId, role: a.role, accountStatus: "ACTIVE", mustChangePassword: true, email: `${a.opsId}@${BACKROOM}` });
    this.audit.push(`USER_CREATED:${a.actorId}`);
    return { ok: true };
  }
  async update(a: { id: string; name: string; role: ProfileRow["role"]; actorId: string }): Promise<UserOpResult> {
    if (a.id === a.actorId) return { ok: false, code: "SELF_CHANGE" };
    const r = this.rows.get(a.id);
    if (!r || r.accountStatus === "PENDING_APPROVAL") return { ok: false, code: "NOT_FOUND" };
    Object.assign(r, { fullName: a.name, role: a.role });
    this.audit.push("USER_UPDATED");
    return { ok: true };
  }
  async markPasswordReset(id: string): Promise<UserOpResult> { const r = this.rows.get(id); if (!r?.opsId) return { ok: false, code: "NOT_FOUND" }; r.mustChangePassword = true; this.audit.push("PASSWORD_RESET"); return { ok: true }; }
  async markPasswordChanged(id: string): Promise<UserOpResult> { const r = this.rows.get(id); if (!r?.mustChangePassword) return { ok: false, code: "INVALID_STATE" }; r.mustChangePassword = false; return { ok: true }; }
  async disableBackroom(id: string, actorId: string): Promise<UserOpResult> {
    if (id === actorId) return { ok: false, code: "SELF_CHANGE" };
    const r = this.rows.get(id);
    if (!r?.opsId || r.accountStatus !== "ACTIVE") return { ok: false, code: "NOT_FOUND" };
    r.accountStatus = "DISABLED";
    return { ok: true };
  }
  async submitAccessRequest(name: string, ops: string): Promise<UserOpResult> { this.accessRequests.push([name, ops]); return { ok: true }; }
}

interface Call { method: string; path: string; body: Record<string, unknown>; headers: Record<string, string> }
function goTrueStub() {
  const calls: Call[] = [];
  const passwords = new Map<string, string>([[`ops100@${BACKROOM}`, "correct-horse-battery"]]);
  const otps = new Map<string, string>([["new@spxexpress.com", "123456"]]);
  const created: Record<string, unknown>[] = [];
  let failAdminCreate = false;
  let ownPasswordUser = ID(900);
  const f = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname.replace("/auth/v1", "") + u.search;
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ method: init.method ?? "GET", path, body, headers: init.headers as Record<string, string> });
    const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (path.startsWith("/token?grant_type=password")) return passwords.get(String(body.email)) === body.password ? ok({ access_token: "access-ops", refresh_token: "REFRESH-SECRET", expires_in: 3600 }) : ok({ error: "invalid_grant" }, 400);
    if (path === "/otp") return ok({});
    if (path === "/verify") {
      if (body.type === "magiclink") return body.token_hash === "hash-1" ? ok({ access_token: "access-seatalk", expires_in: 3000, refresh_token: "R" }) : ok({}, 401);
      return otps.get(String(body.email)) === body.token ? ok({ access_token: "access-otp", expires_in: 3600 }) : ok({}, 403);
    }
    if (path === "/user" && init.method === "PUT") return ok({ id: ownPasswordUser });
    if (path === "/admin/users" && init.method === "POST") { if (failAdminCreate) return ok({}, 422); created.push(body); return ok({ id: ID(500 + created.length) }); }
    if (path.startsWith("/admin/users/") && init.method === "PUT") return ok({});
    if (path.startsWith("/admin/users/") && init.method === "DELETE") return ok({});
    if (path === "/admin/generate_link") return ok({ hashed_token: "hash-1" });
    return ok({}, 404);
  }) as typeof fetch;
  return { f, calls, created, passwords, setFailCreate: (v: boolean) => (failAdminCreate = v), setOwnUser: (id: string) => (ownPasswordUser = id) };
}

function setup() {
  const users = new FakeUsers();
  const gt = goTrueStub();
  let employee: SeaTalkEmployee | Error = { employeeCode: "E9", name: "Sam", email: "sam@spxexpress.com" };
  const auth: AuthServices = {
    gotrue: createGoTrue({ url: "https://proj.supabase.co", anonKey: "anon-key", serviceKey: "service-key", fetchImpl: gt.f }),
    users,
    webOrigin: WEB,
    stateSecret: "s".repeat(40),
    seatalk: { appId: "app1", redirectUri: "https://api.example/api/v1/auth/seatalk/callback", sdkUrl: "https://static.cdn.haiserve.com/seatalk/client/shared/sop/auth.js", login: { codeToEmployee: async () => { if (employee instanceof Error) throw employee; return employee; } } },
    limiters: {
      backroomIp: createRateLimiter({ limit: 20, windowMs: 60_000 }), backroomOps: createRateLimiter({ limit: 5, windowMs: 60_000 }),
      otpIp: createRateLimiter({ limit: 10, windowMs: 60_000 }), otpEmail: createRateLimiter({ limit: 1, windowMs: 60_000 }), access: createRateLimiter({ limit: 3, windowMs: 600_000 }),
    },
    now: () => NOW,
  };
  const actors: Record<string, Actor> = {
    "tok-pic": { id: ID(1), role: "ops_pic", active: true },
    "tok-ops": { id: ID(2), role: "fte_ops", active: true },
    "tok-mm": { id: ID(3), role: "fte_mm", active: true },
    "tok-doc": { id: ID(4), role: "doc_officer", active: true },
    "tok-admin": { id: ID(5), role: "ops_pic", active: true, isAdmin: true },
    "tok-must": { id: ID(900), role: "ops_pic", active: true, mustChangePassword: true },
  };
  const backend: Backend = makeBackend({
    store: new MemoryStore(), now: () => NOW, auth,
    authenticate: async (r) => actors[(r.headers.get("authorization") ?? "").replace("Bearer ", "")] ?? null,
    account: async (r) => (r.headers.get("authorization") === "Bearer tok-pending" ? { status: "PENDING_APPROVAL", role: null, mustChangePassword: false } : null),
  });
  return { users, gt, auth, backend, setEmployee: (e: SeaTalkEmployee | Error) => (employee = e) };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://api.example/api/v1${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9", ...headers }, body: JSON.stringify(body) });
const authed = (path: string, method: string, token: string, body?: unknown) =>
  new Request(`https://api.example/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": `key-${crypto.randomUUID()}` }, body: body === undefined ? undefined : JSON.stringify(body) });

// ------------------------------------------------------------------ Ops ID
test("Ops ID login: token only (no refresh token), forced-change flag, generic failures, throttled per Ops ID", async () => {
  const s = setup();
  s.users.add({ id: ID(100), role: "ops_pic", opsId: "ops100", accountStatus: "ACTIVE", mustChangePassword: true });
  const ok = await backroomLoginHandler(s.backend, post("/auth/backroom/login", { ops_id: "OPS100", password: "correct-horse-battery" }));
  assert.equal(ok.status, 200);
  const text = await ok.text();
  assert.deepEqual(JSON.parse(text), { access_token: "access-ops", expires_in: 3600, must_change_password: true });
  assert.ok(!text.includes("REFRESH-SECRET"));
  assert.equal(s.gt.calls[0].body.email, `ops100@${BACKROOM}`);
  assert.equal((await backroomLoginHandler(s.backend, post("/auth/backroom/login", { ops_id: "ops100", password: "wrong" }))).status, 401);
  for (const bad of [{ ops_id: "bob", password: "x" }, { ops_id: "ops1; drop", password: "x" }, { ops_id: "ops100" }, { ops_id: "ops100", password: "" }]) {
    assert.equal((await backroomLoginHandler(s.backend, post("/auth/backroom/login", bad))).status, 422, JSON.stringify(bad));
  }
  s.users.rows.get(ID(100))!.accountStatus = "DISABLED";
  assert.equal((await backroomLoginHandler(s.backend, post("/auth/backroom/login", { ops_id: "ops100", password: "correct-horse-battery" }))).status, 401, "a disabled account is indistinguishable from a wrong password");
  const s2 = setup();
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await backroomLoginHandler(s2.backend, post("/auth/backroom/login", { ops_id: "ops100", password: "wrong" }))).status);
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429, 429], "5 attempts per address+Ops ID per minute");
  assert.equal((await backroomLoginHandler(makeBackend({ store: new MemoryStore(), authenticate: async () => null }), post("/auth/backroom/login", { ops_id: "ops1", password: "x" }))).status, 503);
});

// ------------------------------------------------------------------ OTP + Google
test("email OTP: domain allow-list, resend cooldown, 6-digit code, token only; Google start never accepts a client redirect", async () => {
  const s = setup();
  assert.equal((await otpRequestHandler(s.backend, post("/auth/otp/request", { email: "x@gmail.com" }))).status, 422, "foreign domain");
  assert.equal((await otpRequestHandler(s.backend, post("/auth/otp/request", { email: "New@SPXexpress.com" }))).status, 200);
  assert.deepEqual(s.gt.calls.at(-1)!.body, { email: "new@spxexpress.com", create_user: true });
  assert.equal((await otpRequestHandler(s.backend, post("/auth/otp/request", { email: "new@spxexpress.com" }))).status, 429, "60 s resend cooldown");
  assert.equal((await otpVerifyHandler(s.backend, post("/auth/otp/verify", { email: "new@spxexpress.com", code: "12ab56" }))).status, 422);
  assert.equal((await otpVerifyHandler(s.backend, post("/auth/otp/verify", { email: "new@spxexpress.com", code: "000000" }))).status, 401);
  const ok = await otpVerifyHandler(s.backend, post("/auth/otp/verify", { email: "new@spxexpress.com", code: "123456" }));
  assert.deepEqual(await ok.json(), { access_token: "access-otp", expires_in: 3600 });
  const g = await googleStartHandler(s.backend, new Request("https://api.example/x?redirect_to=https://evil.example"));
  const url = new URL((await g.json()).url);
  assert.equal(url.origin + url.pathname, "https://proj.supabase.co/auth/v1/authorize");
  assert.equal(url.searchParams.get("provider"), "google");
  assert.equal(url.searchParams.get("redirect_to"), `${WEB}/auth/callback`, "redirect target is configured, never client supplied");
});

// ------------------------------------------------------------------ SeaTalk
async function seatalkStart(s: ReturnType<typeof setup>) {
  const res = await seatalkConfigHandler(s.backend, new Request("https://api.example/x"));
  const cfg = await res.json();
  const cookie = /soc5_seatalk_state=([A-Za-z0-9_-]+)/.exec(res.headers.get("set-cookie") ?? "")![1];
  return { cfg, cookie, setCookie: res.headers.get("set-cookie")! };
}
const callback = (s: ReturnType<typeof setup>, query: string, cookie?: string) =>
  seatalkCallbackHandler(s.backend, new Request(`https://api.example/api/v1/auth/seatalk/callback?${query}`, { headers: cookie ? { cookie: `soc5_seatalk_state=${cookie}` } : {} }));
const loc = (r: Response) => new URL(r.headers.get("location")!);

test("SeaTalk login config: official SDK attributes, signed state bound to an HttpOnly cookie", async () => {
  const s = setup();
  const { cfg, setCookie } = await seatalkStart(s);
  assert.deepEqual(Object.keys(cfg).sort(), ["app_id", "redirect_uri", "response_type", "sdk_url", "state"]);
  assert.equal(cfg.response_type, "code");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Secure/, "https redirect URI => Secure cookie");
  const { state, nonce } = makeState("k".repeat(40), NOW, "n1");
  assert.equal(verifyState("k".repeat(40), state, nonce, NOW), true);
  assert.equal(verifyState("k".repeat(40), state, "other", NOW), false, "cookie binding");
  assert.equal(verifyState("x".repeat(40), state, nonce, NOW), false, "signature");
  assert.equal(verifyState("k".repeat(40), state, nonce, new Date(NOW.getTime() + 11 * 60_000)), false, "expiry");
  const noSeatalk = setup();
  noSeatalk.auth.seatalk = undefined;
  assert.equal((await seatalkConfigHandler(noSeatalk.backend, new Request("https://x"))).status, 503);
});

test("SeaTalk callback: success mints a session in the URL FRAGMENT; pending/disabled/foreign/forged/cancelled outcomes never do", async () => {
  const s = setup();
  s.users.add({ id: ID(60), email: "sam@spxexpress.com", role: "fte_ops", accountStatus: "ACTIVE", seatalkEmployeeCode: "E9" });
  const { cfg, cookie } = await seatalkStart(s);
  const good = await callback(s, `code=abc&state=${encodeURIComponent(cfg.state)}`, cookie);
  assert.equal(good.status, 302);
  const u = loc(good);
  assert.equal(u.origin + u.pathname, `${WEB}/auth/callback`);
  assert.equal(u.search, "?seatalk=success", "no token in the query string");
  assert.equal(new URLSearchParams(u.hash.slice(1)).get("access_token"), "access-seatalk");
  assert.match(good.headers.get("set-cookie") ?? "", /Max-Age=0/, "state cookie cleared");
  // forged / missing state
  const forged = loc(await callback(s, `code=abc&state=${encodeURIComponent(cfg.state)}`, "wrongnonce"));
  assert.equal(forged.searchParams.get("reason"), "invalid_state");
  assert.equal(loc(await callback(s, "code=abc&state=x.y.z", cookie)).searchParams.get("reason"), "invalid_state");
  assert.equal(loc(await callback(s, `code=abc&state=${encodeURIComponent(cfg.state)}`)).searchParams.get("reason"), "invalid_state", "no cookie");
  assert.equal(loc(await callback(s, "error=access_denied")).searchParams.get("reason"), "cancelled");
  assert.equal(loc(await callback(s, `state=${encodeURIComponent(cfg.state)}`, cookie)).searchParams.get("reason"), "missing_code");
  // pending + disabled
  s.users.rows.get(ID(60))!.accountStatus = "PENDING_APPROVAL";
  assert.equal(loc(await callback(s, `code=abc&state=${encodeURIComponent(cfg.state)}`, cookie)).searchParams.get("seatalk"), "pending");
  s.users.rows.get(ID(60))!.accountStatus = "DISABLED";
  assert.equal(loc(await callback(s, `code=abc&state=${encodeURIComponent(cfg.state)}`, cookie)).searchParams.get("reason"), "disabled");
  // provider failure
  s.setEmployee(new SeaTalkProviderError("TRANSIENT", "down"));
  assert.equal(loc(await callback(s, `code=abc&state=${encodeURIComponent(cfg.state)}`, cookie)).searchParams.get("reason"), "login_failed");
});

test("SeaTalk callback: email match binds the employee code once; a different bound identity is refused; no admin session is minted unless ACTIVE", async () => {
  const s = setup();
  s.users.add({ id: ID(61), email: "sam@spxexpress.com", role: "fte_mm", accountStatus: "ACTIVE" });
  const { cfg, cookie } = await seatalkStart(s);
  const q = `code=abc&state=${encodeURIComponent(cfg.state)}`;
  assert.equal(loc(await callback(s, q, cookie)).searchParams.get("seatalk"), "success");
  assert.equal(s.users.rows.get(ID(61))!.seatalkEmployeeCode, "E9", "bound on first verified login");
  s.setEmployee({ employeeCode: "E-OTHER", name: "Imposter", email: "sam@spxexpress.com" });
  assert.equal(loc(await callback(s, q, cookie)).searchParams.get("reason"), "login_failed", "same email, different SeaTalk identity");
  assert.equal(s.gt.calls.filter((c) => c.path === "/admin/generate_link").length, 1, "session minted exactly once");
});

test("SeaTalk auto-registration (SEA-7): verified member + approved domain => PENDING_APPROVAL account, server-written metadata, no session", async () => {
  const s = setup();
  s.setEmployee({ employeeCode: "E77", name: "New Hire", email: "new.hire@spxexpress.com" });
  const { cfg, cookie } = await seatalkStart(s);
  const q = `code=abc&state=${encodeURIComponent(cfg.state)}`;
  const r = await callback(s, q, cookie);
  assert.equal(loc(r).searchParams.get("seatalk"), "pending");
  assert.ok(!loc(r).hash.includes("access_token"));
  const created = s.gt.created[0] as { email: string; app_metadata: Record<string, unknown>; user_metadata: Record<string, unknown> };
  assert.equal(created.email, "new.hire@spxexpress.com");
  assert.deepEqual(created.app_metadata, { provider: "seatalk", seatalk_employee_code: "E77" });
  assert.deepEqual(created.user_metadata, { full_name: "New Hire" });
  assert.equal(s.gt.calls.filter((c) => c.path === "/admin/generate_link").length, 0);
  s.setEmployee({ employeeCode: "E78", name: "Outsider", email: "o@contractor.example" });
  assert.equal(loc(await callback(s, q, cookie)).searchParams.get("reason"), "domain_not_allowed");
  s.users.domains = []; // an empty allow-list denies everyone
  s.setEmployee({ employeeCode: "E79", name: "X", email: "x@spxexpress.com" });
  assert.equal(loc(await callback(s, q, cookie)).searchParams.get("reason"), "domain_not_allowed");
});

// ------------------------------------------------------------------ forced password change + status
test("forced password change: every API except /auth/me is blocked until the password is changed; then the flag clears", async () => {
  const s = setup();
  s.users.add({ id: ID(900), role: "ops_pic", opsId: "ops900", accountStatus: "ACTIVE", mustChangePassword: true });
  const blocked = await queueHandler(s.backend, authed("/requests/queue", "GET", "tok-must"));
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error, "PASSWORD_CHANGE_REQUIRED");
  const me = await meHandler(s.backend, authed("/auth/me", "GET", "tok-must"));
  assert.equal(me.status, 200);
  assert.equal((await me.json()).must_change_password, true);
  assert.equal((await passwordChangedHandler(s.backend, authed("/auth/password-changed", "POST", "tok-must", { password: "short" }))).status, 422);
  assert.equal((await passwordChangedHandler(s.backend, authed("/auth/password-changed", "POST", "tok-ops", { password: "long-enough-password-1" }))).status, 403, "FTE accounts do not use this flow");
  s.gt.setOwnUser(ID(777));
  assert.equal((await passwordChangedHandler(s.backend, authed("/auth/password-changed", "POST", "tok-must", { password: "long-enough-password-1" }))).status, 503, "token must belong to the caller");
  s.gt.setOwnUser(ID(900));
  const ok = await passwordChangedHandler(s.backend, authed("/auth/password-changed", "POST", "tok-must", { password: "long-enough-password-1" }));
  assert.equal(ok.status, 200);
  assert.equal(s.users.rows.get(ID(900))!.mustChangePassword, false);
  const put = s.gt.calls.find((c) => c.method === "PUT" && c.path === "/user")!;
  assert.equal(put.headers.authorization, "Bearer tok-must", "changed with the caller's OWN token");
  assert.equal((await passwordChangedHandler(s.backend, authed("/auth/password-changed", "POST", "tok-pic", { password: "long-enough-password-1" }))).status, 409, "nothing to change");
});

test("account status: a PENDING_APPROVAL identity learns only its status; unknown tokens get 401", async () => {
  const s = setup();
  const r = await accountStatusHandler(s.backend, authed("/auth/status", "GET", "tok-pending"));
  assert.deepEqual(await r.json(), { account_status: "PENDING_APPROVAL", role: null, must_change_password: false });
  assert.equal((await accountStatusHandler(s.backend, authed("/auth/status", "GET", "nobody"))).status, 401);
  assert.equal((await queueHandler(s.backend, authed("/requests/queue", "GET", "tok-pending"))).status, 401, "no operational access while pending");
});

// ------------------------------------------------------------------ access requests
test("access requests: public, validated, throttled to 3 per 10 minutes", async () => {
  const v = setup();
  assert.equal((await accessRequestHandler(v.backend, post("/access-requests", { name: "A", ops_id: "ops1" }))).status, 422);
  assert.equal((await accessRequestHandler(v.backend, post("/access-requests", { name: "Ann Lee", ops_id: "nope" }))).status, 422);
  const s = setup();
  const codes: number[] = [];
  for (let i = 0; i < 4; i++) codes.push((await accessRequestHandler(s.backend, post("/access-requests", { name: "Ann Lee", ops_id: "OPS123" }))).status);
  assert.deepEqual(codes, [201, 201, 201, 429]);
  assert.deepEqual(s.users.accessRequests[0], ["Ann Lee", "ops123"]);
});

// ------------------------------------------------------------------ user administration
test("user admin: FTE Ops/MM or administrator only; create returns a one-time password and compensates on failure", async () => {
  const s = setup();
  for (const t of ["tok-pic", "tok-doc"]) {
    assert.equal((await listUsersHandler(s.backend, authed("/users", "GET", t))).status, 403, t);
    assert.equal((await createUserHandler(s.backend, authed("/users", "POST", t, { name: "Bo Ops", ops_id: "ops5" }))).status, 403, t);
  }
  assert.equal((await listUsersHandler(s.backend, authed("/users", "GET", "nobody"))).status, 401);
  const created = await createUserHandler(s.backend, authed("/users", "POST", "tok-ops", { name: "Bo Ops", ops_id: "OPS5", role: "doc_officer" }));
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(body.ops_id, "ops5");
  assert.equal(body.must_change_password, true);
  assert.match(body.initial_password, /^.{20}$/);
  assert.deepEqual(s.gt.created[0].app_metadata, { account_type: "backroom" });
  assert.equal(s.gt.created[0].password, body.initial_password);
  assert.equal((await createUserHandler(s.backend, authed("/users", "POST", "tok-mm", { name: "Bo Ops", ops_id: "ops5" }))).status, 409, "duplicate Ops ID");
  assert.equal((await createUserHandler(s.backend, authed("/users", "POST", "tok-ops", { name: "Bo", ops_id: "ops6", role: "fte_ops" }))).status, 422, "FTE roles are not created here");
  const noKey = new Request("https://x/users", { method: "POST", headers: { authorization: "Bearer tok-ops", "content-type": "application/json" }, body: JSON.stringify({ name: "Bo Ops", ops_id: "ops6" }) });
  assert.equal((await createUserHandler(s.backend, noKey)).status, 400, "idempotency key required");
  s.users.failCreate = true;
  s.gt.calls.length = 0;
  const failed = await createUserHandler(s.backend, authed("/users", "POST", "tok-admin", { name: "Cy Ops", ops_id: "ops7" }));
  assert.equal(failed.status, 422);
  assert.ok(s.gt.calls.some((c) => c.method === "DELETE" && c.path.startsWith("/admin/users/")), "the auth account is rolled back");
});

test("user admin: update (no self change), reset-password (active backroom only, fresh one-time password), disable, list hides privileged fields", async () => {
  const s = setup();
  s.users.add({ id: ID(2), fullName: "Ops One", role: "fte_ops", accountStatus: "ACTIVE", email: "ops1@spxexpress.com", seatalkEmployeeCode: "E-SECRET" });
  s.users.add({ id: ID(70), fullName: "Pat Pic", role: "ops_pic", opsId: "ops70", accountStatus: "ACTIVE", email: `ops70@${BACKROOM}` });
  s.users.add({ id: ID(71), fullName: "Pending", accountStatus: "PENDING_APPROVAL" });
  assert.equal((await updateUserHandler(s.backend, authed(`/users/${ID(2)}`, "PUT", "tok-ops", { name: "Me", role: "fte_mm" }), { id: ID(2) })).status, 409, "no self role change");
  assert.equal((await updateUserHandler(s.backend, authed(`/users/${ID(70)}`, "PUT", "tok-ops", { name: "Pat P", role: "doc_officer" }), { id: ID(70) })).status, 200);
  assert.equal((await updateUserHandler(s.backend, authed(`/users/${ID(70)}`, "PUT", "tok-ops", { name: "Pat P", role: "god" }), { id: ID(70) })).status, 422);
  assert.equal((await updateUserHandler(s.backend, authed(`/users/${ID(71)}`, "PUT", "tok-ops", { name: "Pending", role: "fte_ops" }), { id: ID(71) })).status, 404, "pending accounts are approved by an administrator, not edited here");
  s.gt.calls.length = 0;
  const reset = await resetPasswordHandler(s.backend, authed(`/users/${ID(70)}/reset-password`, "POST", "tok-ops"), { id: ID(70) });
  assert.equal(reset.status, 200);
  const rb = await reset.json();
  assert.match(rb.initial_password, /^.{20}$/);
  assert.equal(s.gt.calls[0].path, `/admin/users/${ID(70)}`);
  assert.equal(s.gt.calls[0].body.password, rb.initial_password);
  assert.equal(s.users.rows.get(ID(70))!.mustChangePassword, true);
  assert.equal((await resetPasswordHandler(s.backend, authed(`/users/${ID(2)}/reset-password`, "POST", "tok-ops"), { id: ID(2) })).status, 404, "FTE accounts have no password reset here");
  assert.equal((await resetPasswordHandler(s.backend, authed(`/users/${ID(70)}/reset-password`, "POST", "tok-ops"), { id: "not-a-uuid" })).status, 404);
  const list = await (await listUsersHandler(s.backend, authed("/users", "GET", "tok-mm"))).json();
  const flat = JSON.stringify(list);
  assert.ok(!flat.includes("E-SECRET") && !flat.includes("is_admin"), "no SeaTalk identity or privilege flags in the directory");
  assert.equal((await disableUserHandler(s.backend, authed(`/users/${ID(70)}/disable`, "PATCH", "tok-ops"), { id: ID(70) })).status, 200);
  assert.equal(s.users.rows.get(ID(70))!.accountStatus, "DISABLED");
  assert.equal((await disableUserHandler(s.backend, authed(`/users/${ID(70)}/disable`, "PATCH", "tok-ops"), { id: ID(70) })).status, 404);
  assert.equal((await disableUserHandler(s.backend, authed(`/users/${ID(2)}/disable`, "PATCH", "tok-ops"), { id: ID(2) })).status, 409, "no self-disable");
});

test("generated passwords: 20 characters, every class present, no ambiguity characters, not repeating", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const p = generatePassword();
    assert.equal(p.length, 20);
    assert.match(p, /[a-z]/); assert.match(p, /[A-Z]/); assert.match(p, /[0-9]/); assert.match(p, /[!@#$%^&*\-_=+?]/);
    assert.doesNotMatch(p, /[0Ol1I]/);
    seen.add(p);
  }
  assert.equal(seen.size, 50);
});
