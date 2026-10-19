// SeaTalk approval decision callbacks. Disabled unless Features.seatalkApproval
// AND a configured signature secret; never bypasses workflow validation.
import { approve, rejectRecord } from "../../domain/requests/lifecycle.ts";
import { fail } from "../../domain/requests/workflow.ts";
import type { Backend } from "../backend.ts";
import { runCommand } from "../commands.ts";
import { json } from "../api.ts";
import { readBodyLimited } from "../http-body.ts";
import {
  sha256,
  callbackFingerprint,
  parseCallback,
  tokenMatches,
  verifyCallbackSignature,
  type ApprovalStore,
  type SignatureConfig,
} from "./contract.ts";

export interface SeatalkWiring {
  signature: SignatureConfig;
  approvals: ApprovalStore;
}

const ack = () => json(200, { code: 0 });

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
  const sig = verifyCallbackSignature(wiring.signature, request.headers, raw, backend.now());
  if (!sig.ok) return json(401, { error: "INVALID_SIGNATURE" }); // nothing is recorded or processed

  const cb = parseCallback(raw, action);
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

  const finish = (s: "PROCESSED" | "IGNORED" | "FAILED", reason?: string) =>
    wiring.approvals.finishCallback(rec.id, s, reason);

  const a = await wiring.approvals.findAssignment(cb.itemId, cb.employeeCode);
  if (!a) {
    await finish("FAILED", "NO_ASSIGNMENT");
    return json(404, { error: "ASSIGNMENT_NOT_FOUND" });
  }
  if (!tokenMatches(cb.token, a.tokenHash)) {
    await finish("FAILED", "BAD_TOKEN");
    return json(403, { error: "FORBIDDEN" });
  }
  if (a.status !== "PENDING" || Date.parse(a.expiresAt) < backend.now().getTime()) {
    await finish("IGNORED", "ASSIGNMENT_NOT_ACTIVE"); // late/stale decisions never apply
    return ack();
  }
  if (!a.actor.active || a.actor.role !== "fte_ops") {
    await finish("FAILED", "ACTOR_INELIGIBLE"); // current profile/role re-checked at decision time
    return json(403, { error: "FORBIDDEN" });
  }

  const now = backend.now();
  const out = await runCommand(backend.store, {
    actor: a.actor,
    requestId: a.requestId,
    method: "POST",
    path: `/integrations/seatalk/approval/${action}`,
    idempotencyKey: `seatalk:${cb.eventId ?? fallbackHash}`.slice(0, 200),
    payload: { itemId: cb.itemId, action, reason: cb.reason },
    authorize: (actor, r) => !!r && actor.role === "fte_ops",
    decide: (r) => {
      if (!r) return fail("INVALID_STATE");
      const ctx = { now, correlationId: crypto.randomUUID() };
      return action === "approve" ? approve(r, a.actor, ctx, "SEATALK") : rejectRecord(r, a.actor, cb.reason ?? "", ctx);
    },
    features: backend.features,
  });
  if (out.status === 200) {
    await wiring.approvals.closeAssignment(a.id, action === "approve" ? "APPROVED" : "REJECTED");
    await finish("PROCESSED");
    return ack();
  }
  const code = (out.body as { error?: string }).error;
  if (out.status === 409 && code === "INVALID_STATE") {
    // SEA-5: SOC5 is authoritative; an already-decided request is not overwritten.
    await finish("IGNORED", "REQUEST_ALREADY_DECIDED");
    return ack();
  }
  if (code === "VERSION_CONFLICT") {
    // Transient contention is NOT a decision: fail so the provider redelivers.
    await finish("FAILED", "VERSION_CONFLICT");
    return json(503, { error: "RETRY_LATER" });
  }
  await finish("FAILED", String((out.body as { error?: string }).error));
  return json(out.status, out.body);
}

/** Verification challenge (separate from decision callbacks). Echo only after signature check. */
export async function seatalkChallengeHandler(
  backend: (Backend & { seatalk?: SeatalkWiring }) | null,
  request: Request,
): Promise<Response> {
  if (!backend?.seatalk || !backend.features.seatalkApproval) return json(503, { error: "SEATALK_DISABLED" });
  const raw = await readBodyLimited(request, 16 * 1024);
  if (raw === null) return json(413, { error: "PAYLOAD_TOO_LARGE" });
  const sig = verifyCallbackSignature(backend.seatalk.signature, request.headers, raw, backend.now());
  if (!sig.ok) return json(401, { error: "INVALID_SIGNATURE" });
  try {
    const v = JSON.parse(raw) as { event?: { seatalk_challenge?: unknown } };
    const c = v.event?.seatalk_challenge;
    if (typeof c === "string" && c.length < 500) return json(200, { seatalk_challenge: c });
  } catch {
    /* fallthrough */
  }
  return json(400, { error: "BAD_REQUEST" });
}
