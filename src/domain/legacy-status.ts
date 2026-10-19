// Historical status reconciliation (ST-1..ST-8). Pure and side-effect free:
// produces a PREVIEW for review. Applying a plan is a separate, authorized
// step that must never run workflow side effects (no events, notifications,
// outbox or provider calls) and must preserve the original value.
export type LegacyStatus = "ASSIGNED" | "APPROVED" | "REJECTED_BY_MM" | "FOR_DOCKING" | "CONFIRMED";

export interface LegacyRow {
  id: string;
  status: string;
  approvalStatus?: string | null;
  approvedAt?: string | null;
  approvedBy?: string | null;
  plateNumber?: string | null;
  truckSize?: string | null;
  truckType?: string | null;
  provideTime?: string | null;
  truckAssignedBy?: string | null;
  driverId?: string | null;
  linehaulTripNo?: string | null;
  linehaulTripAt?: string | null;
  dockedAt?: string | null;
  /** Reviewer attestation that the legacy status is business-equivalent (ST-3). */
  businessEquivalenceVerified?: boolean;
  /** Authorization evidence: the approving/assigning actor held the required role (ST-4/5). */
  actorAuthorizationVerified?: boolean;
}

export type Outcome =
  | "AUTO_CONVERT" // complete, consistent evidence: safeguarded automatic normalization (ST-6)
  | "PRESERVE" // keep the raw value; non-actionable historical record
  | "MANUAL_REVIEW" // ambiguous or incomplete: flag LEGACY_UNRESOLVED
  | "NO_CHANGE"; // already canonical

export interface Proposal {
  id: string;
  originalStatus: string;
  targetStatus: string | null;
  outcome: Outcome;
  reason: string;
  /** Always true: originals and evidence are kept (legacy_status column). */
  preserveOriginal: true;
  /** Always false: reconciliation must not trigger workflow side effects. */
  sideEffects: false;
  legacyReview: "UNRESOLVED" | "VERIFIED" | null;
  actionable: boolean;
}

const CANONICAL = new Set(["PENDING", "REROUTED", "REQUESTED", "REJECTED", "CANCELLED", "DOCKING", "DOCKED"]);

function p(r: LegacyRow, outcome: Outcome, target: string | null, reason: string, review: Proposal["legacyReview"], actionable = false): Proposal {
  return { id: r.id, originalStatus: r.status, targetStatus: target, outcome, reason, preserveOriginal: true, sideEffects: false, legacyReview: review, actionable };
}

const has = (...v: (string | null | undefined)[]) => v.every((x) => x !== null && x !== undefined && x !== "");

export function classifyLegacy(r: LegacyRow): Proposal {
  if (CANONICAL.has(r.status)) return p(r, "NO_CHANGE", r.status, "already canonical", null, r.status !== "CANCELLED" && r.status !== "DOCKED");
  switch (r.status) {
    case "ASSIGNED":
      // ST-1 / ST-7: historical only; never actionable until verified, never auto-converted.
      return p(r, "PRESERVE", null, "ASSIGNED is historical-only (ST-1, ST-7); excluded from actionable queues", "UNRESOLVED");
    case "REJECTED_BY_MM":
      // ST-2: preserve as a historical rejection; do not convert to CANCELLED or reactivate.
      return p(r, "PRESERVE", null, "raw REJECTED_BY_MM preserved as historical rejection (ST-2); not cancelled, not reactivated", "UNRESOLVED");
    case "CONFIRMED":
      // ST-3: DOCKED only after business-equivalence verification AND complete docking evidence.
      if (r.businessEquivalenceVerified && has(r.plateNumber, r.driverId, r.linehaulTripNo, r.linehaulTripAt)) {
        return p(r, "AUTO_CONVERT", "DOCKED", "business equivalence verified and docking evidence complete (ST-3)", "VERIFIED", false);
      }
      if (r.businessEquivalenceVerified) return p(r, "MANUAL_REVIEW", null, "verified equivalence but docking evidence incomplete or inconsistent", "UNRESOLVED");
      return p(r, "PRESERVE", null, "CONFIRMED unverified: non-actionable (ST-3)", "UNRESOLVED");
    case "FOR_DOCKING": {
      // ST-4: DOCKING only after verifying workflow completeness and authorization.
      const complete = has(r.plateNumber, r.truckSize, r.truckType, r.provideTime);
      if (complete && r.actorAuthorizationVerified) {
        return p(r, "AUTO_CONVERT", "DOCKING", "truck assignment complete and authorization verified (ST-4)", "VERIFIED", true);
      }
      return p(r, "MANUAL_REVIEW", null, complete ? "authorization not verified (ST-4)" : "incomplete truck assignment evidence (ST-4)", "UNRESOLVED");
    }
    case "APPROVED":
      // ST-5: verified approvals become REQUESTED without side effects, keeping approval evidence.
      if (has(r.approvedAt, r.approvedBy) && r.actorAuthorizationVerified && (r.approvalStatus ?? "APPROVED") === "APPROVED") {
        return p(r, "AUTO_CONVERT", "REQUESTED", "approval evidence complete and verified (ST-5)", "VERIFIED", true);
      }
      return p(r, "MANUAL_REVIEW", null, "approval evidence missing, inconsistent or unverified (ST-5)", "UNRESOLVED");
    default:
      return p(r, "MANUAL_REVIEW", null, `unknown legacy status "${r.status}"`, "UNRESOLVED");
  }
}

export interface ReconciliationReport {
  sourceCount: number;
  targetCount: number;
  byOutcome: Record<Outcome, number>;
  byOriginalStatus: Record<string, number>;
  proposals: Proposal[];
  /** Source and target counts must reconcile: every source row has exactly one proposal. */
  reconciled: boolean;
  sideEffects: false;
}

export function previewReconciliation(rows: LegacyRow[]): ReconciliationReport {
  const proposals = rows.map(classifyLegacy);
  const byOutcome: Record<Outcome, number> = { AUTO_CONVERT: 0, PRESERVE: 0, MANUAL_REVIEW: 0, NO_CHANGE: 0 };
  const byOriginalStatus: Record<string, number> = {};
  for (const x of proposals) {
    byOutcome[x.outcome]++;
    byOriginalStatus[x.originalStatus] = (byOriginalStatus[x.originalStatus] ?? 0) + 1;
  }
  const ids = new Set(proposals.map((x) => x.id));
  const targetCount = Object.values(byOutcome).reduce((a, b) => a + b, 0);
  return {
    sourceCount: rows.length,
    targetCount,
    byOutcome,
    byOriginalStatus,
    proposals,
    reconciled: rows.length === targetCount && ids.size === rows.length,
    sideEffects: false,
  };
}
