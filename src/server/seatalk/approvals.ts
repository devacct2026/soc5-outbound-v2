// Approval Center coordination (SEA-1, SEA-5, SEA-6): provisioning, synchronization, maintenance
// (expiry + reassignment), verified web approval and provider reconciliation. Pure orchestration
// over ports so it is testable with a fake provider; SOC5's database stays authoritative.
import { createHash } from "node:crypto";
import type { RequestRecord } from "../../domain/requests/lifecycle.ts";
import type { Actor } from "../../domain/requests/workflow.ts";
import { approvalToken, itemIdFor, SeaTalkProviderError, type ApprovalItemInput, type ApprovalProvider, type ItemState } from "./provider.ts";

export type AssignmentStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "CLOSED" | "FAILED";

export interface AssignmentView {
  id: string;
  requestId: string;
  assigneeId: string;
  employeeCode: string;
  itemId: string;
  status: AssignmentStatus;
  expiresAt: string;
  sentAt: string | null;
  respondedAt: string | null;
  delivered: boolean;
}

export type RouteResult =
  | { result: "ASSIGNED" | "ALREADY_ASSIGNED"; assignment: AssignmentView }
  | { result: "NO_CANDIDATE" | "TERMINAL" | "NOT_FOUND" };

export interface ApprovalPort {
  /** Atomic: presence filter, round robin, one open assignment per request. */
  assignNext(a: { requestId: string; assignmentId: string; itemId: string; tokenHash: string; now: Date }): Promise<RouteResult>;
  expire(now: Date): Promise<string[]>;
  orphans(now: Date, limit: number, retrySeconds: number): Promise<string[]>;
  markDelivered(assignmentId: string, now: Date): Promise<void>;
  assignments(requestId: string): Promise<AssignmentView[]>;
  pendingDelivered(limit: number): Promise<AssignmentView[]>;
  applicantName(userId: string): Promise<string | null>;
  /** Presence heartbeat (SEA-6): refreshes profiles.last_seen_at for an active FTE Ops. */
  heartbeat(userId: string, now: Date): Promise<void>;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface CoordinatorConfig {
  tokenSecret: string;
  approveUrl: string;
  rejectUrl: string;
  /**
   * How item status changes reach SeaTalk after the first create. The official docs expose no update
   * API, so "recreate" re-posts the item with the same item_id (assumed to upsert: LIVE-UNVERIFIED);
   * "off" leaves the item unchanged (SOC5 still ignores stale callbacks).
   */
  syncMode: "off" | "recreate";
  retrySeconds: number;
}

export interface Clock {
  now: () => Date;
}

export type ProvisionOutcome = "delivered" | "already-delivered" | "skipped";

export interface RequestReader {
  getRequest(id: string): Promise<RequestRecord | null>;
}

const stateFor = (r: Pick<RequestRecord, "status" | "approvalStatus">): ItemState =>
  r.approvalStatus === "APPROVED" ? 1 : r.approvalStatus === "REJECTED" ? 2 : r.approvalStatus === "CANCELLED" ? 4 : 0;

export class ApprovalCoordinator {
  private port: ApprovalPort;
  private provider: ApprovalProvider;
  private requests: RequestReader;
  private cfg: CoordinatorConfig;
  private clock: Clock;
  constructor(deps: { port: ApprovalPort; provider: ApprovalProvider; requests: RequestReader; config: CoordinatorConfig; clock?: Clock }) {
    this.port = deps.port;
    this.provider = deps.provider;
    this.requests = deps.requests;
    this.cfg = deps.config;
    this.clock = deps.clock ?? { now: () => new Date() };
  }

  private urls(assignmentId: string) {
    const t = encodeURIComponent(approvalToken(this.cfg.tokenSecret, assignmentId));
    const add = (u: string) => `${u}${u.includes("?") ? "&" : "?"}token=${t}`;
    return { approveUrl: add(this.cfg.approveUrl), rejectUrl: add(this.cfg.rejectUrl) };
  }

  private async itemFor(r: RequestRecord, a: AssignmentView, state: ItemState, history: AssignmentView[]): Promise<ApprovalItemInput> {
    const ts = (iso: string | null) => Math.floor(Date.parse(iso ?? this.clock.now().toISOString()) / 1000);
    const name = (await this.port.applicantName(r.createdBy)) ?? "FTE OPS";
    const mine = history.filter((h) => h.id === a.id || h.itemId === a.itemId);
    const approved = mine.filter((h) => h.status === "APPROVED").map((h) => ({ employeeCode: h.employeeCode, ts: ts(h.respondedAt) }));
    const rejected = mine.filter((h) => h.status === "REJECTED").map((h) => ({ employeeCode: h.employeeCode, ts: ts(h.respondedAt) }));
    const pending = state === 0 && a.status === "PENDING" ? [{ employeeCode: a.employeeCode, ts: ts(a.sentAt) }] : [];
    return {
      itemId: a.itemId,
      applicantName: name,
      title: `Truck request ${r.id.slice(0, 8).toUpperCase()}`,
      subtitle: `${r.cluster} · Dock ${r.dockNo}`,
      description: "Outbound truck request requiring FTE Ops approval.",
      createdAtSec: ts(r.createdAt),
      updatedAtSec: ts(this.clock.now().toISOString()),
      state,
      ...this.urls(a.id),
      pending,
      approved,
      rejected,
      chain: [...approved.map((x) => ({ employeeCode: x.employeeCode, actionTime: x.ts, state: 3 as const })),
              ...rejected.map((x) => ({ employeeCode: x.employeeCode, actionTime: x.ts, state: 2 as const }))],
    };
  }

  /**
   * Route the request to the next present FTE Ops approver and create the SeaTalk item. Safe to call
   * repeatedly (outbox retries): an already-delivered open assignment is a no-op. A provider failure
   * throws so the outbox retries with backoff; the assignment simply expires if delivery never succeeds.
   */
  async provision(requestId: string): Promise<ProvisionOutcome> {
    const now = this.clock.now();
    const assignmentId = crypto.randomUUID();
    const routed = await this.port.assignNext({
      requestId,
      assignmentId,
      itemId: itemIdFor(assignmentId),
      tokenHash: sha256(approvalToken(this.cfg.tokenSecret, assignmentId)),
      now,
    });
    if (routed.result !== "ASSIGNED" && routed.result !== "ALREADY_ASSIGNED") return "skipped";
    const a = routed.assignment;
    if (routed.result === "ALREADY_ASSIGNED" && a.delivered) return "already-delivered";
    const req = await this.requests.getRequest(requestId);
    if (!req) return "skipped";
    // An ALREADY_ASSIGNED assignment keeps its own id, so the token embedded in its URLs still matches its stored hash.
    await this.provider.createItem(await this.itemFor(req, a, 0, [a]));
    await this.port.markDelivered(a.id, this.clock.now());
    return "delivered";
  }

  /** After a decision/cancellation: reflect the outcome on the SeaTalk item (best effort, mode-gated). */
  async syncDecision(requestId: string): Promise<"synced" | "skipped"> {
    if (this.cfg.syncMode === "off") return "skipped";
    const req = await this.requests.getRequest(requestId);
    if (!req) return "skipped";
    const history = await this.port.assignments(requestId);
    const last = [...history].reverse().find((h) => h.delivered);
    if (!last) return "skipped";
    await this.provider.createItem(await this.itemFor(req, last, stateFor(req), history));
    return "synced";
  }

  /**
   * Presence-driven maintenance (SEA-6): expire overdue assignments and reroute their requests, then
   * route orphaned pending requests when an approver is present. Per-request failures never abort the sweep.
   */
  async maintain(): Promise<{ expired: number; routed: number; failed: number }> {
    const now = this.clock.now();
    const expired = await this.port.expire(now);
    const orphans = await this.port.orphans(now, 100, this.cfg.retrySeconds);
    const ids = [...new Set([...expired, ...orphans])];
    let routed = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        if ((await this.provision(id)) === "delivered") routed++;
      } catch {
        failed++; // the open assignment (if any) expires and moves on; the next sweep retries
      }
    }
    return { expired: expired.length, routed, failed };
  }

  /**
   * SEA-1 + SEA-5: a "web approval" is only the application of a decision SeaTalk has already recorded.
   * It is allowed solely when the caller holds the open assignment and the provider reports the item
   * approved by that same employee. A provider outage leaves the request pending (never approves locally).
   */
  async verifyWebApproval(
    actor: Actor,
    requestId: string,
  ): Promise<{ ok: true; assignment: AssignmentView } | { ok: false; code: "NOT_ASSIGNED_APPROVER" | "NOT_APPROVED_IN_SEATALK" | "PROVIDER_UNAVAILABLE" }> {
    const mine = (await this.port.assignments(requestId)).find((a) => a.status === "PENDING" && a.assigneeId === actor.id);
    if (!mine) return { ok: false, code: "NOT_ASSIGNED_APPROVER" };
    try {
      const item = await this.provider.getItem(mine.itemId);
      const approvedByMe = item.state === 1 && item.approved.some((x) => x.employeeCode === mine.employeeCode);
      return approvedByMe ? { ok: true, assignment: mine } : { ok: false, code: "NOT_APPROVED_IN_SEATALK" };
    } catch (e) {
      if (e instanceof SeaTalkProviderError) return { ok: false, code: "PROVIDER_UNAVAILABLE" };
      throw e;
    }
  }

  /** Candidates whose callback may have been missed: pending, delivered assignments. */
  pendingDelivered(limit: number) {
    return this.port.pendingDelivered(limit);
  }
  getItem(itemId: string) {
    return this.provider.getItem(itemId);
  }
  heartbeat(userId: string) {
    return this.port.heartbeat(userId, this.clock.now());
  }
}
