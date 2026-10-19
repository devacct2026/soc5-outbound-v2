// Provider reconciliation (SEA-5): a callback can be lost, so verified SeaTalk decisions are pulled and applied
// through the SAME workflow path as callbacks. SOC5 stays authoritative: stale/expired assignments and
// already-decided requests are ignored, a late decision never overwrites a newer valid one.
import type { Backend } from "../backend.ts";
import { sha256 } from "./contract.ts";
import { applyProviderDecision, type SeatalkWiring } from "./callback.ts";
import type { ApprovalCoordinator } from "./approvals.ts";
import { SeaTalkProviderError } from "./provider.ts";

export interface ReconcileResult {
  checked: number;
  applied: number;
  ignored: number;
  providerErrors: number;
  /** Provider says rejected but gave no reason: left for a human (a rejection needs remarks). */
  manualReview: number;
}

export async function reconcileApprovals(opts: {
  backend: Backend;
  wiring: SeatalkWiring;
  coordinator: ApprovalCoordinator;
  limit?: number;
}): Promise<ReconcileResult> {
  const out: ReconcileResult = { checked: 0, applied: 0, ignored: 0, providerErrors: 0, manualReview: 0 };
  const pending = await opts.coordinator.pendingDelivered(opts.limit ?? 100);
  for (const a of pending) {
    out.checked++;
    let item;
    try {
      item = await opts.coordinator.getItem(a.itemId);
    } catch (e) {
      if (e instanceof SeaTalkProviderError) {
        out.providerErrors++;
        continue; // outage: the request simply stays pending (SEA-1)
      }
      throw e;
    }
    const approved = item.state === 1 && item.approved.some((x) => x.employeeCode === a.employeeCode);
    const rejected = item.state === 2 && item.rejected.some((x) => x.employeeCode === a.employeeCode);
    if (!approved && !rejected) continue;
    const info = await opts.wiring.approvals.findAssignment(a.itemId, a.employeeCode);
    if (!info) continue;
    const reason = rejected ? (item.comments[a.employeeCode] ?? "").trim() : null;
    if (rejected && !reason) {
      out.manualReview++;
      continue;
    }
    const action = approved ? "approve" : "reject";
    const res = await applyProviderDecision(
      opts.backend,
      opts.wiring,
      info,
      action,
      reason,
      `seatalk-reconcile:${a.id}:${action}:${sha256(reason ?? "").slice(0, 16)}`,
      { itemId: a.itemId, action, reason, source: "reconcile" },
    );
    if (res.kind === "PROCESSED") out.applied++;
    else out.ignored++;
  }
  return out;
}
