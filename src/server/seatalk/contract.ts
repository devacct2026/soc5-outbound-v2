// SeaTalk callback/signature boundary (SEA-1..SEA-5). The provider client lives in provider.ts.
//
// VERIFICATION STATUS (SEA-2/SEA-3):
//  * Event callbacks (/integrations/seatalk/events): signature = lowercase hex SHA-256(rawBody + signingSecret) in the
//    `Signature` header; handshake reply `{seatalk_challenge}` - OFFICIAL
//    (docs/seatalk-integration/server_api_event_callback.md, vendored from open.seatalk.io).
//  * Approve/reject callbacks: the official page "Approval Center Callback Signature Verification" is NOT available
//    offline. verifyApprovalCallbackSignature() implements the scheme of the ORIGINAL working integration (HMAC-SHA1 over
//    a 7-field canonical string). It has not been verified against a SeaTalk sandbox: LIVE-UNVERIFIED, and the
//    endpoints stay fail-closed unless approval is explicitly enabled.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Actor } from "../../domain/requests/workflow.ts";
import { canonicalJson } from "../commands.ts";

export class ProviderDisabledError extends Error {
  constructor() {
    super("SeaTalk provider is disabled");
  }
}

/**
 * Outbound SeaTalk chat alerts (NOT-1) beyond Approval Center items: the official send-message contract is not
 * available offline, so no sender is implemented (documented blocker). Approval alerts are the Approval Center items.
 */
export interface AlertSender {
  send(alert: { dedupeKey: string; requestId: string; event: string; recipientUserId?: string; recipientRole?: string }): Promise<{ acknowledged: boolean }>;
}
export const disabledAlertSender: AlertSender = {
  async send() {
    throw new ProviderDisabledError();
  },
};

// ------------------------------------------------------------------ signatures
export interface SignatureConfig {
  secret: string;
  /** Freshness window for schemes that carry a timestamp; the replay policy is reviewed separately (SEA-3). */
  maxSkewSeconds: number;
}
export type SignatureResult = { ok: true } | { ok: false; reason: "MISSING" | "STALE" | "BAD_SIGNATURE" };

const safeEqual = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/** OFFICIAL event-callback scheme: lowercase hex SHA-256(rawBody + signingSecret) in the `Signature` header. */
export function signEvent(secret: string, rawBody: string): string {
  return createHash("sha256").update(Buffer.concat([Buffer.from(rawBody), Buffer.from(secret)])).digest("hex");
}
export function verifyEventSignature(secret: string, headers: Headers, rawBody: string): SignatureResult {
  const sig = headers.get("signature");
  if (!secret || !sig || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: "MISSING" };
  return safeEqual(Buffer.from(sig, "hex"), Buffer.from(signEvent(secret, rawBody), "hex"))
    ? { ok: true }
    : { ok: false, reason: "BAD_SIGNATURE" };
}

const rawUrlEncode = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const urlDecode = (s: string) => decodeURIComponent(s.replace(/\+/g, " "));

/** Canonical query: decode, re-encode, sort pairs as strings (duplicates kept), join with "&". */
export function canonicalQuery(search: string): string {
  const query = search.replace(/^\?/, "");
  if (!query) return "";
  return query
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf("=");
      const k = i === -1 ? pair : pair.slice(0, i);
      const v = i === -1 ? "" : pair.slice(i + 1);
      try {
        return `${rawUrlEncode(urlDecode(k))}=${rawUrlEncode(urlDecode(v))}`;
      } catch {
        return `${k}=${v}`;
      }
    })
    .sort()
    .join("&");
}

/** ORIGINAL-INTEGRATION scheme (LIVE-UNVERIFIED): base64(HMAC-SHA1(secret, METHOD LF path LF content-type LF md5(body) LF date LF x-token LF query)). */
export function signApprovalCallback(
  secret: string,
  parts: { method: string; path: string; contentType: string; date: string; xToken: string; search: string },
  rawBody: string,
): string {
  const canonical = [
    parts.method.toUpperCase(),
    parts.path,
    parts.contentType,
    createHash("md5").update(rawBody).digest("hex"),
    parts.date,
    parts.xToken,
    canonicalQuery(parts.search),
  ].join("\n");
  return createHmac("sha1", secret).update(canonical).digest("base64");
}

export function verifyApprovalCallbackSignature(cfg: SignatureConfig, request: Request, rawBody: string, now: Date): SignatureResult {
  const h = request.headers;
  const contentType = h.get("content-type");
  const date = h.get("date");
  const xToken = h.get("x-token");
  const auth = h.get("authorization");
  if (!cfg.secret || !contentType || !date || !xToken || !auth) return { ok: false, reason: "MISSING" };
  if (!Number.isFinite(cfg.maxSkewSeconds) || cfg.maxSkewSeconds <= 0) return { ok: false, reason: "STALE" };
  const at = Date.parse(date); // the signed Date header doubles as the freshness/replay bound
  if (!Number.isFinite(at) || Math.abs(now.getTime() - at) > cfg.maxSkewSeconds * 1000) return { ok: false, reason: "STALE" };
  const u = new URL(request.url);
  const expected = signApprovalCallback(
    cfg.secret,
    { method: request.method, path: u.pathname, contentType, date, xToken, search: u.search },
    rawBody,
  );
  return safeEqual(Buffer.from(auth.trim()), Buffer.from(expected)) ? { ok: true } : { ok: false, reason: "BAD_SIGNATURE" };
}

/**
 * Signed sync endpoints fed by our own Google Apps Script (clusters, intraday). Same contract as the original
 * Edge Functions: `x-sync-source: google-apps-script`, `x-sync-timestamp` (epoch s), `x-sync-signature` = hex
 * HMAC-SHA256(secret, `${timestamp}.${rawBody}`), 300 s skew. Legacy `x-timestamp`/`x-signature` still accepted.
 */
export function signSync(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}
export const signCallback = signSync;

export function verifyCallbackSignature(cfg: SignatureConfig, headers: Headers, rawBody: string, now: Date): SignatureResult {
  // A misconfigured skew (NaN, <= 0) must fail closed, never disable the freshness check.
  if (!Number.isFinite(cfg.maxSkewSeconds) || cfg.maxSkewSeconds <= 0) return { ok: false, reason: "STALE" };
  const sig = headers.get("x-sync-signature") ?? headers.get("x-signature");
  const ts = headers.get("x-sync-timestamp") ?? headers.get("x-timestamp");
  if (!sig || !ts || !/^\d{9,12}$/.test(ts) || !/^[0-9a-f]{64}$/i.test(sig)) return { ok: false, reason: "MISSING" };
  if (Math.abs(now.getTime() / 1000 - Number(ts)) > cfg.maxSkewSeconds) return { ok: false, reason: "STALE" };
  return safeEqual(Buffer.from(sig, "hex"), Buffer.from(signSync(cfg.secret, ts, rawBody), "hex"))
    ? { ok: true }
    : { ok: false, reason: "BAD_SIGNATURE" };
}

// ------------------------------------------------------------------ callbacks
export interface AssignmentInfo {
  id: string;
  requestId: string;
  actor: Actor;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "CLOSED" | "FAILED";
  tokenHash: string;
  expiresAt: string;
}

/**
 * NEW/RETRY: process the callback. RETRY = the same payload was received before but never
 * reached a terminal outcome (RECEIVED or FAILED), so the provider's redelivery must be
 * processed again rather than silently acknowledged.
 * DUPLICATE: a terminal outcome (PROCESSED / IGNORED) already exists: acknowledge only.
 * CONFLICT: same provider event id with a different payload.
 */
export type RecordResult =
  | { kind: "NEW"; id: string }
  | { kind: "RETRY"; id: string }
  | { kind: "DUPLICATE"; status: string }
  | { kind: "CONFLICT" };

export const TERMINAL_CALLBACK_STATUSES = ["PROCESSED", "IGNORED"];

export interface ApprovalStore {
  /** Provider-scoped dedupe (SEA-4). Exactly one of eventId / fallbackHash is set. */
  recordCallback(e: {
    provider: string;
    eventId: string | null;
    fallbackHash: string | null;
    payloadHash: string;
    employeeCode: string;
    action: string;
  }): Promise<RecordResult>;
  finishCallback(id: string, status: "PROCESSED" | "IGNORED" | "FAILED", reason?: string): Promise<void>;
  findAssignment(providerItemId: string, employeeCode: string): Promise<AssignmentInfo | null>;
  closeAssignment(id: string, status: "APPROVED" | "REJECTED"): Promise<void>;
}

export interface ParsedCallback {
  itemId: string;
  token: string;
  employeeCode: string;
  eventId: string | null;
  reason: string | null;
}

/**
 * Official callback body: { item_id, reason, employee: { employee_code, name, email } }. The one-time token
 * travels on the callback URL we registered (?token=...), not in the body. `event_id` is not part of the
 * official body (SEA-4 then falls back to a content fingerprint) but is honoured if the provider adds it.
 */
export function parseCallback(raw: string, token: string | null, action: "approve" | "reject"): ParsedCallback | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const emp = (o.employee as Record<string, unknown> | undefined)?.employee_code;
  if (typeof o.item_id !== "string" || !o.item_id || o.item_id.length > 200) return null;
  if (typeof token !== "string" || token.length < 8 || token.length > 500) return null;
  if (typeof emp !== "string" || !emp || emp.length > 100) return null;
  if (o.event_id !== undefined && (typeof o.event_id !== "string" || !o.event_id || o.event_id.length > 200)) return null;
  const reason = typeof o.reason === "string" ? o.reason.trim() : null;
  if (action === "reject" && (!reason || reason.length > 2000)) return null; // rejection reason required
  return { itemId: o.item_id, token, employeeCode: emp, eventId: (o.event_id as string | undefined) ?? null, reason };
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const callbackFingerprint = (raw: string) => sha256(canonicalJson(JSON.parse(raw)));

export function tokenMatches(token: string, expectedHash: string): boolean {
  const a = Buffer.from(sha256(token), "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
