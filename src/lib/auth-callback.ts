// Pure parsing of the sign-in return URL (Google OAuth fragment, SeaTalk redirect query). Tokens only ever arrive in
// the URL FRAGMENT (not logged by servers or proxies) and are removed from the address bar immediately.
export type CallbackResult =
  | { kind: "token"; token: string; expiresIn: number; provider: string | null }
  | { kind: "pending" }
  | { kind: "error"; message: string }
  | { kind: "none" };

const REASONS: Record<string, string> = {
  invalid_state: "The SeaTalk sign-in expired or was tampered with. Please start again.",
  cancelled: "SeaTalk sign-in was cancelled.",
  missing_code: "SeaTalk did not return a sign-in code. Please try again.",
  login_failed: "We could not sign you in with SeaTalk. Please try again or use another method.",
  disabled: "This account is disabled. Contact your administrator.",
  domain_not_allowed: "Your work email domain is not eligible for registration.",
};

export function parseAuthCallback(hash: string, search: string): CallbackResult {
  const frag = new URLSearchParams(hash.replace(/^#/, ""));
  const query = new URLSearchParams(search);
  const err = frag.get("error_description") ?? frag.get("error");
  if (err) return { kind: "error", message: `Sign-in failed: ${err.slice(0, 200)}` };
  const token = frag.get("access_token");
  if (token && /^[A-Za-z0-9._~+/=-]{20,4096}$/.test(token)) {
    const exp = Number(frag.get("expires_in"));
    return { kind: "token", token, expiresIn: Number.isFinite(exp) && exp > 0 ? exp : 3600, provider: frag.get("provider") };
  }
  if (query.get("seatalk") === "pending") return { kind: "pending" };
  if (query.get("seatalk") === "error") return { kind: "error", message: REASONS[query.get("reason") ?? ""] ?? REASONS.login_failed };
  return { kind: "none" };
}
