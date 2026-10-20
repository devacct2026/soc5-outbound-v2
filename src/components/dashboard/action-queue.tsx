"use client";

// Role-based actionable queue with workflow actions (Queue / Approvals / Docking). Server-side pagination with a
// page-size choice (25/50/100) so every actionable request is reachable, not just the first page. All rules are
// enforced by the server (role, state, ownership); the buttons shown here are a convenience only.
import { useCallback, useState } from "react";
import { apiGet, apiSend, friendlyError } from "@/lib/api-client";
import { canAssignDriver, firstPage, nextPager, prevPager, queueActions, reqCode, TRUCK_SIZES, TRUCK_TYPES, canPrint, type Me, type PageSize, type Pager, type QueueAction } from "@/lib/request-ui";
import { useLiveRefresh } from "@/lib/use-live";
import { Notice, PageSizeSelect, PagerBar, useAccount, useSignedIn } from "@/components/ops/common";
import { PrintLabel, type LabelRequest } from "@/components/ops/print-label";

type Row = {
  id: string; cluster: string; region: string; dock_no: string; status: string; display_status: string;
  plate_number: string | null; driver_id: string | null; created_by: string; rejection_disposition: string | null; docked_at: string | null;
};
type Page = { data: Row[]; has_more: boolean; next_cursor: string | null };

const LABEL: Record<QueueAction, string> = {
  approve: "Approve", reject: "Reject", "assign-truck": "Assign truck", "assign-driver": "Assign driver", "reassign-driver": "Reassign driver", dock: "Enter trip no.",
};

export function ActionQueue({ page }: { page: string }) {
  const signedIn = useSignedIn();
  const { state } = useAccount();
  const me: Me | null = state.kind === "ready" ? state.me : null;
  const [rows, setRows] = useState<Row[]>([]);
  const [size, setSize] = useState<PageSize>(25);
  const [pager, setPager] = useState<Pager>(firstPage());
  const [more, setMore] = useState<{ has: boolean; next: string | null }>({ has: false, next: null });
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [active, setActive] = useState<{ id: string; action: QueueAction; key: string } | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState<LabelRequest | null>(null);
  const [selectedDriverRequestId, setSelectedDriverRequestId] = useState<string | null>(null);
  const [driverDialog, setDriverDialog] = useState<{ id: string; key: string; value: string } | null>(null);
  const selectedDriverRequest = me ? rows.find((r) => r.id === selectedDriverRequestId && canAssignDriver(me, r)) : undefined;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ limit: String(size) });
      const cursor = pager.cursors[pager.index];
      if (cursor) q.set("cursor", cursor);
      const p = await apiGet<Page>(`/requests/queue?${q}`);
      setRows(p.data);
      setMore({ has: p.has_more, next: p.next_cursor });
    } catch (e) {
      setNotice({ kind: "error", text: friendlyError(e) });
    } finally {
      setLoading(false);
    }
  }, [size, pager]);
  useLiveRefresh(load, ["requests"], signedIn && me !== null);

  if (!signedIn || !me) return null;

  const submit = async () => {
    if (!active) return;
    const { id, action, key } = active;
    const f = fields;
    const body =
      action === "approve" ? {}
      : action === "reject" ? { rejection_remarks: f.remarks ?? "" }
      : action === "assign-truck" ? { plate_number: f.plate ?? "", truck_size: f.size ?? "4W", truck_type: f.type ?? "WETLEASE" }
      : action === "assign-driver" || action === "reassign-driver" ? { driver_id: f.driver ?? "" }
      : { linehaul_trip_no: f.trip ?? "" };
    const path = action === "reject" ? (me.role === "fte_mm" ? "reject-mm" : "reject-ops") : action;
    setBusy(true);
    try {
      // The key is minted when the form opens, so a double click or retry replays instead of repeating.
      const saved = await apiSend<{ request: LabelRequest }>("POST", `/requests/${id}/${path}`, body, key);
      setNotice({ kind: "ok", text: `${LABEL[action]} completed.` });
      setActive(null);
      setFields({});
      if (action === "assign-driver" || action === "reassign-driver") setPrinting(saved.request);
      void load();
    } catch (e) {
      setNotice({ kind: "error", text: friendlyError(e) });
    } finally {
      setBusy(false);
    }
  };

  const submitDriverAssignment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!driverDialog || !/^[0-9]{1,10}$/.test(driverDialog.value)) return;
    setBusy(true);
    try {
      const saved = await apiSend<{ request: LabelRequest }>(
        "POST",
        `/requests/${driverDialog.id}/assign-driver`,
        { driver_id: driverDialog.value },
        driverDialog.key,
      );
      setNotice({ kind: "ok", text: "Assign driver completed." });
      setDriverDialog(null);
      setSelectedDriverRequestId(null);
      setPrinting(saved.request);
      void load();
    } catch (e) {
      setNotice({ kind: "error", text: friendlyError(e) });
    } finally {
      setBusy(false);
    }
  };

  const set = (k: string) => (e: { target: { value: string } }) => setFields({ ...fields, [k]: e.target.value });
  const open = (id: string, action: QueueAction, prefill: Record<string, string> = {}) => { setActive({ id, action, key: crypto.randomUUID() }); setFields(prefill); setNotice(null); };

  return (
    <section className="panel module-content" aria-labelledby="action-queue-title">
      <div className="module-content-heading">
        <div>
          <h2 id="action-queue-title">{page}: your actionable queue</h2>
          <p>{`Signed in as ${me.role.replace("_", " ")} · live data`}</p>
        </div>
        <PageSizeSelect value={size} onChange={(n) => { setSize(n); setPager(firstPage()); }} />
      </div>
      <Notice notice={notice} />
      {me.role === "doc_officer" && (
        <div className="ops-bulk">
          <button
            type="button"
            className="ops-btn ops-primary"
            disabled={!selectedDriverRequest || busy}
            onClick={() => {
              if (selectedDriverRequest) {
                setActive(null);
                setDriverDialog({ id: selectedDriverRequest.id, key: crypto.randomUUID(), value: "" });
                setNotice(null);
              }
            }}
          >
            Assign Driver ID
          </button>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="module-note">{loading ? "Loading…" : "Nothing needs your action right now."}</p>
      ) : (
        <ul className="module-list">
          {rows.map((r) => (
            <li key={r.id}>
              <span className="module-list-marker" aria-hidden="true" />
              {canAssignDriver(me, r) && (
                <input
                  type="checkbox"
                  aria-label={`Select ${reqCode(r.id)} for driver assignment`}
                  checked={selectedDriverRequestId === r.id}
                  onChange={(e) => {
                    setSelectedDriverRequestId(e.target.checked ? r.id : null);
                    if (e.target.checked) setActive(null);
                  }}
                />
              )}{" "}
              <strong>{reqCode(r.id)}</strong> · {r.cluster} · {r.region} · Dock {r.dock_no} · {r.display_status}
              {r.plate_number ? ` · ${r.plate_number}` : ""}{r.driver_id ? ` · driver ${r.driver_id}` : ""}{" "}
              {queueActions(me, r).filter((a) => !(me.role === "doc_officer" && a === "assign-driver")).map((a) => (
                <button key={a} type="button" className="text-link" onClick={() => open(r.id, a, a === "reassign-driver" ? { driver: r.driver_id ?? "" } : {})}>
                  {LABEL[a]}
                </button>
              ))}
              {canPrint(r) && (
                <button type="button" className="text-link" onClick={() => setPrinting({ plate_number: r.plate_number, driver_id: r.driver_id, dock_no: r.dock_no, cluster: r.cluster, docked_at: r.docked_at })}>
                  Print label
                </button>
              )}
              {active?.id === r.id && (
                <form className="ops-inline-form" onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label={LABEL[active.action]}>
                  {active.action === "reject" && <input required maxLength={2000} placeholder="Remarks (required)" value={fields.remarks ?? ""} onChange={set("remarks")} />}
                  {active.action === "assign-truck" && (
                    <>
                      <input required placeholder="Plate number" value={fields.plate ?? ""} onChange={set("plate")} />{" "}
                      <select value={fields.size ?? "4W"} onChange={set("size")} aria-label="Truck size">
                        {TRUCK_SIZES.map((s) => <option key={s}>{s}</option>)}
                      </select>{" "}
                      <select value={fields.type ?? "WETLEASE"} onChange={set("type")} aria-label="Truck type">
                        {TRUCK_TYPES.map((s) => <option key={s}>{s}</option>)}
                      </select>
                    </>
                  )}
                  {(active.action === "assign-driver" || active.action === "reassign-driver") && (
                    <input required inputMode="numeric" pattern="[0-9]{1,10}" placeholder="Driver ID (1-10 digits)" value={fields.driver ?? ""} onChange={set("driver")} />
                  )}
                  {active.action === "dock" && <input required placeholder="Linehaul trip number" value={fields.trip ?? ""} onChange={set("trip")} />}{" "}
                  <button type="submit" disabled={busy}>{busy ? "Working…" : `Confirm ${LABEL[active.action].toLowerCase()}`}</button>{" "}
                  <button type="button" className="text-link" onClick={() => setActive(null)}>Cancel</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      <PagerBar page={pager.index} hasMore={more.has} busy={loading}
        onPrev={() => setPager(prevPager(pager))} onNext={() => setPager(nextPager(pager, more.next))} />
      {driverDialog && (
        <div className="request-dialog-overlay">
          <form
            className="request-dialog ops-form"
            aria-label="Assign Driver ID"
            role="dialog"
            aria-modal="true"
            aria-labelledby="driver-assignment-title"
            onSubmit={(e) => void submitDriverAssignment(e)}
          >
            <div className="request-dialog-heading">
              <div>
                <h2 id="driver-assignment-title">Assign Driver ID</h2>
                <p>{reqCode(driverDialog.id)}</p>
              </div>
              <button type="button" className="dialog-close" aria-label="Close driver assignment" onClick={() => setDriverDialog(null)}>×</button>
            </div>
            <label className="ops-field">
              Driver ID
              <input
                autoFocus
                required
                inputMode="numeric"
                pattern="[0-9]{1,10}"
                maxLength={10}
                placeholder="Driver ID (1-10 digits)"
                value={driverDialog.value}
                onChange={(e) => setDriverDialog({ ...driverDialog, key: crypto.randomUUID(), value: e.target.value })}
              />
            </label>
            <div className="ops-actions">
              <button type="submit" className="ops-btn ops-primary" disabled={busy || !/^[0-9]{1,10}$/.test(driverDialog.value)}>
                {busy ? "Saving…" : "Assigned"}
              </button>
              <button type="button" className="ops-btn" disabled={busy} onClick={() => setDriverDialog(null)}>Cancel</button>
            </div>
          </form>
        </div>
      )}
      {printing && <PrintLabel request={printing} onClose={() => setPrinting(null)} />}
    </section>
  );
}
