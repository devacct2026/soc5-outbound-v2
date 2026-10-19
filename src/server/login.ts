// Password sign-in proxy. The browser never holds Supabase configuration: this
// server handler performs the password grant with the (public-by-design) anon key
// and returns only the short-lived access token. No refresh token is returned.
// Throttled per address (anonLimiter); credentials are never logged.
import type { Backend } from "./backend.ts";
import { json } from "./api.ts";
import { readBodyLimited } from "./http-body.ts";
import { clientKey } from "./rate-limit.ts";

export interface LoginConfig {
  url: string;
  anonKey: string;
  fetchImpl?: typeof fetch;
}

export function makeLoginHandler(cfg: () => LoginConfig | null) {
  return async function loginHandler(backend: Backend | null, request: Request): Promise<Response> {
    const conf = cfg();
    if (!backend || !conf) return json(503, { error: "BACKEND_NOT_CONFIGURED" });
    if (backend.anonLimiter && !backend.anonLimiter.allow(`login:${clientKey(request)}`)) return json(429, { error: "RATE_LIMITED" });
    const raw = await readBodyLimited(request, 4096);
    if (raw === null) return json(413, { error: "PAYLOAD_TOO_LARGE" });
    let body: { email?: unknown; password?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "BAD_REQUEST" });
    }
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^[^\s@]{1,64}@[^\s@]{1,200}$/.test(email) || password.length < 1 || password.length > 200) {
      return json(422, { error: "VALIDATION_FAILED" });
    }
    try {
      const res = await (conf.fetchImpl ?? fetch)(`${conf.url.replace(/\/$/, "")}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: conf.anonKey, "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
      });
      if (!res.ok) return json(res.status === 400 || res.status === 401 ? 401 : 503, { error: res.status === 400 || res.status === 401 ? "UNAUTHENTICATED" : "AUTH_UNAVAILABLE" });
      const t = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!t.access_token) return json(503, { error: "AUTH_UNAVAILABLE" });
      // A valid Supabase user without an ACTIVE profile/role still gets no data: every API call re-checks the profile.
      return json(200, { access_token: t.access_token, expires_in: t.expires_in ?? 3600 });
    } catch {
      return json(503, { error: "AUTH_UNAVAILABLE" });
    }
  };
}

export const loginHandler = makeLoginHandler(() => {
  const url = process.env.SOC5_SUPABASE_URL;
  const anonKey = process.env.SOC5_SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : null;
});
