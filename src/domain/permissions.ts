// Role-based data visibility and capability checks (HUB-1..HUB-6, KPI-6).
import type { Actor, Role, WorkflowRequest } from "./requests/workflow.ts";

export const OPERATIONAL_ROLES: readonly Role[] = ["ops_pic", "fte_ops", "fte_mm", "doc_officer"];

/** Ops PIC is creator-scoped; FTE Ops / FTE MM / Doc Officer see all (HUB-1..3). */
export function canView(actor: Actor, request: Pick<WorkflowRequest, "createdBy">): boolean {
  if (!actor.active) return false;
  if (actor.role === "ops_pic") return actor.id === request.createdBy;
  return OPERATIONAL_ROLES.includes(actor.role);
}

/** Operational Intraday Dispatch data: all four operational roles (HUB-5). */
export function canReadIntraday(actor: Actor): boolean {
  return actor.active && OPERATIONAL_ROLES.includes(actor.role);
}

/** Advanced analytics and report exports require the explicit permission (KPI-6). */
export function canReadAnalytics(actor: Actor): boolean {
  return actor.active && actor.reportingPermission === true;
}

export function isAdmin(actor: Actor): boolean {
  return actor.active && actor.isAdmin === true;
}

/** Role-specific display label; stored status is unchanged (03-workflow-transitions). */
export function displayStatus(role: Role, status: string): string {
  if (role === "fte_mm" && status === "DOCKING") return "ASSIGNED";
  if ((role === "fte_mm" || role === "doc_officer") && status === "REROUTED") return "PENDING";
  return status;
}
