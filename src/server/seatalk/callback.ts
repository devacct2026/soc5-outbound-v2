// SeaTalk approval decision callbacks. Disabled unless Features.seatalkApproval
// AND a configured signature secret; never bypasses workflow validation.
import { approve, rejectRecord } from "../../domain/requests/lifecycle.ts";
import { fail, type Actor } from "../../domain/requests/workflow.ts";
import type { Backend } from "../backend.ts";
import { runCommand } from "../commands.ts";
import { json } from "../api.ts";
import { readBodyLimited } from "../http-body.ts";
import {
  sha256,
  callbackFingerprint,
  parseCallback,
  tokenMatches,
  verifyApprovalCallbackSignature,
  verifyEventSignature,
  type ApprovalStore,
  type AssignmentInfo,
  type SignatureConfig,
} from "./contract.ts";

export interface SeatalkWiring {
  /** Approve/reject callback verification (LIVE-UNVERIFIED scheme, see contract.ts). */
  signature: SignatureConfig;
  /** Official event-callback signing secret (verification handshake). */
  eventSecret?: string;
  approvals: ApprovalStore;
}

const ack = () => json(200, { code: 0 });

export type DecisionOutcome =
  | { kind: "PROCESSED" }
  | { kind: "IGNORED"; reason: string }
  | { kind: "RETRY" }
  | { kind: "FAILED"; status: number; body: unknown };

/**
 * Apply a verified SeaTalk decision through the normal workflow service (never directly to the
 * database). Shared by the callback endpoint and provider reconciliation so both obey the same
 * rules: current role/active status re-checked, stale assignments ignored, SOC5 stays authoritative.
 */
export async function applyProviderDecision(
  backend: Backend,
  wiring: SeatalkWiring,
  a: AssignmentInfo,
  action: "approve" | "reject",
  reason: string | null,
  idempotencyKey: string,
  payloadKey: unknown,
): Promise<DecisionOutcome> {
  if (a.status !== "PENDING" || Date.parse(a.expiresAt) < backend.now().getTime()) {
    return { kind: "IGNORED", reason: "ASSIGNMENT_NOT_ACTIVE" }; // late/stale decisions never apply
  }
  const actor: Actor = a.actor;
  if (!actor.active || actor.role !== "fte_ops") return { kind: "FAILED", status: 403, body: { error: "FORBIDDEN" } };
  const now = backend.now();
  const out = await runCommand(backend.store, {
    actor,
    requestId: a.requestId,
    method: "POST",
    path: `/integrations/seatalk/approval/${action}`,
    idempotencyKey: idempotencyKey.slice(0, 200),
    payload: payloadKey,
    authorize: (u, r) => !!r && u.role === "fte_ops",
    decide: (r) => {
      if (!r) return fail("INVALID_STATE");
      const ctx = { now, correlationId: crypto.randomUUID() };
      return action === "approve" ? approve(r, actor, ctx, "SEATALK") : rejectRecord(r, actor, reason ?? "", ctx);
    },
    features: backend.features,
  });
  if (out.status === 200) {
    await wiring.approvals.closeAssignment(a.id, action === "approve" ? "APPROVED" : "REJECTED");
    return { kind: "PROCESSED" };
  }
  const code = (out.body as { error?: string }).error;
  // SEA-5: SOC5 is authoritative; an already-decided request is not overwritten.
  if (out.status === 409 && code === "INVALID_STATE") return { kind: "IGNORED", reason: "REQUEST_ALREADY_DECIDED" };
  // Transient contention is NOT a decision: fail so the provider redelivers.
  if (code === "VERSION_CONFLICT") return { kind: "RETRY" };
  return { kind: "FAILED", status: out.status, body: out.body };
}

export async function seatalkDecisionHandler(
  backend: (Backend & { seatalk?: SeatalkWiring }) | null,
  request: Request,
  action: "approve" | "reject",
): Promise<Response> {
  if (!backend) return json(503, { error: "BACKEND_NOT_CONFIGURED" });
  const wiring = backend.seatalk;
  if (!backend.features.seatalkApproval || !wiring) return json(503, { error: "SEATALK_DISABLED" });

  const raw = await readBodyLimited(request, 64 * 1024);
  if (raw === null) return json(413, { error: "PAYLOAD_TOO_LARGE" });
  const sig = verifyApprovalCallbackSignature(wiring.signature, request, raw, backend.now());
  if (!sig.ok) return json(401, { error: "INVALID_SIGNATURE" }); // nothing is recorded or processed

  const cb = parseCallback(raw, new URL(request.url).searchParams.get("token"), action);
  if (!cb) return json(400, { error: "BAD_REQUEST" });

  const payloadHash = callbackFingerprint(raw);
  // SEA-4: provider-scoped event id; content fingerprint only when absent.
  const fallbackHash = cb.eventId
    ? null
    : // The token hash is part of the fingerprint so a forged callback with a bad token can
      // never consume the identity of the legitimate one.
      callbackFingerprint(JSON.stringify({ i: cb.itemId, e: cb.employeeCode, a: action, r: cb.reason, t: sha256(cb.token) }));
  const rec = await wiring.approvals.recordCallback({
    provider: "seatalk",
    eventId: cb.eventId,
    fallbackHash,
    payloadHash,
    employeeCode: cb.employeeCode,
    action,
  });
  if (rec.kind === "DUPLICATE") return ack(); // terminal outcome exists: acknowledged, never re-run
  if (rec.kind === "CONFLICT") return json(409, { error: "CALLBACK_CONFLICT" });

  const finish = (s: "PROCESSED" | "IGNORED" | "FAILED", reason?: string) => wiring.approvals.finishCallback(rec.id, s, reason);

  const a = await wiring.approvals.findAssignment(cb.itemId, cb.employeeCode);
  if (!a) {
    await finish("FAILED", "NO_ASSIGNMENT");
    return json(404, { error: "ASSIGNMENT_NOT_FOUND" });
  }
  if (!tokenMatches(cb.token, a.tokenHash)) {
    await finish("FAILED", "BAD_TOKEN");
    return json(403, { error: "FORBIDDEN" });
  }
  const out = await applyProviderDecision(
    backend,
    wiring,
    a,
    action,
    cb.reason,
    `seatalk:${cb.eventId ?? fallbackHash}`,
    { itemId: cb.itemId, action, reason: cb.reason },
  );
  switch (out.kind) {
    case "PROCESSED":
      await finish("PROCESSED");
      return ack();
    case "IGNORED":
      await finish("IGNORED", out.reason);
      return ack();
    case "RETRY":
      await finish("FAILED", "VERSION_CONFLICT");
      return json(503, { error: "RETRY_LATER" });
    default:
      await finish("FAILED", String((out.body as { error?: string }).error));
      return json(out.status, out.body);
  }
}

/**
 * Event callback endpoint (OFFICIAL contract): verify `Signature`, answer the verification handshake with
 * `{seatalk_challenge}`, and acknowledge other events with 200 without acting on them (no event type is a
 * workflow input). It has no workflow effect, so it works before approvals are enabled.
 */
export async function seatalkChallengeHandler(
  backend: (Backend & { seatalk?: SeatalkWiring }) | null,
  request: Request,
): Promise<Response> {
  if (!backend?.seatalk?.eventSecret) return json(503, { error: "SEATALK_DISABLED" });
  const raw = await readBodyLimited(request, 16 * 1024);
  if (raw === null) return json(413, { error: "PAYLOAD_TOO_LARGE" });
  const sig = verifyEventSignature(backend.seatalk.eventSecret, request.headers, raw);
  if (!sig.ok) return json(401, { error: "INVALID_SIGNATURE" });
  try {
    const v = JSON.parse(raw) as { event_type?: unknown; event?: { seatalk_challenge?: unknown } };
    if (v.event_type === "event_verification") {
      const c = v.event?.seatalk_challenge;
      if (typeof c === "string" && c.length > 0 && c.length < 500) return json(200, { seatalk_challenge: c });
      return json(400, { error: "BAD_REQUEST" });
    }
    return json(200, { code: 0 });
  } catch {
    return json(400, { error: "BAD_REQUEST" });
  }
}
