// ApprovalPort implementations: Supabase (RPC functions in 20261020000000) and memory (tests).
import { Rest, RestError, q } from "../supabase/rest.ts";
import type { ApprovalPort, AssignmentStatus, AssignmentView, RouteResult } from "./approvals.ts";

const view = (a: Record<string, unknown>): AssignmentView => ({
  id: String(a.id),
  requestId: String(a.request_id),
  assigneeId: String(a.assignee_id),
  employeeCode: String(a.seatalk_employee_code ?? ""),
  itemId: String(a.provider_item_id ?? ""),
  status: a.status as AssignmentStatus,
  expiresAt: String(a.expires_at ?? ""),
  sentAt: (a.sent_at as string | null) ?? null,
  respondedAt: (a.responded_at as string | null) ?? null,
  delivered: a.delivered_at != null,
});

export class SupabaseApprovalPort implements ApprovalPort {
  private rest: Rest;
  constructor(rest: Rest) {
    this.rest = rest;
  }

  async assignNext(a: Parameters<ApprovalPort["assignNext"]>[0]): Promise<RouteResult> {
    const r = (await this.rest.rpc("assign_next_approver", {
      p_request: a.requestId,
      p_assignment_id: a.assignmentId,
      p_item_id: a.itemId,
      p_token_hash: a.tokenHash,
      p_now: a.now.toISOString(),
    })) as Record<string, unknown>;
    const result = String(r.result);
    if (result === "ASSIGNED" || result === "ALREADY_ASSIGNED") {
      const rows = await this.rest.select("seatalk_approval_assignments", `id=eq.${q(String(r.assignmentId))}&limit=1`);
      if (!rows[0]) throw new Error("assignment vanished");
      return { result, assignment: view(rows[0]) };
    }
    return { result: result as "NO_CANDIDATE" | "TERMINAL" | "NOT_FOUND" };
  }
  async expire(now: Date) {
    return ((await this.rest.rpc("expire_assignments", { p_now: now.toISOString() })) as string[]) ?? [];
  }
  async orphans(now: Date, limit: number, retrySeconds: number) {
    return ((await this.rest.rpc("orphan_approval_requests", { p_now: now.toISOString(), p_limit: limit, p_retry_seconds: retrySeconds })) as string[]) ?? [];
  }
  async markDelivered(id: string, now: Date) {
    await this.rest.patch("seatalk_approval_assignments", `id=eq.${q(id)}`, { delivered_at: now.toISOString(), updated_at: now.toISOString(), failure_reason: null });
  }
  async assignments(requestId: string) {
    const rows = await this.rest.select("seatalk_approval_assignments", `request_id=eq.${q(requestId)}&order=created_at.asc,id.asc&limit=200`);
    return rows.map(view);
  }
  async pendingDelivered(limit: number) {
    const rows = await this.rest.select(
      "seatalk_approval_assignments",
      `status=eq.PENDING&delivered_at=not.is.null&order=created_at.asc&limit=${Math.max(1, Math.min(limit, 500))}`,
    );
    return rows.map(view);
  }
  async applicantName(userId: string) {
    const rows = await this.rest.select("profiles", `id=eq.${q(userId)}&select=full_name&limit=1`);
    const n = String(rows[0]?.full_name ?? "").trim();
    return n || null;
  }
  async heartbeat(userId: string, now: Date) {
    // Only an active FTE Ops can be a presence candidate; anything else is a no-op (the API returns 403 first).
    await this.rest.patch("profiles", `id=eq.${q(userId)}&role=eq.fte_ops&account_status=eq.ACTIVE`, { last_seen_at: now.toISOString() });
  }
}

// ---------------------------------------------------------------- memory
export interface MemoryApprover {
  id: string;
  name: string;
  employeeCode: string | null;
  role: "fte_ops" | "other";
  active: boolean;
  lastSeenAt: number | null;
}

export class MemoryApprovalPort implements ApprovalPort {
  approvers: MemoryApprover[] = [];
  rows: (AssignmentView & { cycle: number; tokenHash: string; updatedAt: number; failureReason?: string })[] = [];
  /** requestId -> state, maintained by tests/wiring ("PENDING" means routable). */
  routable = new Map<string, boolean>();
  cursor: string | null = null;
  freshnessSeconds = 60;
  expirySeconds = 180;

  async assignNext(a: Parameters<ApprovalPort["assignNext"]>[0]): Promise<RouteResult> {
    if (!this.routable.has(a.requestId)) return { result: "NOT_FOUND" };
    if (!this.routable.get(a.requestId)) return { result: "TERMINAL" };
    const open = this.rows.find((r) => r.requestId === a.requestId && r.status === "PENDING");
    if (open) return { result: "ALREADY_ASSIGNED", assignment: open };
    const now = a.now.getTime();
    const present = this.approvers
      .filter((p) => p.role === "fte_ops" && p.active && p.employeeCode && p.lastSeenAt !== null && p.lastSeenAt >= now - this.freshnessSeconds * 1000)
      .sort((x, y) => (x.id < y.id ? -1 : 1));
    if (!present.length) return { result: "NO_CANDIDATE" };
    let cycle = Math.max(1, ...this.rows.filter((r) => r.requestId === a.requestId).map((r) => r.cycle));
    const tried = (id: string) => this.rows.some((r) => r.requestId === a.requestId && r.cycle === cycle && r.assigneeId === id && (r.status === "EXPIRED" || r.status === "FAILED"));
    if (present.every((p) => tried(p.id))) cycle++;
    const eligible = present.filter((p) => !tried(p.id));
    const chosen = eligible.find((p) => this.cursor === null || p.id > this.cursor) ?? eligible[0];
    this.cursor = chosen.id;
    const row = {
      id: a.assignmentId, requestId: a.requestId, assigneeId: chosen.id, employeeCode: chosen.employeeCode!, itemId: a.itemId,
      status: "PENDING" as const, expiresAt: new Date(now + this.expirySeconds * 1000).toISOString(), sentAt: a.now.toISOString(),
      respondedAt: null, delivered: false, cycle, tokenHash: a.tokenHash, updatedAt: now,
    };
    this.rows.push(row);
    return { result: "ASSIGNED", assignment: row };
  }
  async expire(now: Date) {
    const ids = new Set<string>();
    for (const r of this.rows) {
      if (r.status === "PENDING" && Date.parse(r.expiresAt) <= now.getTime()) {
        r.status = "EXPIRED";
        r.respondedAt = now.toISOString();
        ids.add(r.requestId);
      }
    }
    return [...ids];
  }
  async orphans(now: Date, limit: number, retrySeconds: number) {
    const anyPresent = this.approvers.some((p) => p.role === "fte_ops" && p.active && p.employeeCode && p.lastSeenAt !== null && p.lastSeenAt >= now.getTime() - this.freshnessSeconds * 1000);
    if (!anyPresent) return [];
    return [...this.routable.entries()]
      .filter(([id, ok]) => ok && !this.rows.some((r) => r.requestId === id && r.status === "PENDING")
        && !this.rows.some((r) => r.requestId === id && r.status === "FAILED" && r.updatedAt > now.getTime() - retrySeconds * 1000))
      .map(([id]) => id).slice(0, limit);
  }
  async markDelivered(id: string) {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.delivered = true;
  }
  async assignments(requestId: string) {
    return this.rows.filter((r) => r.requestId === requestId).map((r) => ({ ...r }));
  }
  async pendingDelivered(limit: number) {
    return this.rows.filter((r) => r.status === "PENDING" && r.delivered).slice(0, limit).map((r) => ({ ...r }));
  }
  async applicantName(userId: string) {
    return this.approvers.find((p) => p.id === userId)?.name ?? null;
  }
  async heartbeat(userId: string, now: Date) {
    const p = this.approvers.find((x) => x.id === userId && x.role === "fte_ops" && x.active);
    if (p) p.lastSeenAt = now.getTime();
  }
}

export { RestError };
