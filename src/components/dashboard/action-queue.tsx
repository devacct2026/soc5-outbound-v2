"use client";

// Role-based actionable queue with workflow actions. All rules are enforced by the
// server (role, state, ownership); the buttons shown here are a convenience only.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ApiError, apiGet, apiSend, friendlyError, getToken } from "@/lib/api-client";

type Row = {
  id: string; cluster: string; region: string; dock_no: string; status: string; display_status: string;
  plate_number: string | null; driver_id: string | null; created_by: string; rejection_disposition: string | null;
};
type Me = { id: string; role: "ops_pic" | "fte_ops" | "fte_mm" | "doc_officer" };
type Action = "approve" | "reject" | "assign-truck" | "assign-driver" | "dock";

const subscribe = (cb: () => void) => {
  window.addEventListener("soc5-auth-change", cb);
  return () => window.removeEventListener("soc5-auth-change", cb);
};

function actionsFor(me: Me, r: Row): Action[] {
  switch (r.status) {
    case "PENDING":
    case "REROUTED":
      return me.role === "fte_ops" ? ["approve", "reject"] : [];
    case "REQUESTED":
      return me.role === "fte_mm" ? ["assign-truck", "reject"] : [];
    case "DOCKING":
      if (me.role === "doc_officer" && !r.driver_id) return ["assign-driver"];
      if (me.role === "ops_pic" && r.driver_id && r.created_by === me.id) return ["dock"];
      return [];
    default:
      return [];
  }
}

const LABEL: Record<Action, string> = { approve: "Approve", reject: "Reject", "assign-truck": "Assign truck", "assign-driver": "Assign driver", dock: "Enter trip no." };

export function ActionQueue({ page }: { page: string }) {
  const signedIn = useSyncExternalStore(subscribe, () => getToken() !== null, () => false);
  const [me, setMe] = useState<Me | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [active, setActive] = useState<{ id: string; action: Action; key: string } | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [who, q] = await Promise.all([apiGet<Me>("/auth/me"), apiGet<{ data: Row[] }>("/requests/queue?limit=50")]);
      setMe(who);
      setRows(q.data);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setNotice({ kind: "error", text: friendlyError(e) });
    }
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    const t = setTimeout(load, 0);
    const i = setInterval(load, 30_000);
    return () => {
      clearTimeout(t);
      clearInterval(i);
    };
  }, [signedIn, load]);

  if (!signedIn) return null;

  const submit = async () => {
    if (!active) return;
    const { id, action, key } = active;
    const f = fields;
    const body =
      action === "approve" ? {}
      : action === "reject" ? { rejection_remarks: f.remarks ?? "" }
      : action === "assign-truck" ? { plate_number: f.plate ?? "", truck_size: f.size ?? "4W", truck_type: f.type ?? "WETLEASE" }
      : action === "assign-driver" ? { driver_id: f.driver ?? "" }
      : { linehaul_trip_no: f.trip ?? "" };
    const path = action === "reject" ? (me?.role === "fte_mm" ? "reject-mm" : "reject-ops") : action;
    setBusy(true);
    try {
      // The key is minted when the form opens, so a double click or retry replays instead of repeating.
      await apiSend("POST", `/requests/${id}/${path}`, body, key);
      setNotice({ kind: "ok", text: `${LABEL[action]} completed.` });
      setActive(null);
      setFields({});
      await load();
    } catch (e) {
      setNotice({ kind: "error", text: friendlyError(e) });
    } finally {
      setBusy(false);
    }
  };

  const set = (k: string) => (e: { target: { value: string } }) => setFields({ ...fields, [k]: e.target.value });

  return (
    <section className="panel module-content" aria-labelledby="action-queue-title">
      <div className="module-content-heading">
        <div>
          <h2 id="action-queue-title">{page}: your actionable queue</h2>
          <p>{me ? `Signed in as ${me.role.replace("_", " ")} · live data` : "Loading…"}</p>
        </div>
      </div>
      {notice && <p role={notice.kind === "error" ? "alert" : "status"} className="module-note">{notice.text}</p>}
      {rows.length === 0 ? (
        <p className="module-note">Nothing needs your action right now.</p>
      ) : (
        <ul className="module-list">
          {rows.map((r) => (
            <li key={r.id}>
              <span className="module-list-marker" aria-hidden="true" />
              <strong>REQ-{r.id.slice(0, 8).toUpperCase()}</strong> · {r.cluster} · {r.region} · Dock {r.dock_no} · {r.display_status}
              {r.plate_number ? ` · ${r.plate_number}` : ""}{r.driver_id ? ` · driver ${r.driver_id}` : ""}{" "}
              {me && actionsFor(me, r).map((a) => (
                <button key={a} type="button" className="text-link" onClick={() => { setActive({ id: r.id, action: a, key: crypto.randomUUID() }); setFields({}); setNotice(null); }}>
                  {LABEL[a]}
                </button>
              ))}
              {active?.id === r.id && (
                <form onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label={LABEL[active.action]}>
                  {active.action === "reject" && <input required maxLength={2000} placeholder="Remarks (required)" value={fields.remarks ?? ""} onChange={set("remarks")} />}
                  {active.action === "assign-truck" && (
                    <>
                      <input required placeholder="Plate number" value={fields.plate ?? ""} onChange={set("plate")} />{" "}
                      <select value={fields.size ?? "4W"} onChange={set("size")} aria-label="Truck size">
                        {["4W", "4WAUV", "4WCV", "6W", "10W", "6WF"].map((s) => <option key={s}>{s}</option>)}
                      </select>{" "}
                      <select value={fields.type ?? "WETLEASE"} onChange={set("type")} aria-label="Truck type">
                        {["WETLEASE", "DRYLEASE"].map((s) => <option key={s}>{s}</option>)}
                      </select>
                    </>
                  )}
                  {active.action === "assign-driver" && <input required inputMode="numeric" pattern="[0-9]{1,10}" placeholder="Driver ID (1-10 digits)" value={fields.driver ?? ""} onChange={set("driver")} />}
                  {active.action === "dock" && <input required placeholder="Linehaul trip number" value={fields.trip ?? ""} onChange={set("trip")} />}{" "}
                  <button type="submit" disabled={busy}>{busy ? "Working…" : `Confirm ${LABEL[active.action].toLowerCase()}`}</button>{" "}
                  <button type="button" className="text-link" onClick={() => setActive(null)}>Cancel</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
