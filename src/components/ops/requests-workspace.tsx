"use client";

// Requests page: server-side filtering, selectable page size (25/50/100), cursor pagination, create, edit,
// correct-and-resubmit, post-dock edit, cancel, print and bulk approval. Every rule is enforced by the API;
// buttons only reflect what the server would allow for this user and request.
import { Fragment, useCallback, useState } from "react";
import { ApiError, apiGet, apiSend, friendlyError } from "@/lib/api-client";
import {
  canBulkSelect, canCancel, canEdit, canPrint, cancelNeedsRemarks, editLabel, firstPage, fmtDateTime, listQuery, nextPager, prevPager, reqCode,
  STATUS_FILTERS, type ListFilters, type Me, type PageSize, type Pager, type Role,
} from "@/lib/request-ui";
import { useLiveRefresh } from "@/lib/use-live";
import { Field, Notice, PageSizeSelect, PagerBar, useAccount, useIdempotencyKey, useSignedIn } from "./common";
import { PrintLabel } from "./print-label";
import { RequestForm, type FormRequest } from "./request-form";

interface Row extends FormRequest {
  id: string;
  request_timestamp: string;
  status: string;
  display_status: string;
  approval_status: string;
  created_by: string;
  plate_number: string | null;
  driver_id: string | null;
  linehaul_trip_no: string | null;
  docked_at: string | null;
  provide_time: string | null;
  rejection_disposition: string | null;
  rejection_remarks: string | null;
  cancellation_remarks: string | null;
  next_action_role: Role | null;
}
interface Page {
  data: Row[];
  has_more: boolean;
  next_cursor: string | null;
}
interface EventRow {
  id: string;
  type: string;
  at: string;
  actorId: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  metadata: Record<string, unknown>;
}

const EMPTY: ListFilters = { status: "", search: "", dateFrom: "", dateTo: "" };

export function RequestsWorkspace() {
  const signedIn = useSignedIn();
  const { state } = useAccount();
  const me: Me | null = state.kind === "ready" ? state.me : null;
  const [filters, setFilters] = useState<ListFilters>(EMPTY);
  const [draft, setDraft] = useState<ListFilters>(EMPTY);
  const [size, setSize] = useState<PageSize>(25);
  const [pager, setPager] = useState<Pager>(firstPage());
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [form, setForm] = useState<{ mode: "create" | "edit" | "resubmit"; row?: Row } | null>(null);
  const [cancelling, setCancelling] = useState<{ row: Row; key: string; remarks: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [printing, setPrinting] = useState<Row | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const bulkKey = useIdempotencyKey();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPage(await apiGet<Page>(`/requests?${listQuery(filters, size, pager.cursors[pager.index])}`));
    } catch (e) {
      setNotice({ kind: "error", text: friendlyError(e) });
    } finally {
      setLoading(false);
    }
  }, [filters, size, pager]);
  useLiveRefresh(load, ["requests"], signedIn && me !== null);

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    setFilters(draft);
    setPager(firstPage());
  };
  const reload = () => void load();

  const openEvents = async (row: Row) => {
    if (expanded === row.id) return setExpanded(null);
    setExpanded(row.id);
    setEvents(null);
    try {
      setEvents((await apiGet<{ data: EventRow[] }>(`/requests/${row.id}/events`)).data);
    } catch (e) {
      setNotice({ kind: "error", text: friendlyError(e) });
    }
  };

  const submitCancel = async () => {
    if (!cancelling || !me) return;
    const { row, key, remarks } = cancelling;
    if (cancelNeedsRemarks(me) && !remarks.trim()) return setNotice({ kind: "error", text: "Remarks are required to cancel." });
    try {
      await apiSend("POST", `/requests/${row.id}/cancel`, remarks.trim() ? { cancellation_remarks: remarks.trim() } : {}, key);
      setNotice({ kind: "ok", text: `${reqCode(row.id)} cancelled.` });
      setCancelling(null);
      reload();
    } catch (e) {
      setNotice({ kind: "error", text: friendlyError(e) });
    }
  };

  const bulkApprove = async () => {
    try {
      const r = await apiSend<{ data: unknown[]; failed: { id: string; error: string }[] }>("POST", "/requests/bulk-approve", { ids: [...selected] }, bulkKey.get());
      const failed = r.failed.map((f) => `${reqCode(f.id)}: ${friendlyError(new ApiError(0, f.error))}`);
      setNotice({ kind: failed.length ? "error" : "ok", text: `${r.data.length} approved${failed.length ? `; not approved — ${failed.join(" | ")}` : "."}` });
      setSelected(new Set());
      bulkKey.reset();
      reload();
    } catch (e) {
      setNotice({ kind: "error", text: friendlyError(e) });
    }
  };

  if (!signedIn) return null;
  if (!me) return <section className="panel module-content"><p className="module-note">{state.kind === "loading" ? "Loading…" : state.kind === "pending" ? "Your account is awaiting administrator approval." : state.kind === "disabled" ? "This account is disabled." : "Unable to load your account."}</p></section>;

  const rows = page?.data ?? [];
  const canCreate = me.role === "ops_pic" || me.role === "fte_ops";
  const bulkable = rows.filter((r) => canBulkSelect(me, r));
  return (
    <section className="panel module-content" aria-labelledby="req-title">
      <div className="module-content-heading">
        <div>
          <h2 id="req-title">All requests</h2>
          <p>{me.role === "ops_pic" ? "Your requests" : "All hubs"} · live data</p>
        </div>
        {canCreate && <button type="button" className="ops-btn ops-primary" onClick={() => { setForm({ mode: "create" }); setNotice(null); }}>New request</button>}
      </div>
      <Notice notice={notice} />
      {form && (
        <RequestForm
          mode={form.mode}
          initial={form.row}
          onCancel={() => setForm(null)}
          onDone={(m) => { setForm(null); setNotice({ kind: "ok", text: m }); reload(); }}
        />
      )}
      <form className="ops-toolbar" onSubmit={apply} aria-label="Filter requests">
        <Field label="Status">
          <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
            <option value="">All</option>
            {STATUS_FILTERS.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Plate number">
          <input value={draft.search} maxLength={40} onChange={(e) => setDraft({ ...draft, search: e.target.value })} placeholder="e.g. ABC 123" />
        </Field>
        <Field label="From">
          <input type="date" value={draft.dateFrom} onChange={(e) => setDraft({ ...draft, dateFrom: e.target.value })} />
        </Field>
        <Field label="To">
          <input type="date" value={draft.dateTo} min={draft.dateFrom || undefined} onChange={(e) => setDraft({ ...draft, dateTo: e.target.value })} />
        </Field>
        <button type="submit" className="ops-btn">Apply</button>
        <button type="button" className="ops-btn" onClick={() => { setDraft(EMPTY); setFilters(EMPTY); setPager(firstPage()); }}>Clear</button>
        <PageSizeSelect value={size} onChange={(n) => { setSize(n); setPager(firstPage()); }} />
      </form>
      {me.role === "fte_ops" && selected.size > 0 && (
        <p className="ops-bulk">
          {selected.size} selected{" "}
          <button type="button" className="ops-btn ops-primary" disabled={selected.size < 3} onClick={bulkApprove}>Apply SeaTalk approval to selected ({selected.size})</button>{" "}
          {selected.size < 3 && <small>Select at least 3 requests to bulk approve. </small>}
          <button type="button" className="ops-btn" onClick={() => setSelected(new Set())}>Clear selection</button>
        </p>
      )}
      <div className="table-scroll">
        <table className="requests-table ops-table">
          <caption className="sr-only">Requests</caption>
          <thead>
            <tr>
              {me.role === "fte_ops" && (
                <th scope="col">
                  <input type="checkbox" aria-label="Select all approvable on this page" disabled={!bulkable.length}
                    checked={bulkable.length > 0 && bulkable.every((r) => selected.has(r.id))}
                    onChange={(e) => setSelected(e.target.checked ? new Set(bulkable.map((r) => r.id)) : new Set())} />
                </th>
              )}
              <th scope="col">Request</th><th scope="col">Requested</th><th scope="col">Cluster</th><th scope="col">Dock</th>
              <th scope="col">Backlog</th><th scope="col">Backlog as of</th><th scope="col">LH</th><th scope="col">Plate</th>
              <th scope="col">Driver</th><th scope="col">Status</th><th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={me.role === "fte_ops" ? 12 : 11}>{loading ? "Loading…" : "No requests match these filters."}</td></tr>
            )}
            {rows.map((r) => (
              <Fragment key={r.id}>
                <tr>
                  {me.role === "fte_ops" && (
                    <td>
                      {canBulkSelect(me, r) && (
                        <input type="checkbox" aria-label={`Select ${reqCode(r.id)}`} checked={selected.has(r.id)}
                          onChange={(e) => { const n = new Set(selected); if (e.target.checked) n.add(r.id); else n.delete(r.id); setSelected(n); }} />
                      )}
                    </td>
                  )}
                  <td><strong>{reqCode(r.id)}</strong></td>
                  <td>{fmtDateTime(r.request_timestamp)}</td>
                  <td>{r.cluster}<br /><small>{r.region}</small></td>
                  <td>{r.dock_no}</td>
                  <td>{r.backlogs.toLocaleString()}</td>
                  <td>{fmtDateTime(r.backlogs_timestamp)}</td>
                  <td>{r.truck_size} · {r.truck_type}</td>
                  <td>{r.plate_number ?? "—"}</td>
                  <td>{r.driver_id ?? "—"}</td>
                  <td>
                    <span className="ops-badge" data-status={r.status}>{r.display_status}</span>
                    {r.status === "REJECTED" && r.rejection_disposition === "FINAL_NO_ROUTE" && <small> final</small>}
                  </td>
                  <td className="ops-row-actions">
                    <button type="button" className="text-link" aria-expanded={expanded === r.id} onClick={() => void openEvents(r)}>{expanded === r.id ? "Hide" : "Details"}</button>
                    {canEdit(me, r) && <button type="button" className="text-link" onClick={() => { setForm({ mode: r.status === "REJECTED" ? "resubmit" : "edit", row: r }); setNotice(null); }}>{editLabel(r)}</button>}
                    {canCancel(me, r) && <button type="button" className="text-link" onClick={() => { setCancelling({ row: r, key: crypto.randomUUID(), remarks: "" }); setNotice(null); }}>Cancel</button>}
                    {canPrint(r) && <button type="button" className="text-link" onClick={() => setPrinting(r)}>Print label</button>}
                  </td>
                </tr>
                {expanded === r.id && (
                  <tr>
                    <td colSpan={me.role === "fte_ops" ? 12 : 11}>
                      <dl className="ops-details">
                        <dt>Approval</dt><dd>{r.approval_status}{r.next_action_role ? ` · next: ${r.next_action_role.replace("_", " ")}` : ""}</dd>
                        {r.rejection_remarks && <><dt>Rejection remarks</dt><dd>{r.rejection_remarks}</dd></>}
                        {r.cancellation_remarks && <><dt>Cancellation remarks</dt><dd>{r.cancellation_remarks}</dd></>}
                        <dt>Provide time</dt><dd>{fmtDateTime(r.provide_time)}</dd>
                        <dt>LH trip</dt><dd>{r.linehaul_trip_no ?? "—"}</dd>
                        <dt>Docked</dt><dd>{fmtDateTime(r.docked_at)}</dd>
                      </dl>
                      <h4>History</h4>
                      {events === null ? <p className="module-note">Loading…</p> : (
                        <ol className="ops-history">
                          {events.map((ev) => (
                            <li key={ev.id}>
                              <strong>{ev.type.replaceAll("_", " ").toLowerCase()}</strong> · {fmtDateTime(ev.at)}
                              {ev.fromStatus !== ev.toStatus && <> · {ev.fromStatus} → {ev.toStatus}</>}
                              {ev.metadata?.changes ? <small> · changed: {Object.keys(ev.metadata.changes as object).join(", ")}</small> : null}
                            </li>
                          ))}
                        </ol>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <PagerBar page={pager.index} hasMore={!!page?.has_more} busy={loading}
        onPrev={() => setPager(prevPager(pager))} onNext={() => setPager(nextPager(pager, page?.next_cursor ?? null))} />
      {cancelling && me && (
        <form className="ops-form" aria-label="Cancel request" onSubmit={(e) => { e.preventDefault(); void submitCancel(); }}>
          <h3>Cancel {reqCode(cancelling.row.id)}</h3>
          <Field label={cancelNeedsRemarks(me) ? "Remarks (required)" : "Remarks (optional)"}>
            <textarea maxLength={2000} required={cancelNeedsRemarks(me)} value={cancelling.remarks} onChange={(e) => setCancelling({ ...cancelling, remarks: e.target.value })} />
          </Field>
          <div className="ops-actions">
            <button type="submit" className="ops-btn ops-primary">Confirm cancellation</button>
            <button type="button" className="ops-btn" onClick={() => setCancelling(null)}>Keep request</button>
          </div>
        </form>
      )}
      {printing && <PrintLabel request={printing} onClose={() => setPrinting(null)} />}
    </section>
  );
}
