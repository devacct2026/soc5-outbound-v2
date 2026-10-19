// SeaTalk Approval Center integration boundary (SEA-1..SEA-5).
//
// STATUS: contract UNVERIFIED. The official SeaTalk endpoints, payloads and
// signature scheme have not been verified against provider documentation or a
// sandbox (SEA-2; docs/backend/10-implementation-readiness.md). Everything here
// is a typed interface + mock-tested logic. Approval operations stay disabled
// (Features.seatalkApproval=false) and the real provider is not implemented.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Actor } from "../../domain/requests/workflow.ts";
import { canonicalJson } from "../commands.ts";

export class ProviderDisabledError extends Error {
  constructor() {
    super("SeaTalk provider is disabled");
  }
}

/** Outbound alert delivery (NOT-1). Real implementation blocked on provider contract. */
export interface AlertSender {
  send(alert: {
    dedupeKey: string;
    requestId: string;
    event: string;
    recipientUserId?: string;
    recipientRole?: string;
  }): Promise<{ acknowledged: boolean }>;
}
export const disabledAlertSender: AlertSender = {
  async send() {
    throw new ProviderDisabledError();
  },
};

/** Approval item provisioning/sync port (SEA-5: SOC5 DB stays authoritative). */
export interface ApprovalProvider {
  createItem(requestId: string, assigneeEmployeeCode: string): Promise<{ providerItemId: string }>;
  syncDecision(requestId: string, decision: "APPROVED" | "REJECTED" | "CANCELLED"): Promise<void>;
}
export const disabledApprovalProvider: ApprovalProvider = {
  async createItem() {
    throw new ProviderDisabledError();
  },
  async syncDecision() {
    throw new ProviderDisabledError();
  },
};

// ------------------------------------------------------------------ signature
export interface SignatureConfig {
  secret: string;
  /** Freshness window; the provider's real policy is reviewed separately (SEA-3). */
  maxSkewSeconds: number;
}

/**
 * ASSUMED scheme (replace with the official provider scheme once verified):
 * hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`) in `x-signature`, with the
 * epoch-seconds `x-timestamp`. Constant-time comparison.
 */
export function signCallback(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export type SignatureResult = { ok: true } | { ok: false; reason: "MISSING" | "STALE" | "BAD_SIGNATURE" };

export function verifyCallbackSignature(
  cfg: SignatureConfig,
  headers: Headers,
  rawBody: string,
  now: Date,
): SignatureResult {
  const sig = headers.get("x-signature");
  const ts = headers.get("x-timestamp");
  if (!sig || !ts || !/^\d{9,12}$/.test(ts) || !/^[0-9a-f]{64}$/i.test(sig)) return { ok: false, reason: "MISSING" };
  if (Math.abs(now.getTime() / 1000 - Number(ts)) > cfg.maxSkewSeconds) return { ok: false, reason: "STALE" };
  const expected = Buffer.from(signCallback(cfg.secret, ts, rawBody), "hex");
  const given = Buffer.from(sig, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? { ok: true }
    : { ok: false, reason: "BAD_SIGNATURE" };
}

// ------------------------------------------------------------------ callbacks
export interface AssignmentInfo {
  id: string;
  requestId: string;
  actor: Actor;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "CLOSED";
  tokenHash: string;
  expiresAt: string;
}

export type RecordResult =
  | { kind: "NEW"; id: string }
  | { kind: "DUPLICATE"; status: string }
  | { kind: "CONFLICT" };

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

export function parseCallback(raw: string, action: "approve" | "reject"): ParsedCallback | null {
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
  if (typeof o.token !== "string" || o.token.length < 8 || o.token.length > 500) return null;
  if (typeof emp !== "string" || !emp || emp.length > 100) return null;
  if (o.event_id !== undefined && (typeof o.event_id !== "string" || !o.event_id || o.event_id.length > 200)) return null;
  const reason = typeof o.reason === "string" ? o.reason.trim() : null;
  if (action === "reject" && (!reason || reason.length > 2000)) return null; // rejection reason required
  return {
    itemId: o.item_id,
    token: o.token,
    employeeCode: emp,
    eventId: (o.event_id as string | undefined) ?? null,
    reason,
  };
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const callbackFingerprint = (raw: string) => sha256(canonicalJson(JSON.parse(raw)));

export function tokenMatches(token: string, expectedHash: string): boolean {
  const a = Buffer.from(sha256(token), "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
