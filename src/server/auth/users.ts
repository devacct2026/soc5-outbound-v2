// Profile/user persistence port for the sign-in and user-administration flows (Supabase RPC + PostgREST).
import type { Role } from "../../domain/requests/workflow.ts";
import { Rest, q } from "../supabase/rest.ts";

export interface ProfileRow {
  id: string;
  fullName: string;
  email: string;
  role: Role | null;
  opsId: string | null;
  accountStatus: "PENDING_APPROVAL" | "ACTIVE" | "DISABLED";
  mustChangePassword: boolean;
  seatalkEmployeeCode: string | null;
}

export type UserOpResult = { ok: true } | { ok: false; code: string };

export interface UserPort {
  backroomProfile(opsId: string): Promise<ProfileRow | null>;
  profileByEmail(email: string): Promise<ProfileRow | null>;
  profileBySeatalk(code: string): Promise<ProfileRow | null>;
  profileById(id: string): Promise<ProfileRow | null>;
  /** One-time binding of a SeaTalk employee code to an existing profile (null-only; unique in the database). */
  bindSeatalk(profileId: string, code: string): Promise<boolean>;
  allowedDomains(): Promise<string[]>;
  list(): Promise<ProfileRow[]>;
  createBackroom(a: { id: string; name: string; opsId: string; role: Role; actorId: string }): Promise<UserOpResult>;
  update(a: { id: string; name: string; role: Role; actorId: string }): Promise<UserOpResult>;
  markPasswordReset(id: string, actorId: string): Promise<UserOpResult>;
  markPasswordChanged(id: string): Promise<UserOpResult>;
  disableBackroom(id: string, actorId: string): Promise<UserOpResult>;
  submitAccessRequest(name: string, opsId: string): Promise<UserOpResult>;
}

const row = (r: Record<string, unknown>): ProfileRow => ({
  id: String(r.id),
  fullName: String(r.full_name ?? ""),
  email: String(r.email ?? ""),
  role: (r.role as Role | null) ?? null,
  opsId: (r.ops_id as string | null) ?? null,
  accountStatus: r.account_status as ProfileRow["accountStatus"],
  mustChangePassword: r.must_change_password === true,
  seatalkEmployeeCode: (r.seatalk_employee_code as string | null) ?? null,
});
const COLS = "id,full_name,email,role,ops_id,account_status,must_change_password,seatalk_employee_code";

export class SupabaseUsers implements UserPort {
  private rest: Rest;
  constructor(rest: Rest) {
    this.rest = rest;
  }
  private async one(filter: string) {
    const rows = await this.rest.select("profiles", `${filter}&select=${COLS}&limit=1`);
    return rows[0] ? row(rows[0]) : null;
  }
  backroomProfile(opsId: string) {
    return this.one(`ops_id=eq.${q(opsId.toLowerCase())}&account_status=eq.ACTIVE&role=in.(ops_pic,doc_officer)`);
  }
  profileByEmail(email: string) {
    return this.one(`email=eq.${q(email.toLowerCase())}`);
  }
  profileBySeatalk(code: string) {
    return this.one(`seatalk_employee_code=eq.${q(code)}`);
  }
  profileById(id: string) {
    return this.one(`id=eq.${q(id)}`);
  }
  async bindSeatalk(profileId: string, code: string) {
    try {
      await this.rest.patch("profiles", `id=eq.${q(profileId)}&seatalk_employee_code=is.null`, { seatalk_employee_code: code });
      return true;
    } catch {
      return false; // unique violation: the code belongs to another profile
    }
  }
  async allowedDomains() {
    const rows = await this.rest.select("app_settings", "key=eq.allowed_email_domains&select=value&limit=1");
    const v = rows[0]?.value;
    return Array.isArray(v) ? v.filter((d): d is string => typeof d === "string").map((d) => d.toLowerCase()) : [];
  }
  async list() {
    return (await this.rest.select("profiles", `select=${COLS}&order=full_name.asc&limit=1000`)).map(row);
  }
  private async rpc(fn: string, args: Record<string, unknown>): Promise<UserOpResult> {
    const r = (await this.rest.rpc(fn, args)) as { ok: boolean; code?: string };
    return r.ok ? { ok: true } : { ok: false, code: r.code ?? "VALIDATION_FAILED" };
  }
  createBackroom(a: { id: string; name: string; opsId: string; role: Role; actorId: string }) {
    return this.rpc("admin_create_backroom_user", { p_id: a.id, p_name: a.name, p_ops_id: a.opsId, p_role: a.role, p_actor: a.actorId });
  }
  update(a: { id: string; name: string; role: Role; actorId: string }) {
    return this.rpc("admin_update_user", { p_user: a.id, p_name: a.name, p_role: a.role, p_actor: a.actorId });
  }
  markPasswordReset(id: string, actorId: string) {
    return this.rpc("admin_mark_password_reset", { p_user: id, p_actor: actorId });
  }
  markPasswordChanged(id: string) {
    return this.rpc("mark_password_changed", { p_user: id });
  }
  disableBackroom(id: string, actorId: string) {
    return this.rpc("fte_disable_backroom_user", { p_user: id, p_actor: actorId });
  }
  submitAccessRequest(name: string, opsId: string) {
    return this.rpc("submit_access_request", { p_name: name, p_ops_id: opsId });
  }
}
