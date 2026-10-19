// Supabase Auth (GoTrue) gateway used by the sign-in flows. Server-side only: the browser never receives
// Supabase configuration, the service-role key, or refresh tokens. Request shapes follow the public GoTrue REST
// API; none of this has run against a live project (no approved credentials) - see docs/implementation-progress.md.
export interface Session {
  accessToken: string;
  expiresIn: number;
}

export type GateResult<T> = { ok: true; value: T } | { ok: false; reason: "INVALID" | "UNAVAILABLE" };

export interface GoTrueConfig {
  url: string;
  anonKey: string;
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

export interface GoTrueGateway {
  passwordGrant(email: string, password: string): Promise<GateResult<Session>>;
  otpRequest(email: string): Promise<GateResult<null>>;
  otpVerify(email: string, code: string): Promise<GateResult<Session>>;
  /** Hosted Google OAuth URL; redirect_to is always the configured, allow-listed web origin. */
  googleAuthorizeUrl(redirectTo: string): string;
  /** Change the CALLER's own password with their own access token; returns the user id on success. */
  setOwnPassword(accessToken: string, password: string): Promise<GateResult<{ id: string }>>;
  adminCreateUser(u: { email: string; password?: string; appMetadata: Record<string, unknown>; userMetadata?: Record<string, unknown> }): Promise<GateResult<{ id: string }>>;
  adminSetPassword(userId: string, password: string): Promise<GateResult<null>>;
  adminDeleteUser(userId: string): Promise<GateResult<null>>;
  /** Mint a session for an already-verified identity (SeaTalk): magic-link token exchanged server-side. */
  adminSession(email: string): Promise<GateResult<Session>>;
}

export function createGoTrue(cfg: GoTrueConfig): GoTrueGateway {
  const f = cfg.fetchImpl ?? fetch;
  const base = `${cfg.url.replace(/\/$/, "")}/auth/v1`;
  const anon = { apikey: cfg.anonKey, "content-type": "application/json" };
  const admin = { apikey: cfg.serviceKey, authorization: `Bearer ${cfg.serviceKey}`, "content-type": "application/json" };

  async function req(path: string, init: RequestInit & { headers: Record<string, string> }): Promise<{ status: number; body: Record<string, unknown> } | null> {
    try {
      const res = await f(`${base}${path}`, { ...init, signal: AbortSignal.timeout(8000), cache: "no-store" });
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        /* non-JSON error body */
      }
      return { status: res.status, body };
    } catch {
      return null; // network error/timeout: never surface URLs or credentials
    }
  }
  const classify = (r: { status: number } | null): "INVALID" | "UNAVAILABLE" =>
    r && r.status >= 400 && r.status < 500 && r.status !== 429 ? "INVALID" : "UNAVAILABLE";
  const session = (b: Record<string, unknown>): Session | null =>
    typeof b.access_token === "string" && b.access_token ? { accessToken: b.access_token, expiresIn: typeof b.expires_in === "number" ? b.expires_in : 3600 } : null;

  return {
    async passwordGrant(email, password) {
      const r = await req("/token?grant_type=password", { method: "POST", headers: anon, body: JSON.stringify({ email, password }) });
      const s = r && r.status === 200 ? session(r.body) : null;
      return s ? { ok: true, value: s } : { ok: false, reason: classify(r) };
    },
    async otpRequest(email) {
      const r = await req("/otp", { method: "POST", headers: anon, body: JSON.stringify({ email, create_user: true }) });
      return r && r.status === 200 ? { ok: true, value: null } : { ok: false, reason: classify(r) };
    },
    async otpVerify(email, code) {
      const r = await req("/verify", { method: "POST", headers: anon, body: JSON.stringify({ type: "email", email, token: code }) });
      const s = r && r.status === 200 ? session(r.body) : null;
      return s ? { ok: true, value: s } : { ok: false, reason: classify(r) };
    },
    googleAuthorizeUrl(redirectTo) {
      return `${base}/authorize?${new URLSearchParams({ provider: "google", redirect_to: redirectTo, prompt: "select_account" })}`;
    },
    async setOwnPassword(accessToken, password) {
      const r = await req("/user", { method: "PUT", headers: { apikey: cfg.anonKey, authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ password }) });
      const id = r && r.status === 200 && typeof r.body.id === "string" ? r.body.id : null;
      return id ? { ok: true, value: { id } } : { ok: false, reason: classify(r) };
    },
    async adminCreateUser(u) {
      const r = await req("/admin/users", {
        method: "POST", headers: admin,
        body: JSON.stringify({ email: u.email, ...(u.password ? { password: u.password } : {}), email_confirm: true, app_metadata: u.appMetadata, user_metadata: u.userMetadata ?? {} }),
      });
      const id = r && (r.status === 200 || r.status === 201) && typeof r.body.id === "string" ? r.body.id : null;
      return id ? { ok: true, value: { id } } : { ok: false, reason: classify(r) };
    },
    async adminSetPassword(userId, password) {
      const r = await req(`/admin/users/${encodeURIComponent(userId)}`, { method: "PUT", headers: admin, body: JSON.stringify({ password }) });
      return r && r.status === 200 ? { ok: true, value: null } : { ok: false, reason: classify(r) };
    },
    async adminDeleteUser(userId) {
      const r = await req(`/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE", headers: admin });
      return r && (r.status === 200 || r.status === 204) ? { ok: true, value: null } : { ok: false, reason: classify(r) };
    },
    async adminSession(email) {
      const link = await req("/admin/generate_link", { method: "POST", headers: admin, body: JSON.stringify({ type: "magiclink", email }) });
      const hashed = link && link.status === 200 ? (link.body.hashed_token ?? (link.body.properties as { hashed_token?: unknown } | undefined)?.hashed_token) : null;
      if (typeof hashed !== "string" || !hashed) return { ok: false, reason: classify(link) };
      const v = await req("/verify", { method: "POST", headers: anon, body: JSON.stringify({ type: "magiclink", token_hash: hashed }) });
      const s = v && v.status === 200 ? session(v.body) : null;
      return s ? { ok: true, value: s } : { ok: false, reason: classify(v) };
    },
  };
}
