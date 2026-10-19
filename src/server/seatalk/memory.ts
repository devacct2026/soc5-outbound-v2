// In-memory ApprovalStore for tests.
import type { Actor } from "../../domain/requests/workflow.ts";
import { TERMINAL_CALLBACK_STATUSES, type ApprovalStore, type AssignmentInfo, type RecordResult } from "./contract.ts";

export class MemoryApprovalStore implements ApprovalStore {
  callbacks: { id: string; key: string; payloadHash: string; status: string; reason?: string }[] = [];
  assignments = new Map<string, AssignmentInfo & { providerItemId: string; employeeCode: string }>();
  private seq = 0;

  addAssignment(a: Omit<AssignmentInfo, "id"> & { providerItemId: string; employeeCode: string }) {
    const id = `a${++this.seq}`;
    this.assignments.set(id, { ...a, id });
    return id;
  }

  async recordCallback(e: Parameters<ApprovalStore["recordCallback"]>[0]): Promise<RecordResult> {
    const key = e.eventId ? `${e.provider}|id|${e.eventId}` : `${e.provider}|fp|${e.fallbackHash}`;
    const prior = this.callbacks.find((c) => c.key === key);
    if (prior) {
      if (prior.payloadHash !== e.payloadHash) return { kind: "CONFLICT" };
      if (TERMINAL_CALLBACK_STATUSES.includes(prior.status)) return { kind: "DUPLICATE", status: prior.status };
      prior.status = "RECEIVED"; // never reached a terminal outcome: reprocess the redelivery
      return { kind: "RETRY", id: prior.id };
    }
    const id = `cb${++this.seq}`;
    this.callbacks.push({ id, key, payloadHash: e.payloadHash, status: "RECEIVED" });
    return { kind: "NEW", id };
  }
  async finishCallback(id: string, status: string, reason?: string) {
    const c = this.callbacks.find((x) => x.id === id);
    if (c) Object.assign(c, { status, reason });
  }
  async findAssignment(itemId: string, employeeCode: string) {
    for (const a of this.assignments.values()) {
      if (a.providerItemId === itemId && a.employeeCode === employeeCode) return a;
    }
    return null;
  }
  async closeAssignment(id: string, status: "APPROVED" | "REJECTED") {
    const a = this.assignments.get(id);
    if (a) a.status = status;
  }
}

export const actorOf = (id: string, role: Actor["role"] = "fte_ops", active = true): Actor => ({ id, role, active });
