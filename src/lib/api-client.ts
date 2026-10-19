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
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const token = getToken();
  if (!token) throw new ApiError(401, "NOT_SIGNED_IN");
  const res = await fetch(`${API}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (res.status === 401) clearToken();
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function signIn(email: string, password: string): Promise<void> {
  const res = await fetch(`${API}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new ApiError(res.status, res.status === 401 ? "Invalid email or password" : "Sign-in unavailable");
  const { access_token, expires_in } = (await res.json()) as { access_token: string; expires_in: number };
  setToken(access_token, expires_in);
}
