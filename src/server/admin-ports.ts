// Admin ports for memory (tests) and Supabase (RPC functions in the migration).
import type { Role } from "../domain/requests/workflow.ts";
import type { AdminPort } from "./admin.ts";
import type { MemoryStore } from "./memory.ts";
import type { Rest } from "./supabase/rest.ts";
import { MemoryOutboxPort } from "./worker/ports.ts";
import { SupabaseOutboxPort } from "./worker/ports.ts";
import type { OutboxStats } from "./worker/outbox-worker.ts";

export interface MemoryAccount {
  id: string;
  role: Role | null;
  status: "PENDING_APPROVAL" | "ACTIVE" | "DISABLED";
  isAdmin: boolean;
}

export class MemoryAdmin implements AdminPort {
  store: MemoryStore;
  accounts = new Map<string, MemoryAccount>();
  /** Append-only: entries are only ever pushed. */
  audit: { type: string; actorId: string; subject: string; reason: string }[] = [];
  constructor(store: MemoryStore) {
    this.store = store;
  }
  private isAdmin(id: string) {
    const a = this.accounts.get(id);
    return !!a && a.isAdmin && a.status === "ACTIVE";
  }
  outboxStats(now: Date): Promise<OutboxStats> {
    return new MemoryOutboxPort(this.store).stats(now);
  }
  async outboxAction(actorId: string, id: string, action: "RETRY" | "ABANDON", reason: string) {
    if (!this.isAdmin(actorId)) return { ok: false as const, code: "FORBIDDEN" };
    const o = this.store.outbox.find((x) => x.id === id);
    if (!o) return { ok: false as const, code: "NOT_FOUND" };
    if (o.status !== "DEAD_LETTER") return { ok: false as const, code: "INVALID_STATE" };
    if (action === "RETRY") Object.assign(o, { status: "PENDING", attempts: 0, availableAt: 0 });
    else o.status = "ABANDONED";
    this.audit.push({ type: `OUTBOX_${action}`, actorId, subject: id, reason });
    return { ok: true as const };
  }
  async approveAccount(actorId: string, userId: string, role: Role, reason: string) {
    if (!this.isAdmin(actorId)) return { ok: false as const, code: "FORBIDDEN" };
    const a = this.accounts.get(userId);
    if (!a || a.status !== "PENDING_APPROVAL") return { ok: false as const, code: "INVALID_STATE" };
    Object.assign(a, { role, status: "ACTIVE" });
    this.audit.push({ type: "ACCOUNT_APPROVED", actorId, subject: userId, reason });
    return { ok: true as const };
  }
  async disableAccount(actorId: string, userId: string, reason: string) {
    if (!this.isAdmin(actorId)) return { ok: false as const, code: "FORBIDDEN" };
    const a = this.accounts.get(userId);
    if (!a) return { ok: false as const, code: "NOT_FOUND" };
    a.status = "DISABLED";
    this.audit.push({ type: "ACCOUNT_DISABLED", actorId, subject: userId, reason });
    return { ok: true as const };
  }
}

export class SupabaseAdmin implements AdminPort {
  private rest: Rest;
  constructor(rest: Rest) {
    this.rest = rest;
  }
  outboxStats(now: Date) {
    return new SupabaseOutboxPort(this.rest).stats(now);
  }
  private async rpc(fn: string, args: Record<string, unknown>) {
    return (await this.rest.rpc(fn, args)) as { ok: true } | { ok: false; code: string };
  }
  outboxAction(actorId: string, id: string, action: "RETRY" | "ABANDON", reason: string) {
    return this.rpc("admin_outbox_action", { p_id: id, p_action: action, p_actor: actorId, p_reason: reason });
  }
  approveAccount(actorId: string, userId: string, role: Role, reason: string) {
    return this.rpc("admin_approve_account", { p_user: userId, p_role: role, p_actor: actorId, p_reason: reason });
  }
  disableAccount(actorId: string, userId: string, reason: string) {
    return this.rpc("admin_disable_account", { p_user: userId, p_actor: actorId, p_reason: reason });
  }
}
