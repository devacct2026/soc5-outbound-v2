import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canCorrect,
  countsAsAwaitingAction,
  isActionableForRole,
  isRejectionConsistent,
  rejectByFteMm,
  rejectByFteOps,
  resubmit,
  type Actor,
  type WorkflowRequest,
} from "./workflow.ts";

const ctx = { now: new Date("2026-10-19T00:00:00Z"), correlationId: "corr-2" };
const fteOps: Actor = { id: "ops1", role: "fte_ops", active: true };
const fteMm: Actor = { id: "mm1", role: "fte_mm", active: true };
const creatorPic: Actor = { id: "pic1", role: "ops_pic", active: true };
const otherPic: Actor = { id: "pic2", role: "ops_pic", active: true };

const base = (over: Partial<WorkflowRequest> = {}): WorkflowRequest => ({
  id: "r1",
  status: "PENDING",
  approvalStatus: "PENDING",
  createdBy: "pic1",
  creatorRole: "ops_pic",
  rejectionDisposition: null,
  rejectionReturnRole: null,
  rejectionRemarks: null,
  approvalVersion: 1,
  approvalCorrelationId: "corr-1",
  ...over,
});

function ok<T extends { ok: boolean }>(r: T) {
  assert.equal(r.ok, true);
  return r as Extract<T, { ok: true }>;
}

test("FTE Ops rejecting an FTE Ops-created request is final with no route", () => {
  const req = base({ createdBy: "ops9", creatorRole: "fte_ops" });
  const r = ok(rejectByFteOps(req, fteOps, "bad data", {
    ...ctx,
    extraRecipientIds: ["lead1"],
  }));
  assert.equal(r.request.status, "REJECTED");
  assert.equal(r.request.approvalStatus, "REJECTED");
  assert.equal(r.request.rejectionDisposition, "FINAL_NO_ROUTE");
  assert.equal(r.request.rejectionReturnRole, null);
  assert.ok(isRejectionConsistent(r.request));
  assert.deepEqual(
    r.notifications.map((n) => n.recipientUserId).sort(),
    ["lead1", "ops9"],
  );
  assert.equal(r.event.creatorId, "ops9");
  assert.equal(r.event.fromStatus, "PENDING");
  assert.equal(r.event.toApprovalStatus, "REJECTED");
});

test("final rejection cannot be corrected, resubmitted or queued by anyone", () => {
  const final = ok(
    rejectByFteOps(base({ createdBy: "ops9", creatorRole: "fte_ops" }), fteOps, "no", ctx),
  ).request;
  for (const a of [fteOps, fteMm, creatorPic, { ...fteOps, id: "ops9" }]) {
    assert.equal(canCorrect(final, a), false);
    assert.deepEqual(resubmit(final, a, ctx), { ok: false, code: "NOT_CORRECTABLE" });
  }
  for (const role of ["ops_pic", "fte_ops", "fte_mm", "doc_officer"] as const) {
    assert.equal(isActionableForRole(final, role, "ops9"), false);
  }
  assert.equal(countsAsAwaitingAction(final), false);
});

test("Ops PIC-created rejection returns to the original creator only", () => {
  const r = ok(rejectByFteOps(base(), fteOps, "fix", ctx));
  assert.equal(r.request.rejectionDisposition, "RETURN_TO_OPS_PIC");
  assert.equal(r.request.rejectionReturnRole, "ops_pic");
  assert.ok(isRejectionConsistent(r.request));
  assert.equal(canCorrect(r.request, creatorPic), true);
  assert.equal(canCorrect(r.request, otherPic), false);
  assert.equal(isActionableForRole(r.request, "ops_pic", "pic2"), false);
  assert.equal(isActionableForRole(r.request, "ops_pic", "pic1"), true);
  assert.equal(countsAsAwaitingAction(r.request), true);

  const re = ok(resubmit(r.request, creatorPic, { ...ctx, correlationId: "corr-3" }));
  assert.equal(re.request.status, "PENDING");
  assert.equal(re.request.approvalStatus, "PENDING");
  assert.equal(re.request.approvalVersion, 2);
  assert.equal(re.request.approvalCorrelationId, "corr-3");
  assert.equal(re.request.rejectionDisposition, null);
  assert.ok(isRejectionConsistent(re.request));
  assert.deepEqual(resubmit(r.request, otherPic, ctx), { ok: false, code: "FORBIDDEN" });
});

test("FTE MM rejection returns to FTE Ops, who may resubmit", () => {
  const r = ok(rejectByFteMm(base({ status: "REQUESTED", approvalStatus: "APPROVED" }), fteMm, "x", ctx));
  assert.equal(r.request.rejectionDisposition, "RETURN_TO_FTE_OPS");
  assert.equal(r.request.rejectionReturnRole, "fte_ops");
  assert.ok(isRejectionConsistent(r.request));
  assert.equal(isActionableForRole(r.request, "fte_ops"), true);
  assert.equal(ok(resubmit(r.request, fteOps, ctx)).request.status, "PENDING");
});

test("guards: role, state, remarks, inactive actor", () => {
  assert.deepEqual(rejectByFteOps(base(), fteMm, "x", ctx), { ok: false, code: "FORBIDDEN" });
  assert.deepEqual(rejectByFteOps(base(), { ...fteOps, active: false }, "x", ctx), { ok: false, code: "FORBIDDEN" });
  assert.deepEqual(rejectByFteOps(base(), fteOps, "   ", ctx), { ok: false, code: "REMARKS_REQUIRED" });
  assert.deepEqual(rejectByFteOps(base({ status: "REQUESTED" }), fteOps, "x", ctx), { ok: false, code: "INVALID_STATE" });
  assert.deepEqual(rejectByFteMm(base(), fteMm, "x", ctx), { ok: false, code: "INVALID_STATE" });
});

test("LEGACY_UNRESOLVED and null-role rows are never actionable or correctable", () => {
  const legacy = base({
    status: "REJECTED",
    approvalStatus: "REJECTED",
    rejectionDisposition: "LEGACY_UNRESOLVED",
  });
  assert.ok(isRejectionConsistent(legacy));
  assert.equal(canCorrect(legacy, fteOps), false);
  assert.equal(isActionableForRole(legacy, "fte_ops"), false);
  assert.equal(countsAsAwaitingAction(legacy), false);
  const ambiguous = base({ status: "REJECTED", approvalStatus: "REJECTED" });
  assert.equal(isRejectionConsistent(ambiguous), false);
});

test("notification dedupe keys are deterministic and unique per recipient", () => {
  const req = base({ createdBy: "ops9", creatorRole: "fte_ops" });
  const a = ok(rejectByFteOps(req, fteOps, "x", { ...ctx, extraRecipientIds: ["ops9", "l1"] }));
  const b = ok(rejectByFteOps(req, fteOps, "x", { ...ctx, extraRecipientIds: ["ops9", "l1"] }));
  assert.equal(a.notifications.length, 2);
  assert.deepEqual(a.notifications, b.notifications);
});
