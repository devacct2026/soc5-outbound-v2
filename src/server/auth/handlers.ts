// Sign-in flows (lead 6): Ops ID (backroom), Google OAuth, email OTP, Login with SeaTalk, forced password change,
// access requests, and user administration. All provider calls go through server-side gateways; the browser
// receives only a short-lived access token (never a refresh token, service key or Supabase configuration).
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { isUuid } from "../../domain/requests/validation.ts";
import type { Role } from "../../domain/requests/workflow.ts";
import type { Backend } from "../backend.ts";
import { json } from "../api.ts";
import { errorResponse } from "../commands.ts";
import { readBodyLimited } from "../http-body.ts";
import { clientKey, type RateLimiter } from "../rate-limit.ts";
import type { SeaTalkLogin } from "../seatalk/provider.ts";
import type { GoTrueGateway } from "./gotrue.ts";
import type { UserPort } from "./users.ts";

export const BACKROOM_DOMAIN = "backroom.soc5.internal";
const OPS_ID = /^ops[0-9]{1,37}$/i;

export interface AuthServices {
  gotrue: GoTrueGateway;
  users: UserPort;
  /** Allow-listed web origin: the ONLY redirect target (never client supplied). */
  webOrigin: string;
  /** HMAC key for the SeaTalk `state` parameter. */
  stateSecret: string;
  seatalk?: { appId: string; redirectUri: string; sdkUrl: string; login: SeaTalkLogin };
  limiters: { backroomIp: RateLimiter; backroomOps: RateLimiter; otpIp: RateLimiter; otpEmail: RateLimiter; access: RateLimiter };
  now?: () => Date;
}

type Params = Record<string, string> | undefined;
const send = (code: string, details?: unknown) => {
  const r = errorResponse(code, details);
  return json(r.status, r.body);
};

async function readJson(request: Request, max = 4096): Promise<Record<string, unknown> | Response> {
  const raw = await readBodyLimited(request, max);
  if (raw === null) return send("PAYLOAD_TOO_LARGE");
  try {
    const v = JSON.parse(raw || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return send("BAD_REQUEST");
    return v as Record<string, unknown>;
  } catch {
    return send("BAD_REQUEST");
  }
}
const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : "");

function services(backend: Backend | null): AuthServices | Response {
  if (!backend?.auth) return send("BACKEND_NOT_CONFIGURED");
  return backend.auth;
}

const tokenReply = (s: { accessToken: string; expiresIn: number }, extra: Record<string, unknown> = {}) =>
  json(200, { access_token: s.accessToken, expires_in: s.expiresIn, ...extra });

// ------------------------------------------------------------------ Ops ID (backroom)
export async function backroomLoginHandler(backend: Backend | null, request: Request): Promise<Response> {
  const a = services(backend);
  if (a instanceof Response) return a;
  if (!a.limiters.backroomIp.allow(clientKey(request))) return send("RATE_LIMITED");
  const b = await readJson(request);
  if (b instanceof Response) return b;
  const opsId = str(b.ops_id, 40).trim().toLowerCase();
  const password = str(b.password, 200);
  if (!OPS_ID.test(opsId) || !password) return send("VALIDATION_FAILED", { ops_id: "Ops ID such as ops123 and a password are required" });
  if (!a.limiters.backroomOps.allow(`${clientKey(request)}|${opsId}`)) return send("RATE_LIMITED");
  const profile = await a.users.backroomProfile(opsId);
  const grant = await a.gotrue.passwordGrant(`${opsId}@${BACKROOM_DOMAIN}`, password);
  if (!grant.ok) return grant.reason === "INVALID" ? send("UNAUTHENTICATED") : send("AUTH_UNAVAILABLE");
  if (!profile) return send("UNAUTHENTICATED"); // disabled / unprovisioned: same answer as a bad password
  return tokenReply(grant.value, { must_change_password: profile.mustChangePassword });
}

// ------------------------------------------------------------------ email OTP + Google
async function domainAllowed(a: AuthServices, email: string) {
  const dom = email.split("@")[1] ?? "";
  return (await a.users.allowedDomains()).includes(dom);
}
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,200}$/;

export async function otpRequestHandler(backend: Backend | null, request: Request): Promise<Response> {
  const a = services(backend);
  if (a instanceof Response) return a;
  if (!a.limiters.otpIp.allow(clientKey(request))) return send("RATE_LIMITED");
  const b = await readJson(request);
  if (b instanceof Response) return b;
  const email = str(b.email, 254).trim().toLowerCase();
  if (!EMAIL.test(email)) return send("VALIDATION_FAILED", { email: "valid work email required" });
  if (!(await domainAllowed(a, email))) return send("VALIDATION_FAILED", { email: "this email domain is not eligible" });
  if (!a.limiters.otpEmail.allow(email)) return send("RATE_LIMITED"); // resend cooldown
  const r = await a.gotrue.otpRequest(email);
  return r.ok ? json(200, { ok: true }) : send("AUTH_UNAVAILABLE");
}

export async function otpVerifyHandler(backend: Backend | null, request: Request): Promise<Response> {
  const a = services(backend);
  if (a instanceof Response) return a;
  if (!a.limiters.otpIp.allow(`verify:${clientKey(request)}`)) return send("RATE_LIMITED");
  const b = await readJson(request);
  if (b instanceof Response) return b;
  const email = str(b.email, 254).trim().toLowerCase();
  const code = str(b.code, 12).trim();
  if (!EMAIL.test(email) || !/^\d{6}$/.test(code)) return send("VALIDATION_FAILED", { code: "6-digit code required" });
  const r = await a.gotrue.otpVerify(email, code);
  if (!r.ok) return r.reason === "INVALID" ? send("UNAUTHENTICATED") : send("AUTH_UNAVAILABLE");
  return tokenReply(r.value);
}

/** Returns the hosted Google URL; the redirect target is the configured web origin only. */
export async function googleStartHandler(backend: Backend | null, _request?: Request): Promise<Response> {
  void _request;
  const a = services(backend);
  if (a instanceof Response) return a;
  return json(200, { url: a.gotrue.googleAuthorizeUrl(`${a.webOrigin}/auth/callback`) });
}

// ------------------------------------------------------------------ Login with SeaTalk (official flow)
const STATE_TTL_MS = 10 * 60_000;
const sign = (secret: string, v: string) => createHmac("sha256", secret).update(v).digest("base64url");

export function makeState(secret: string, now: Date, nonce = randomBytes(16).toString("base64url")) {
  const body = `${now.getTime() + STATE_TTL_MS}.${nonce}`;
  return { state: `${body}.${sign(secret, body)}`, nonce };
}
export function verifyState(secret: string, state: string, cookieNonce: string | null, now: Date): boolean {
  const parts = state.split(".");
  if (parts.length !== 3 || !cookieNonce) return false;
  const body = `${parts[0]}.${parts[1]}`;
  const good = Buffer.from(sign(secret, body));
  const given = Buffer.from(parts[2]);
  if (good.length !== given.length || !timingSafeEqual(good, given)) return false;
  if (!(Number(parts[0]) > now.getTime())) return false;
  const a = Buffer.from(parts[1]);
  const c = Buffer.from(cookieNonce);
  return a.length === c.length && timingSafeEqual(a, c); // bound to the browser that asked for the login
}

const COOKIE = "soc5_seatalk_state";
const cookieOf = (request: Request) => /(?:^|;\s*)soc5_seatalk_state=([A-Za-z0-9_-]+)/.exec(request.headers.get("cookie") ?? "")?.[1] ?? null;

export async function seatalkConfigHandler(backend: Backend | null, request: Request): Promise<Response> {
  const a = services(backend);
  if (a instanceof Response) return a;
  if (!a.seatalk) return send("SEATALK_LOGIN_DISABLED");
  const { state, nonce } = makeState(a.stateSecret, (a.now ?? (() => new Date()))());
  const secure = new URL(a.seatalk.redirectUri).protocol === "https:" ? "; Secure" : "";
  const res = json(200, { app_id: a.seatalk.appId, redirect_uri: a.seatalk.redirectUri, response_type: "code", state, sdk_url: a.seatalk.sdkUrl });
  res.headers.append("set-cookie", `${COOKIE}=${nonce}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secure}`);
  void request;
  return res;
}

export async function seatalkCallbackHandler(backend: Backend | null, request: Request): Promise<Response> {
  const a = services(backend);
  if (a instanceof Response) return a;
  const back = (query: Record<string, string>, fragment?: Record<string, string>) => {
    const u = new URL("/auth/callback", a.webOrigin);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    if (fragment) u.hash = new URLSearchParams(fragment).toString(); // tokens only ever travel in the fragment
    const res = new Response(null, { status: 302, headers: { location: u.toString(), "cache-control": "no-store" } });
    res.headers.append("set-cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return res;
  };
  const err = (reason: string) => back({ seatalk: "error", reason });
  if (!a.seatalk) return err("login_failed");
  const q = new URL(request.url).searchParams;
  if (q.get("error")) return err("cancelled");
  const code = q.get("code");
  if (!code || code.length > 200) return err("missing_code");
  const now = (a.now ?? (() => new Date()))();
  if (!verifyState(a.stateSecret, q.get("state") ?? "", cookieOf(request), now)) return err("invalid_state");
  try {
    const emp = await a.seatalk.login.codeToEmployee(code); // provider-verified identity (org membership)
    if (!EMAIL.test(emp.email)) return err("login_failed");
    let profile = await a.users.profileBySeatalk(emp.employeeCode);
    if (!profile) {
      const byEmail = await a.users.profileByEmail(emp.email);
      if (byEmail) {
        if (byEmail.seatalkEmployeeCode && byEmail.seatalkEmployeeCode !== emp.employeeCode) return err("login_failed"); // identity mismatch
        if (!byEmail.seatalkEmployeeCode && !(await a.users.bindSeatalk(byEmail.id, emp.employeeCode))) return err("login_failed");
        profile = byEmail;
      }
    }
    if (!profile) {
      // SEA-7: automatic registration for a verified SeaTalk member with an approved email domain.
      if (!(await domainAllowed(a, emp.email))) return err("domain_not_allowed");
      const created = await a.gotrue.adminCreateUser({
        email: emp.email,
        appMetadata: { provider: "seatalk", seatalk_employee_code: emp.employeeCode }, // server-written only
        userMetadata: { full_name: emp.name },
      });
      return created.ok ? back({ seatalk: "pending" }) : err("login_failed");
    }
    if (profile.accountStatus === "DISABLED") return err("disabled");
    if (profile.accountStatus !== "ACTIVE" || !profile.role) return back({ seatalk: "pending" });
    const session = await a.gotrue.adminSession(profile.email);
    if (!session.ok) return err("login_failed");
    return back({ seatalk: "success" }, { access_token: session.value.accessToken, expires_in: String(session.value.expiresIn), provider: "seatalk" });
  } catch {
    return err("login_failed");
  }
}

// ------------------------------------------------------------------ account status + forced password change
/** Works for PENDING_APPROVAL/DISABLED accounts too (no operational access, only the status itself). */
export async function accountStatusHandler(backend: Backend | null, request: Request): Promise<Response> {
  if (!backend?.account) return send("BACKEND_NOT_CONFIGURED");
  const s = await backend.account(request);
  if (!s) return send("UNAUTHENTICATED");
  return json(200, { account_status: s.status, role: s.status === "ACTIVE" ? s.role : null, must_change_password: s.mustChangePassword });
}

export async function passwordChangedHandler(backend: Backend | null, request: Request): Promise<Response> {
  const a = services(backend);
  if (a instanceof Response) return a;
  if (!backend) return send("BACKEND_NOT_CONFIGURED");
  const actor = await backend.authenticate(request);
  if (!actor || !actor.active) return send("UNAUTHENTICATED");
  if (actor.role !== "ops_pic" && actor.role !== "doc_officer") return send("FORBIDDEN");
  const b = await readJson(request);
  if (b instanceof Response) return b;
  const password = str(b.password, 200);
  if (password.length < 12) return send("VALIDATION_FAILED", { password: "at least 12 characters" });
  if (!actor.mustChangePassword) return send("INVALID_STATE"); // nothing to change unless a reset/creation required it
  const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const r = await a.gotrue.setOwnPassword(token, password);
  if (!r.ok) return r.reason === "INVALID" ? send("VALIDATION_FAILED", { password: "rejected by the identity provider" }) : send("AUTH_UNAVAILABLE");
  if (r.value.id !== actor.id) return send("AUTH_UNAVAILABLE"); // the token must belong to the caller
  const m = await a.users.markPasswordChanged(actor.id);
  return m.ok ? json(200, { ok: true }) : send("INVALID_STATE");
}

// ------------------------------------------------------------------ access requests (unauthenticated)
export async function accessRequestHandler(backend: Backend | null, request: Request): Promise<Response> {
  const a = services(backend);
  if (a instanceof Response) return a;
  if (!a.limiters.access.allow(clientKey(request))) return send("RATE_LIMITED");
  const b = await readJson(request);
  if (b instanceof Response) return b;
  const name = str(b.name, 120).trim();
  const ops = str(b.ops_id, 40).trim().toLowerCase();
  if (name.length < 2 || !OPS_ID.test(ops)) return send("VALIDATION_FAILED", { name: "2-120 characters", ops_id: "Ops ID such as ops123" });
  const r = await a.users.submitAccessRequest(name, ops);
  return r.ok ? json(201, { ok: true }) : send("VALIDATION_FAILED");
}

// ------------------------------------------------------------------ user administration
const MANAGER_ROLES: Role[] = ["fte_ops", "fte_mm"];

async function manager(backend: Backend | null, request: Request) {
  const a = services(backend);
  if (a instanceof Response) return { res: a };
  if (!backend) return { res: send("BACKEND_NOT_CONFIGURED") };
  const actor = await backend.authenticate(request);
  if (!actor || !actor.active) return { res: send("UNAUTHENTICATED") };
  if (!(actor.isAdmin || MANAGER_ROLES.includes(actor.role))) return { res: send("FORBIDDEN") };
  return { a, actor };
}
const needKey = (request: Request) => {
  const k = request.headers.get("idempotency-key");
  return k && k.length >= 8 && k.length <= 200 ? null : send("IDEMPOTENCY_KEY_REQUIRED");
};

/** 20 chars with every class present (one-time initial password, shown once, never stored or logged). */
export function generatePassword(length = 20): string {
  const sets = ["abcdefghijkmnopqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789", "!@#$%^&*-_=+?"];
  const all = sets.join("");
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export async function listUsersHandler(backend: Backend | null, request: Request): Promise<Response> {
  const m = await manager(backend, request);
  if (m.res) return m.res;
  const rows = await m.a!.users.list();
  return json(200, {
    data: rows.map((u) => ({
      id: u.id, name: u.fullName, role: u.role, email: u.accountStatus === "ACTIVE" && u.opsId ? null : u.email, ops_id: u.opsId,
      account_status: u.accountStatus, must_change_password: u.mustChangePassword,
    })),
  });
}

export async function createUserHandler(backend: Backend | null, request: Request): Promise<Response> {
  const m = await manager(backend, request);
  if (m.res) return m.res;
  const k = needKey(request);
  if (k) return k;
  const b = await readJson(request);
  if (b instanceof Response) return b;
  const name = str(b.name, 120).trim();
  const ops = str(b.ops_id, 40).trim().toLowerCase();
  const role = (b.role === undefined ? "ops_pic" : b.role) as Role;
  if (name.length < 2 || !OPS_ID.test(ops) || (role !== "ops_pic" && role !== "doc_officer")) {
    return send("VALIDATION_FAILED", { name: "2-120 characters", ops_id: "Ops ID such as ops123", role: "ops_pic or doc_officer" });
  }
  const { a, actor } = m as { a: AuthServices; actor: { id: string } };
  if (await a.users.backroomProfile(ops)) return send("OPS_ID_TAKEN");
  const password = generatePassword();
  const created = await a.gotrue.adminCreateUser({ email: `${ops}@${BACKROOM_DOMAIN}`, password, appMetadata: { account_type: "backroom" }, userMetadata: { ops_id: ops } });
  if (!created.ok) return send("VALIDATION_FAILED", { ops_id: "unable to create the authentication account" });
  const row = await a.users.createBackroom({ id: created.value.id, name, opsId: ops, role, actorId: actor.id });
  if (!row.ok) {
    await a.gotrue.adminDeleteUser(created.value.id); // compensate: no orphaned authentication account
    return send(row.code === "OPS_ID_TAKEN" ? "OPS_ID_TAKEN" : "VALIDATION_FAILED");
  }
  return json(201, { id: created.value.id, name, ops_id: ops, role, must_change_password: true, initial_password: password });
}

export async function updateUserHandler(backend: Backend | null, request: Request, params: Params): Promise<Response> {
  const m = await manager(backend, request);
  if (m.res) return m.res;
  const k = needKey(request);
  if (k) return k;
  const id = params?.id ?? "";
  if (!isUuid(id)) return send("NOT_FOUND");
  const b = await readJson(request);
  if (b instanceof Response) return b;
  const name = str(b.name, 120).trim();
  const role = b.role as Role;
  if (name.length < 2 || !["ops_pic", "fte_ops", "fte_mm", "doc_officer"].includes(role)) return send("VALIDATION_FAILED", { name: "2-120 characters", role: "operational role required" });
  const { a, actor } = m as { a: AuthServices; actor: { id: string } };
  const r = await a.users.update({ id, name, role, actorId: actor.id });
  return r.ok ? json(200, { ok: true }) : send(r.code === "SELF_CHANGE" ? "SELF_CHANGE" : "NOT_FOUND");
}

export async function disableUserHandler(backend: Backend | null, request: Request, params: Params): Promise<Response> {
  const m = await manager(backend, request);
  if (m.res) return m.res;
  const k = needKey(request);
  if (k) return k;
  const id = params?.id ?? "";
  if (!isUuid(id)) return send("NOT_FOUND");
  const { a, actor } = m as { a: AuthServices; actor: { id: string } };
  const r = await a.users.disableBackroom(id, actor.id);
  return r.ok ? json(200, { ok: true }) : send(r.code === "SELF_CHANGE" ? "SELF_CHANGE" : "NOT_FOUND");
}

export async function resetPasswordHandler(backend: Backend | null, request: Request, params: Params): Promise<Response> {
  const m = await manager(backend, request);
  if (m.res) return m.res;
  const k = needKey(request);
  if (k) return k;
  const id = params?.id ?? "";
  if (!isUuid(id)) return send("NOT_FOUND");
  const { a, actor } = m as { a: AuthServices; actor: { id: string } };
  const target = await a.users.profileById(id);
  if (!target || !target.opsId || target.accountStatus !== "ACTIVE" || (target.role !== "ops_pic" && target.role !== "doc_officer")) return send("NOT_FOUND");
  const mark = await a.users.markPasswordReset(id, actor.id);
  if (!mark.ok) return send("NOT_FOUND");
  const password = generatePassword();
  const set = await a.gotrue.adminSetPassword(id, password);
  if (!set.ok) return send("AUTH_UNAVAILABLE"); // still flagged: the old password works only until it is changed
  return json(200, { ok: true, initial_password: password });
}
