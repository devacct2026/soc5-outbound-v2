// Pure domain logic for request rejection/correction (APR-3).
// Source of truth: docs/backend/03-workflow-transitions.md, 05-database-schema.md.
// No I/O: callers persist the returned request, event and notification intents
// in one transaction. Return roles/recipients are always derived here, never
// accepted from clients.

export type Role = "ops_pic" | "fte_ops" | "fte_mm" | "doc_officer";

export type RequestStatus =
  | "PENDING"
  | "REROUTED"
  | "REQUESTED"
  | "REJECTED"
  | "CANCELLED"
  | "DOCKING"
  | "DOCKED";

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

export type RejectionDisposition =
  | "FINAL_NO_ROUTE"
  | "RETURN_TO_OPS_PIC"
  | "RETURN_TO_FTE_OPS"
  | "LEGACY_UNRESOLVED";

export interface Actor {
  id: string;
  role: Role;
  active: boolean;
}

export interface WorkflowRequest {
  id: string;
  status: RequestStatus;
  approvalStatus: ApprovalStatus;
  createdBy: string;
  creatorRole: Extract<Role, "ops_pic" | "fte_ops">;
  rejectionDisposition: RejectionDisposition | null;
  rejectionReturnRole: Extract<Role, "ops_pic" | "fte_ops"> | null;
  rejectionRemarks: string | null;
  approvalVersion: number;
  approvalCorrelationId: string;
}

export interface Context {
  now: Date;
  correlationId: string;
  /** Other explicitly assigned affected recipients, resolved at event time. */
  extraRecipientIds?: string[];
}

export type WorkflowErrorCode =
  | "FORBIDDEN"
  | "INVALID_STATE"
  | "REMARKS_REQUIRED"
  | "NOT_CORRECTABLE";

export interface WorkflowError {
  ok: false;
  code: WorkflowErrorCode;
}

export interface RequestEvent {
  type: "REQUEST_REJECTED" | "REQUEST_RESUBMITTED";
  requestId: string;
  actorId: string;
  creatorId: string;
  at: string;
  fromStatus: RequestStatus;
  toStatus: RequestStatus;
  fromApprovalStatus: ApprovalStatus;
  toApprovalStatus: ApprovalStatus;
  remarks: string | null;
  disposition: RejectionDisposition | null;
  returnRole: string | null;
  approvalVersion: number;
  correlationId: string;
}

export interface NotificationIntent {
  /** Deterministic key so retries never create duplicate notifications. */
  dedupeKey: string;
  event: RequestEvent["type"];
  recipientUserId?: string;
  recipientRole?: Role;
}

export interface WorkflowSuccess {
  ok: true;
  request: WorkflowRequest;
  event: RequestEvent;
  notifications: NotificationIntent[];
}

export type WorkflowResult = WorkflowSuccess | WorkflowError;

const fail = (code: WorkflowErrorCode): WorkflowError => ({ ok: false, code });

function buildEvent(
  type: RequestEvent["type"],
  before: WorkflowRequest,
  after: WorkflowRequest,
  actor: Actor,
  remarks: string | null,
  ctx: Context,
): RequestEvent {
  return {
    type,
    requestId: before.id,
    actorId: actor.id,
    creatorId: before.createdBy,
    at: ctx.now.toISOString(),
    fromStatus: before.status,
    toStatus: after.status,
    fromApprovalStatus: before.approvalStatus,
    toApprovalStatus: after.approvalStatus,
    remarks,
    disposition: after.rejectionDisposition,
    returnRole: after.rejectionReturnRole,
    approvalVersion: after.approvalVersion,
    correlationId: ctx.correlationId,
  };
}

function notify(
  event: RequestEvent,
  recipients: { userId?: string; role?: Role }[],
  extra: string[] = [],
): NotificationIntent[] {
  const seen = new Set<string>();
  const out: NotificationIntent[] = [];
  const all: { userId?: string; role?: Role }[] = [
    ...recipients,
    ...extra.map((userId) => ({ userId })),
  ];
  for (const r of all) {
    const target = r.userId ? `u:${r.userId}` : `r:${r.role}`;
    const dedupeKey = `${event.requestId}:${event.type}:v${event.approvalVersion}:${target}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      dedupeKey,
      event: event.type,
      recipientUserId: r.userId,
      recipientRole: r.role,
    });
  }
  return out;
}

/** FTE Ops rejects a PENDING/REROUTED request (APR-3). */
export function rejectByFteOps(
  request: WorkflowRequest,
  actor: Actor,
  remarks: string,
  ctx: Context,
): WorkflowResult {
  if (!actor.active || actor.role !== "fte_ops") return fail("FORBIDDEN");
  if (request.status !== "PENDING" && request.status !== "REROUTED") {
    return fail("INVALID_STATE");
  }
  const trimmed = remarks.trim();
  if (!trimmed) return fail("REMARKS_REQUIRED");

  const final = request.creatorRole === "fte_ops";
  const after: WorkflowRequest = {
    ...request,
    status: "REJECTED",
    approvalStatus: "REJECTED",
    rejectionDisposition: final ? "FINAL_NO_ROUTE" : "RETURN_TO_OPS_PIC",
    rejectionReturnRole: final ? null : "ops_pic",
    rejectionRemarks: trimmed,
  };
  const event = buildEvent("REQUEST_REJECTED", request, after, actor, trimmed, ctx);
  // Original creator is notified in both branches (the FTE Ops creator when final).
  const notifications = notify(
    event,
    [{ userId: request.createdBy }],
    ctx.extraRecipientIds,
  );
  return { ok: true, request: after, event, notifications };
}

/** FTE MM rejects a REQUESTED request; it returns to FTE Ops. */
export function rejectByFteMm(
  request: WorkflowRequest,
  actor: Actor,
  remarks: string,
  ctx: Context,
): WorkflowResult {
  if (!actor.active || actor.role !== "fte_mm") return fail("FORBIDDEN");
  if (request.status !== "REQUESTED") return fail("INVALID_STATE");
  const trimmed = remarks.trim();
  if (!trimmed) return fail("REMARKS_REQUIRED");

  const after: WorkflowRequest = {
    ...request,
    status: "REJECTED",
    approvalStatus: "REJECTED",
    rejectionDisposition: "RETURN_TO_FTE_OPS",
    rejectionReturnRole: "fte_ops",
    rejectionRemarks: trimmed,
  };
  const event = buildEvent("REQUEST_REJECTED", request, after, actor, trimmed, ctx);
  const notifications = notify(
    event,
    [{ role: "fte_ops" }],
    ctx.extraRecipientIds,
  );
  return { ok: true, request: after, event, notifications };
}

/** Whether `actor` may correct/resubmit this request. Final and legacy rows: never. */
export function canCorrect(request: WorkflowRequest, actor: Actor): boolean {
  if (!actor.active || request.status !== "REJECTED") return false;
  switch (request.rejectionDisposition) {
    case "RETURN_TO_OPS_PIC":
      // Role match alone is insufficient: must be the original creator.
      return (
        actor.role === "ops_pic" &&
        request.rejectionReturnRole === "ops_pic" &&
        actor.id === request.createdBy
      );
    case "RETURN_TO_FTE_OPS":
      return actor.role === "fte_ops" && request.rejectionReturnRole === "fte_ops";
    default:
      return false; // FINAL_NO_ROUTE, LEGACY_UNRESOLVED, null
  }
}

/** Correct and resubmit a correctable rejected request: new approval cycle. */
export function resubmit(
  request: WorkflowRequest,
  actor: Actor,
  ctx: Context,
): WorkflowResult {
  if (request.status !== "REJECTED") return fail("INVALID_STATE");
  if (!canCorrect(request, actor)) {
    return fail(
      request.rejectionDisposition === "RETURN_TO_OPS_PIC" ||
        request.rejectionDisposition === "RETURN_TO_FTE_OPS"
        ? "FORBIDDEN"
        : "NOT_CORRECTABLE",
    );
  }
  const after: WorkflowRequest = {
    ...request,
    status: "PENDING",
    approvalStatus: "PENDING",
    rejectionDisposition: null,
    rejectionReturnRole: null,
    rejectionRemarks: null,
    approvalVersion: request.approvalVersion + 1,
    approvalCorrelationId: ctx.correlationId,
  };
  const event = buildEvent("REQUEST_RESUBMITTED", request, after, actor, null, ctx);
  const notifications = notify(
    event,
    [{ role: "fte_ops" }],
    ctx.extraRecipientIds,
  );
  return { ok: true, request: after, event, notifications };
}

/** Mirrors the database CHECK constraint (see supabase migration). */
export function isRejectionConsistent(r: WorkflowRequest): boolean {
  if (r.status !== "REJECTED") {
    return r.rejectionDisposition === null && r.rejectionReturnRole === null;
  }
  switch (r.rejectionDisposition) {
    case "FINAL_NO_ROUTE":
      return r.approvalStatus === "REJECTED" && r.rejectionReturnRole === null;
    case "RETURN_TO_OPS_PIC":
      return r.approvalStatus === "REJECTED" && r.rejectionReturnRole === "ops_pic";
    case "RETURN_TO_FTE_OPS":
      return r.approvalStatus === "REJECTED" && r.rejectionReturnRole === "fte_ops";
    case "LEGACY_UNRESOLVED":
      return r.rejectionReturnRole === null;
    default:
      return false;
  }
}

/** Actionable-queue predicate. Final and legacy rejections are never actionable. */
export function isActionableForRole(
  request: WorkflowRequest,
  role: Role,
  userId?: string,
): boolean {
  switch (request.status) {
    case "PENDING":
    case "REROUTED":
      return role === "fte_ops";
    case "REQUESTED":
      return role === "fte_mm";
    case "REJECTED":
      if (request.rejectionDisposition === "RETURN_TO_OPS_PIC") {
        return role === "ops_pic" && userId === request.createdBy;
      }
      if (request.rejectionDisposition === "RETURN_TO_FTE_OPS") {
        return role === "fte_ops";
      }
      return false;
    default:
      return false;
  }
}

/** Metrics `awaiting_action` for rejected rows: only correctable dispositions. */
export function countsAsAwaitingAction(request: WorkflowRequest): boolean {
  return (
    request.status === "REJECTED" &&
    (request.rejectionDisposition === "RETURN_TO_OPS_PIC" ||
      request.rejectionDisposition === "RETURN_TO_FTE_OPS")
  );
}
