"use client";

// User administration (lead 6): directory, Ops ID account creation with a one-time password, role/name edits,
// password reset, disable (immediate: the API re-checks the profile on every request), and administrator approval of
// PENDING_APPROVAL accounts (SeaTalk/Google/OTP sign-ups) with an explicit role and a recorded reason.
import { useCallback, useState } from "react";
import { apiGet, apiSend, friendlyError } from "@/lib/api-client";
import { useLiveRefresh } from "@/lib/use-live";
import { Field, Notice, roleLabel, useAccount, useSignedIn } from "./common";

interface User {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
  ops_id: string | null;
  account_status: "PENDING_APPROVAL" | "ACTIVE" | "DISABLED";
  must_change_password: boolean;
}
const ROLES = ["ops_pic", "fte_ops", "fte_mm", "doc_officer"];

export function UsersPanel() {
  const signedIn = useSignedIn();
  const { state } = useAccount();
  const me = state.kind === "ready" ? state.me : null;
  const [users, setUsers] = useState<User[]>([]);
  const [q, setQ] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [secret, setSecret] = useState<{ label: string; password: string } | null>(null);
  const [creating, setCreating] = useState<{ key: string; name: string; ops: string; role: string } | null>(null);
  const [editing, setEditing] = useState<{ user: User; key: string; name: string; role: string } | null>(null);
  const [approving, setApproving] = useState<{ user: User; key: string; role: string; reason: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers((await apiGet<{ data: User[] }>("/users")).data);
    } catch (e) {
      setNotice({ kind: "error", text: friendlyError(e) });
    }
  }, []);
  const allowed = !!me && (me.is_admin || me.role === "fte_ops" || me.role === "fte_mm");
  useLiveRefresh(load, null, signedIn && allowed);
  if (!signedIn || !me) return null;
  if (!allowed) return <section className="panel module-content"><h2>Users</h2><p className="module-note" role="status">User administration is available to FTE Ops, FTE MM and administrators.</p></section>;

  const run = async (fn: () => Promise<void>, ok: string) => {
    try {
      await fn();
      setNotice({ kind: "ok", text: ok });
      await load();
    } catch (e) {
      setNotice({ kind: "error", text: friendlyError(e) });
    }
  };
  const shown = users.filter((u) => `${u.name} ${u.ops_id ?? ""} ${u.email ?? ""} ${u.role ?? ""}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <section className="panel module-content" aria-labelledby="users-title">
      <div className="module-content-heading">
        <div>
          <h2 id="users-title">Users</h2>
          <p>{users.length} accounts · changes take effect on the user&apos;s next request</p>
        </div>
        <button type="button" className="ops-btn ops-primary" onClick={() => { setCreating({ key: crypto.randomUUID(), name: "", ops: "", role: "ops_pic" }); setSecret(null); }}>Add Ops ID user</button>
      </div>
      <Notice notice={notice} />
      {secret && (
        <div className="ops-secret" role="alert">
          <strong>One-time password for {secret.label}</strong>
          <code>{secret.password}</code>{" "}
          <button type="button" className="ops-btn" onClick={() => void navigator.clipboard?.writeText(secret.password)}>Copy</button>{" "}
          <button type="button" className="ops-btn" onClick={() => setSecret(null)}>Done</button>
          <small>Shown once and never stored. The user must change it at first sign-in.</small>
        </div>
      )}
      {creating && (
        <form className="ops-form" aria-label="Add Ops ID user" onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await apiSend<{ ops_id: string; initial_password: string }>("POST", "/users", { name: creating.name, ops_id: creating.ops, role: creating.role }, creating.key);
            setSecret({ label: r.ops_id, password: r.initial_password });
            setCreating(null);
          }, "User created.");
        }}>
          <h3>Add Ops ID user</h3>
          <div className="ops-grid">
            <Field label="Full name"><input required minLength={2} maxLength={120} value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} /></Field>
            <Field label="Ops ID"><input required pattern="[Oo][Pp][Ss][0-9]+" maxLength={40} placeholder="ops12345" value={creating.ops} onChange={(e) => setCreating({ ...creating, ops: e.target.value })} /></Field>
            <Field label="Role"><select value={creating.role} onChange={(e) => setCreating({ ...creating, role: e.target.value })}><option value="ops_pic">ops pic</option><option value="doc_officer">doc officer</option></select></Field>
          </div>
          <div className="ops-actions"><button type="submit" className="ops-btn ops-primary">Create user</button><button type="button" className="ops-btn" onClick={() => setCreating(null)}>Cancel</button></div>
        </form>
      )}
      {editing && (
        <form className="ops-form" aria-label="Edit user" onSubmit={(e) => {
          e.preventDefault();
          void run(async () => { await apiSend("PUT", `/users/${editing.user.id}`, { name: editing.name, role: editing.role }, editing.key); setEditing(null); }, "User updated.");
        }}>
          <h3>Edit {editing.user.name}</h3>
          <div className="ops-grid">
            <Field label="Full name"><input required minLength={2} maxLength={120} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label="Role"><select value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value })}>{ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}</select></Field>
          </div>
          <div className="ops-actions"><button type="submit" className="ops-btn ops-primary">Save</button><button type="button" className="ops-btn" onClick={() => setEditing(null)}>Cancel</button></div>
        </form>
      )}
      {approving && (
        <form className="ops-form" aria-label="Approve account" onSubmit={(e) => {
          e.preventDefault();
          void run(async () => { await apiSend("POST", `/admin/accounts/${approving.user.id}/approve`, { role: approving.role, reason: approving.reason }, approving.key); setApproving(null); }, "Account approved.");
        }}>
          <h3>Approve {approving.user.name || approving.user.email}</h3>
          <div className="ops-grid">
            <Field label="Role (required)"><select value={approving.role} onChange={(e) => setApproving({ ...approving, role: e.target.value })}>{ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}</select></Field>
            <Field label="Reason (recorded in the audit trail)"><input required minLength={5} maxLength={1000} value={approving.reason} onChange={(e) => setApproving({ ...approving, reason: e.target.value })} /></Field>
          </div>
          <div className="ops-actions"><button type="submit" className="ops-btn ops-primary">Approve and assign role</button><button type="button" className="ops-btn" onClick={() => setApproving(null)}>Cancel</button></div>
        </form>
      )}
      <Field label="Search"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, Ops ID, email or role" /></Field>
      <div className="table-scroll">
        <table className="requests-table ops-table">
          <caption className="sr-only">Users</caption>
          <thead><tr><th scope="col">Name</th><th scope="col">Sign-in</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={5}>No users match.</td></tr>}
            {shown.map((u) => (
              <tr key={u.id}>
                <td>{u.name || "—"}</td>
                <td>{u.ops_id ? `Ops ID ${u.ops_id}` : (u.email ?? "—")}</td>
                <td>{u.role ? roleLabel(u.role) : "—"}</td>
                <td><span className="ops-badge" data-status={u.account_status}>{u.account_status.replace("_", " ").toLowerCase()}</span>{u.must_change_password && <small> · password change pending</small>}</td>
                <td className="ops-row-actions">
                  {u.account_status === "PENDING_APPROVAL" && me.is_admin && <button type="button" className="text-link" onClick={() => setApproving({ user: u, key: crypto.randomUUID(), role: "ops_pic", reason: "" })}>Approve…</button>}
                  {u.account_status === "ACTIVE" && u.id !== me.id && (
                    <>
                      <button type="button" className="text-link" onClick={() => setEditing({ user: u, key: crypto.randomUUID(), name: u.name, role: u.role ?? "ops_pic" })}>Edit</button>
                      {u.ops_id && (u.role === "ops_pic" || u.role === "doc_officer") && (
                        <button type="button" className="text-link" onClick={() => { if (confirm(`Reset the password for ${u.name}? They must change it at next sign-in.`)) void run(async () => { const r = await apiSend<{ initial_password: string }>("POST", `/users/${u.id}/reset-password`, undefined, crypto.randomUUID()); setSecret({ label: u.ops_id ?? u.name, password: r.initial_password }); }, "Password reset."); }}>Reset password</button>
                      )}
                      {u.ops_id && <button type="button" className="text-link" onClick={() => { if (confirm(`Disable ${u.name}? They lose access on their next request.`)) void run(async () => { await apiSend("PATCH", `/users/${u.id}/disable`, undefined, crypto.randomUUID()); }, "User disabled."); }}>Disable</button>}
                      {!u.ops_id && me.is_admin && (
                        <button type="button" className="text-link" onClick={() => { const reason = prompt(`Reason for disabling ${u.name}?`); if (reason && reason.trim().length >= 5) void run(async () => { await apiSend("POST", `/admin/accounts/${u.id}/disable`, { reason: reason.trim() }, crypto.randomUUID()); }, "User disabled."); }}>Disable…</button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
