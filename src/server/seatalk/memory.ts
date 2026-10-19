// In-memory ApprovalStore for tests.
import type { Actor } from "../../domain/requests/workflow.ts";
import type { ApprovalStore, AssignmentInfo, RecordResult } from "./contract.ts";

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
    if (prior) return prior.payloadHash === e.payloadHash ? { kind: "DUPLICATE", status: prior.status } : { kind: "CONFLICT" };
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
