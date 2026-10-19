// Full request lifecycle (APR-1..APR-6). Pure: no I/O. Builds on workflow.ts,
// which owns the APR-3 rejection/correction rules. Authorization, state guards
// and derived recipients are computed here, never accepted from clients.
import {
  buildEvent,
  canCorrect,
  fail,
  notify,
  rejectByFteMm,
  rejectByFteOps,
  resubmit,
  type Actor,
  type Context,
  type EventType,
  type NotificationIntent,
  type RequestEvent,
  type Role,
  type WorkflowRequest,
  type WorkflowResult,
} from "./workflow.ts";

export type TruckSize = "4W" | "4WAUV" | "4WCV" | "6W" | "10W" | "6WF";
export type TruckType = "WETLEASE" | "DRYLEASE";
export const TRUCK_SIZES: readonly TruckSize[] = ["4W", "4WAUV", "4WCV", "6W", "10W", "6WF"];
export const TRUCK_TYPES: readonly TruckType[] = ["WETLEASE", "DRYLEASE"];

/** Editable request-detail fields (RequestController rules). */
export interface RequestDetails {
  clusterId: string | null;
  cluster: string;
  region: string;
  dockNo: string;
  backlogs: number;
  backlogsTimestamp: string | null; // full UTC instant (ISO 8601)
  truckSize: TruckSize;
  truckType: TruckType;
}

export interface RequestRecord extends WorkflowRequest, RequestDetails {
  requestTimestamp: string;
  /** Latest submission (creation or latest resubmission): KPI-2 Option B. */
  submittedAt: string;
  approvalSource: "WEB" | "SEATALK" | null;
  approvedAt: string | null;
  approvedBy: string | null;
  rejectedAt: string | null;
  rejectedBy: string | null;
  cancellationRemarks: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  plateNumber: string | null;
  provideTime: string | null;
  truckAssignedBy: string | null;
  driverId: string | null;
  driverAssignedAt: string | null;
  driverAssignedBy: string | null;
  linehaulTripNo: string | null;
  linehaulTripAt: string | null;
  dockedAt: string | null;
  legacyStatus: string | null;
  legacyReview: "UNRESOLVED" | "VERIFIED" | null;
  rowVersion: number;
  createdAt: string;
}

export interface LifecycleContext extends Context {
  /** Preallocated id for creation (so retries are deterministic). */
  newId?: string;
}

const OPERATIONAL_NOTIFY: Role[] = ["fte_ops", "fte_mm", "doc_officer"];

function transition(
  type: EventType,
  before: RequestRecord,
  after: RequestRecord,
  actor: Actor,
  ctx: Context,
  recipients: { userId?: string; role?: Role }[],
  opts: { remarks?: string | null; metadata?: Record<string, unknown>; title?: string } = {},
): WorkflowResult {
  const event = buildEvent(type, before, after, actor, opts.remarks ?? null, ctx, opts.metadata);
  const notifications: NotificationIntent[] = notify(
    event,
    recipients,
    ctx.extraRecipientIds,
    opts.title ?? type,
  );
  return { ok: true, request: after, event, notifications };
}

const isOperational = (a: Actor) => a.active;

/** Next role that must act, used for cancellation eligibility and display. */
export function nextActionRole(r: WorkflowRequest): Role | null {
  switch (r.status) {
    case "PENDING":
    case "REROUTED":
      return "fte_ops";
    case "REQUESTED":
      return "fte_mm";
    case "DOCKING":
      return r.driverId ? "ops_pic" : "doc_officer";
    case "REJECTED":
      if (r.rejectionDisposition === "RETURN_TO_OPS_PIC") return "ops_pic";
      if (r.rejectionDisposition === "RETURN_TO_FTE_OPS") return "fte_ops";
      return null; // FINAL_NO_ROUTE and LEGACY_UNRESOLVED: no actor
    default:
      return null;
  }
}

export function createRequest(
  actor: Actor,
  details: RequestDetails,
  ctx: LifecycleContext,
): WorkflowResult {
  if (!isOperational(actor) || (actor.role !== "ops_pic" && actor.role !== "fte_ops")) {
    return fail("FORBIDDEN");
  }
  const now = ctx.now.toISOString();
  const request: RequestRecord = {
    id: ctx.newId ?? crypto.randomUUID(),
    ...details,
    status: "PENDING",
    approvalStatus: "PENDING",
    createdBy: actor.id,
    creatorRole: actor.role,
    rejectionDisposition: null,
    rejectionReturnRole: null,
    rejectionRemarks: null,
    approvalVersion: 1,
    approvalCorrelationId: ctx.correlationId,
    requestTimestamp: now,
    submittedAt: now,
    approvalSource: null,
    approvedAt: null,
    approvedBy: null,
    rejectedAt: null,
    rejectedBy: null,
    cancellationRemarks: null,
    cancelledAt: null,
    cancelledBy: null,
    plateNumber: null,
    provideTime: null,
    truckAssignedBy: null,
    driverId: null,
    driverAssignedAt: null,
    driverAssignedBy: null,
    linehaulTripNo: null,
    linehaulTripAt: null,
    dockedAt: null,
    legacyStatus: null,
    legacyReview: null,
    rowVersion: 1,
    createdAt: now,
  };
  const event = buildEvent(
    "REQUEST_CREATED",
    { ...request, status: "PENDING" },
    request,
    actor,
    null,
    ctx,
  );
  const notifications = notify(event, [{ role: "fte_ops" }], ctx.extraRecipientIds, "New request awaiting approval");
  return { ok: true, request, event, notifications };
}

/**
 * FTE Ops approval (APR-1). The caller MUST have passed the SeaTalk approval
 * gate (SEA-1): this function never decides whether approval is permitted by
 * the provider, only whether the workflow allows it.
 */
export function approve(
  request: RequestRecord,
  actor: Actor,
  ctx: Context,
  source: "WEB" | "SEATALK",
): WorkflowResult {
  if (!actor.active || actor.role !== "fte_ops") return fail("FORBIDDEN");
  if (request.status !== "PENDING" && request.status !== "REROUTED") return fail("INVALID_STATE");
  const after: RequestRecord = {
    ...request,
    status: "REQUESTED",
    approvalStatus: "APPROVED",
    approvalSource: source,
    approvedAt: ctx.now.toISOString(),
    approvedBy: actor.id,
  };
  return transition(
    "REQUEST_APPROVED",
    request,
    after,
    actor,
    ctx,
    [{ role: "fte_mm" }, { userId: request.createdBy }],
    { title: "Request approved", metadata: { source } },
  );
}

export function rejectRecord(
  request: RequestRecord,
  actor: Actor,
  remarks: string,
  ctx: Context,
): WorkflowResult {
  const out =
    actor.role === "fte_mm"
      ? rejectByFteMm(request, actor, remarks, ctx)
      : rejectByFteOps(request, actor, remarks, ctx);
  if (!out.ok) return out;
  const r = out.request as RequestRecord;
  r.rejectedAt = ctx.now.toISOString();
  r.rejectedBy = actor.id;
  r.approvalSource = request.approvalSource;
  return out;
}

export interface TruckInput {
  plateNumber: string;
  truckSize: TruckSize;
  truckType: TruckType;
}

/** FTE MM assigns a truck: REQUESTED -> DOCKING. provide_time is server time. */
export function assignTruck(
  request: RequestRecord,
  actor: Actor,
  input: TruckInput,
  ctx: Context,
): WorkflowResult {
  if (!actor.active || actor.role !== "fte_mm") return fail("FORBIDDEN");
  if (request.status !== "REQUESTED") return fail("INVALID_STATE");
  const after: RequestRecord = {
    ...request,
    status: "DOCKING",
    plateNumber: input.plateNumber,
    truckSize: input.truckSize,
    truckType: input.truckType,
    provideTime: ctx.now.toISOString(),
    truckAssignedBy: actor.id,
  };
  return transition(
    "TRUCK_ASSIGNED",
    request,
    after,
    actor,
    ctx,
    [{ role: "doc_officer" }, { userId: request.createdBy }],
    {
      title: "Truck assigned",
      metadata: { plateNumber: input.plateNumber, truckSize: input.truckSize, truckType: input.truckType },
    },
  );
}

/** Doc Officer assigns a driver; status remains DOCKING (APR-1). */
export function assignDriver(
  request: RequestRecord,
  actor: Actor,
  driverId: string,
  ctx: Context,
): WorkflowResult {
  if (!actor.active || actor.role !== "doc_officer") return fail("FORBIDDEN");
  if (request.status !== "DOCKING") return fail("INVALID_STATE");
  if (request.driverId) return fail("DRIVER_ALREADY_ASSIGNED");
  const after: RequestRecord = {
    ...request,
    driverId,
    driverAssignedAt: ctx.now.toISOString(),
    driverAssignedBy: actor.id,
  };
  return transition("DRIVER_ASSIGNED", request, after, actor, ctx, [{ userId: request.createdBy }], {
    title: "Driver assigned",
    metadata: { driverId },
  });
}

/** Explicit reassignment only; records prior and new driver ids. */
export function reassignDriver(
  request: RequestRecord,
  actor: Actor,
  driverId: string,
  ctx: Context,
): WorkflowResult {
  if (!actor.active || actor.role !== "doc_officer") return fail("FORBIDDEN");
  if (request.status !== "DOCKING") return fail("INVALID_STATE");
  if (!request.driverId) return fail("NO_DRIVER_ASSIGNED");
  const after: RequestRecord = {
    ...request,
    driverId,
    driverAssignedAt: ctx.now.toISOString(),
    driverAssignedBy: actor.id,
  };
  return transition("DRIVER_REASSIGNED", request, after, actor, ctx, [{ userId: request.createdBy }], {
    title: "Driver reassigned",
    metadata: { priorDriverId: request.driverId, driverId },
  });
}

/** APR-4: only the creator Ops PIC finalizes docking, after a driver exists. */
export function dock(
  request: RequestRecord,
  actor: Actor,
  linehaulTripNo: string,
  ctx: Context,
): WorkflowResult {
  if (!actor.active || actor.role !== "ops_pic" || actor.id !== request.createdBy) {
    return fail("FORBIDDEN");
  }
  if (request.status !== "DOCKING") return fail("INVALID_STATE");
  if (!request.driverId) return fail("NO_DRIVER_ASSIGNED");
  const at = ctx.now.toISOString();
  const after: RequestRecord = { ...request, status: "DOCKED", linehaulTripNo, linehaulTripAt: at, dockedAt: at };
  return transition(
    "TRUCK_DOCKED",
    request,
    after,
    actor,
    ctx,
    [{ role: "fte_mm" }, { role: "doc_officer" }],
    { title: "Truck docked", metadata: { linehaulTripNo } },
  );
}

/** Cancellation eligibility (APR-6): creator Ops PIC, or the current next-action role. */
export function canCancel(request: RequestRecord, actor: Actor): boolean {
  if (!actor.active) return false;
  const next = nextActionRole(request);
  const pre = request.status === "PENDING" || request.status === "REROUTED";
  switch (actor.role) {
    case "ops_pic":
      return actor.id === request.createdBy && (pre || (request.status === "REJECTED" && next === "ops_pic"));
    case "fte_ops":
      return next === "fte_ops" && request.status !== "DOCKING";
    case "fte_mm":
      return request.status === "REQUESTED";
    default:
      return false;
  }
}

export function cancel(
  request: RequestRecord,
  actor: Actor,
  remarks: string | null,
  ctx: Context,
): WorkflowResult {
  if (!actor.active) return fail("FORBIDDEN");
  if (!canCancel(request, actor)) {
    // Distinguish a state problem from a role problem for clear conflicts.
    const stateOk = nextActionRole(request) !== null || request.status === "DOCKING";
    return fail(stateOk && request.status !== "DOCKED" ? "FORBIDDEN" : "INVALID_STATE");
  }
  const trimmed = remarks?.trim() || null;
  if (actor.role === "fte_mm" && !trimmed) return fail("REMARKS_REQUIRED");
  const after: RequestRecord = {
    ...request,
    status: "CANCELLED",
    approvalStatus: "CANCELLED",
    rejectionDisposition: null, // keep requests_rejection_disposition_consistent satisfied
    rejectionReturnRole: null,
    cancellationRemarks: trimmed,
    cancelledAt: ctx.now.toISOString(),
    cancelledBy: actor.id,
    approvalVersion: request.approvalVersion + 1,
    approvalCorrelationId: ctx.correlationId,
  };
  return transition(
    "REQUEST_CANCELLED",
    request,
    after,
    actor,
    ctx,
    [{ userId: request.createdBy }, ...OPERATIONAL_NOTIFY.map((role) => ({ role }))],
    {
      remarks: trimmed,
      title: "Request cancelled",
      metadata: {
        source: "WEB",
        priorStatus: request.status,
        priorDisposition: request.rejectionDisposition,
      },
    },
  );
}

const DETAIL_KEYS: (keyof RequestDetails)[] = [
  "clusterId",
  "cluster",
  "region",
  "dockNo",
  "backlogs",
  "backlogsTimestamp",
  "truckSize",
  "truckType",
];

function diffDetails(before: RequestDetails, after: RequestDetails) {
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const k of DETAIL_KEYS) {
    if (before[k] !== after[k]) changes[k] = { before: before[k], after: after[k] };
  }
  return changes;
}

/**
 * Edit request details (PUT). Three permitted paths:
 *  - FTE Ops edits PENDING/REROUTED in place;
 *  - an authorized correction actor edits a correctable REJECTED request, which
 *    resubmits it (new approval cycle, APR-3);
 *  - the creator Ops PIC edits a DOCKED request; status stays DOCKED (APR-5).
 * The final FTE-Ops rejection and legacy rows are never editable.
 */
export function editRequest(
  request: RequestRecord,
  actor: Actor,
  next: RequestDetails,
  ctx: Context,
): WorkflowResult {
  if (!actor.active) return fail("FORBIDDEN");
  const changes = diffDetails(request, next);
  const changed = Object.keys(changes).length > 0;
  const apply = (r: RequestRecord): RequestRecord => ({ ...r, ...next });

  if (request.status === "REJECTED") {
    if (!canCorrect(request, actor)) {
      const routed =
        request.rejectionDisposition === "RETURN_TO_OPS_PIC" ||
        request.rejectionDisposition === "RETURN_TO_FTE_OPS";
      return fail(routed ? "FORBIDDEN" : "NOT_CORRECTABLE");
    }
    const base = resubmit(request, actor, ctx);
    if (!base.ok) return base;
    const after = {
      ...apply(base.request as RequestRecord),
      submittedAt: ctx.now.toISOString(), // KPI-2: latest submission
    } as RequestRecord;
    const event: RequestEvent = {
      ...base.event,
      metadata: {
        changes,
        priorRejection: {
          disposition: request.rejectionDisposition,
          returnRole: request.rejectionReturnRole,
          remarks: request.rejectionRemarks,
        },
      },
    };
    return { ok: true, request: after, event, notifications: base.notifications };
  }

  if (request.status === "PENDING" || request.status === "REROUTED") {
    if (actor.role !== "fte_ops") return fail("FORBIDDEN");
    if (!changed) return fail("VALIDATION_FAILED");
    return transition("REQUEST_UPDATED", request, apply(request), actor, ctx, [{ userId: request.createdBy }], {
      title: "Request updated",
      metadata: { changes },
    });
  }

  if (request.status === "DOCKED") {
    if (actor.role !== "ops_pic" || actor.id !== request.createdBy) return fail("FORBIDDEN");
    if (!changed) return fail("VALIDATION_FAILED");
    return transition(
      "DOCKED_EDITED",
      request,
      apply(request),
      actor,
      ctx,
      OPERATIONAL_NOTIFY.map((role) => ({ role })),
      { title: "Docked request edited", metadata: { changes } },
    );
  }
  return fail("INVALID_STATE");
}

/**
 * HUB-4 safeguards for administrator overrides. An override never adds new
 * transitions: it runs an existing, workflow-validated transition on behalf of
 * the responsible role. This returns the audit metadata to attach, or an error.
 */
export function overrideSafeguards(
  actor: Actor,
  input: { justification: string; identityVerified: boolean; asRole: Role },
): { ok: true; actingAs: Actor; metadata: Record<string, unknown> } | { ok: false; code: "FORBIDDEN" | "JUSTIFICATION_REQUIRED" } {
  if (!actor.active || !actor.isAdmin) return { ok: false, code: "FORBIDDEN" };
  if (!input.identityVerified) return { ok: false, code: "FORBIDDEN" };
  const justification = input.justification.trim();
  if (!justification) return { ok: false, code: "JUSTIFICATION_REQUIRED" };
  return {
    ok: true,
    actingAs: { ...actor, role: input.asRole },
    metadata: { override: { by: actor.id, justification, asRole: input.asRole, originalRole: actor.role } },
  };
}
