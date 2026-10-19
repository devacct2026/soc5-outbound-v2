// Supabase ApprovalStore. Dedupe relies on the unique indexes in the base schema
// (provider+event_id, or provider+fallback_hash when the provider sent no id).
import type { Actor, Role } from "../../domain/requests/workflow.ts";
import { Rest, RestError, q } from "../supabase/rest.ts";
import { TERMINAL_CALLBACK_STATUSES, type ApprovalStore, type AssignmentInfo, type RecordResult } from "./contract.ts";

export class SupabaseApprovalStore implements ApprovalStore {
  private rest: Rest;
  constructor(rest: Rest) {
    this.rest = rest;
  }

  async recordCallback(e: Parameters<ApprovalStore["recordCallback"]>[0]): Promise<RecordResult> {
    try {
      const rows = (await this.rest.insert(
        "seatalk_callback_events",
        {
          provider: e.provider,
          event_id: e.eventId,
          fallback_hash: e.fallbackHash,
          payload_hash: e.payloadHash,
          employee_code: e.employeeCode,
          action: e.action,
        },
        "return=representation",
      )) as { id: string }[];
      return { kind: "NEW", id: rows[0].id };
    } catch (err) {
      if (!(err instanceof RestError) || err.code !== "23505") throw err;
    }
    const where = e.eventId ? `event_id=eq.${q(e.eventId)}` : `event_id=is.null&fallback_hash=eq.${q(e.fallbackHash ?? "")}`;
    const rows = await this.rest.select("seatalk_callback_events", `provider=eq.${q(e.provider)}&${where}&limit=1`);
    const prior = rows[0];
    if (!prior) throw new Error("callback dedupe row vanished");
    if (prior.payload_hash !== e.payloadHash) return { kind: "CONFLICT" };
    if (TERMINAL_CALLBACK_STATUSES.includes(String(prior.status))) return { kind: "DUPLICATE", status: String(prior.status) };
    await this.rest.patch("seatalk_callback_events", `id=eq.${q(String(prior.id))}`, { status: "RECEIVED" });
    return { kind: "RETRY", id: String(prior.id) };
  }

  async finishCallback(id: string, status: "PROCESSED" | "IGNORED" | "FAILED", reason?: string) {
    await this.rest.patch("seatalk_callback_events", `id=eq.${q(id)}`, { status, failure_reason: reason ?? null });
  }

  async findAssignment(providerItemId: string, employeeCode: string): Promise<AssignmentInfo | null> {
    const rows = await this.rest.select(
      "seatalk_approval_assignments",
      `provider_item_id=eq.${q(providerItemId)}&order=created_at.desc&limit=1`,
    );
    const a = rows[0];
    if (!a) return null;
    const prof = (
      await this.rest.select(
        "profiles",
        `id=eq.${q(String(a.assignee_id))}&seatalk_employee_code=eq.${q(employeeCode)}&select=id,role,account_status&limit=1`,
      )
    )[0];
    if (!prof) return null; // employee code must match the assignee's current profile
    const actor: Actor = {
      id: String(prof.id),
      role: (prof.role ?? "ops_pic") as Role,
      active: prof.account_status === "ACTIVE" && !!prof.role,
    };
    return {
      id: String(a.id),
      requestId: String(a.request_id),
      actor,
      status: a.status as AssignmentInfo["status"],
      tokenHash: String(a.token_hash ?? ""),
      expiresAt: String(a.expires_at ?? new Date(0).toISOString()),
    };
  }

  async closeAssignment(id: string, status: "APPROVED" | "REJECTED") {
    // The request-status trigger may already have CLOSED the assignment inside the decision transaction;
    // the responder's outcome still wins over that generic closure.
    await this.rest.patch("seatalk_approval_assignments", `id=eq.${q(id)}&status=in.(PENDING,CLOSED)`, {
      status,
      responded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
}
