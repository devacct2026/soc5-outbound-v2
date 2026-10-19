// Browser-side API access. The access token lives in sessionStorage only (cleared
// when the tab closes) and is sent as a Bearer header; no service-role key or
// Supabase secret ever reaches the browser.
const KEY = "soc5-access-token";
const API = (process.env.NEXT_PUBLIC_SOC5_API_URL ?? "").replace(/\/$/, "");

export function getToken(): string | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const { token, exp } = JSON.parse(raw) as { token: string; exp: number };
    if (Date.now() >= exp) {
      window.sessionStorage.removeItem(KEY);
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

export function setToken(token: string, expiresInSeconds: number) {
  window.sessionStorage.setItem(KEY, JSON.stringify({ token, exp: Date.now() + Math.max(expiresInSeconds - 30, 30) * 1000 }));
  window.dispatchEvent(new Event("soc5-auth-change"));
}

export function clearToken() {
  window.sessionStorage.removeItem(KEY);
  window.dispatchEvent(new Event("soc5-auth-change"));
}

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * A 401 from an operational endpoint can simply mean "valid sign-in, no ACTIVE account yet" (PENDING_APPROVAL, DISABLED),
 * so only the identity endpoint decides that the token itself is dead. Otherwise a pending user would be signed out
 * before ever seeing the "awaiting approval" message.
 */
const tokenIsDead = (path: string) => /^\/auth\/status(\?|$)/.test(path);

async function parse(res: Response) {
  return (await res.json().catch(() => ({}))) as { error?: string; details?: unknown };
}

export async function apiGet<T>(path: string): Promise<T> {
  const token = getToken();
  if (!token) throw new ApiError(401, "NOT_SIGNED_IN");
  const res = await fetch(`${API}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (res.status === 401 && tokenIsDead(path)) clearToken();
  if (!res.ok) {
    const b = await parse(res);
    throw new ApiError(res.status, b.error ?? `HTTP ${res.status}`, b.details);
  }
  return (await res.json()) as T;
}

/** Public (unauthenticated) call used by the sign-in flows. Never sends a token. */
export async function apiPublic<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "include", // the SeaTalk state cookie is set by /auth/seatalk/config
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; details?: unknown };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`, data.details);
  return data;
}

export interface Session {
  mustChangePassword: boolean;
}

export async function signIn(email: string, password: string): Promise<Session> {
  const res = await fetch(`${API}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new ApiError(res.status, res.status === 401 ? "Invalid email or password" : "Sign-in unavailable");
  const { access_token, expires_in } = (await res.json()) as { access_token: string; expires_in: number };
  setToken(access_token, expires_in);
  return { mustChangePassword: false };
}

export async function signInOpsId(opsId: string, password: string): Promise<Session> {
  const r = await apiPublic<{ access_token: string; expires_in: number; must_change_password: boolean }>("POST", "/auth/backroom/login", { ops_id: opsId, password });
  setToken(r.access_token, r.expires_in);
  return { mustChangePassword: r.must_change_password };
}

export const requestEmailCode = (email: string) => apiPublic<{ ok: true }>("POST", "/auth/otp/request", { email });

export async function verifyEmailCode(email: string, code: string): Promise<Session> {
  const r = await apiPublic<{ access_token: string; expires_in: number }>("POST", "/auth/otp/verify", { email, code });
  setToken(r.access_token, r.expires_in);
  return { mustChangePassword: false };
}

export const googleUrl = () => apiPublic<{ url: string }>("GET", "/auth/google/start");
export const seatalkConfig = () =>
  apiPublic<{ app_id: string; redirect_uri: string; response_type: "code"; state: string; sdk_url: string }>("GET", "/auth/seatalk/config");

/**
 * Mutating call: every request carries an Idempotency-Key supplied by the caller. The key is minted when a form opens,
 * so a double click or retry replays the first result instead of repeating the action (OPS-4).
 */
export async function apiSend<T>(method: "POST" | "PUT" | "PATCH", path: string, body: unknown, idempotencyKey: string): Promise<T> {
  const token = getToken();
  if (!token) throw new ApiError(401, "NOT_SIGNED_IN");
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; details?: unknown };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`, data.details);
  return data as T;
}

/** Authorized file download (KPI export): the token travels in the header, so a plain link would not work. */
export async function apiDownload(path: string, fallbackName: string): Promise<void> {
  const token = getToken();
  if (!token) throw new ApiError(401, "NOT_SIGNED_IN");
  const res = await fetch(`${API}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) {
    const b = await parse(res);
    throw new ApiError(res.status, b.error ?? `HTTP ${res.status}`);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const MESSAGES: Record<string, string> = {
  APPROVAL_PROVIDER_DISABLED: "Approval is handled by the SeaTalk Approval Center, which is not enabled yet. The request stays pending.",
  NOT_ASSIGNED_APPROVER: "This request is routed to a different approver in SeaTalk Approval Center.",
  NOT_APPROVED_IN_SEATALK: "Approve this request in SeaTalk Approval Center first, then apply it here.",
  PROVIDER_UNAVAILABLE: "SeaTalk Approval Center is unavailable. The request stays pending; try again shortly.",
  FORBIDDEN: "You are not allowed to do this.",
  NOT_FOUND: "Not found.",
  INVALID_STATE: "The request has already moved on. Refresh and try again.",
  NOT_CORRECTABLE: "This rejection is final and cannot be edited or resubmitted.",
  VERSION_CONFLICT: "Someone else changed this request. Refresh and try again.",
  VALIDATION_FAILED: "Please check the values entered.",
  REMARKS_REQUIRED: "Remarks are required.",
  NO_DRIVER_ASSIGNED: "A driver must be assigned first.",
  DRIVER_ALREADY_ASSIGNED: "A driver is already assigned. Use reassign instead.",
  RATE_LIMITED: "Too many requests. Please wait a moment.",
  PASSWORD_CHANGE_REQUIRED: "You must change your password before continuing.",
  OPS_ID_TAKEN: "That Ops ID is already registered.",
  SELF_CHANGE: "You cannot change your own account here.",
  UNAUTHENTICATED: "Invalid credentials or code.",
  AUTH_UNAVAILABLE: "Sign-in is temporarily unavailable.",
  SEATALK_LOGIN_DISABLED: "Login with SeaTalk is not configured.",
  RANGE_TOO_LARGE: "That range is too large to report. Choose a shorter period.",
};
export const friendlyError = (e: unknown) => {
  if (!(e instanceof ApiError)) return "Request failed";
  const base = MESSAGES[e.message] ?? `Request failed (${e.message})`;
  const d = e.details;
  if (d && typeof d === "object") {
    const fields = Object.entries(d as Record<string, string>).map(([k, v]) => `${k}: ${v}`);
    if (fields.length) return `${base} ${fields.join("; ")}`;
  }
  return base;
};
