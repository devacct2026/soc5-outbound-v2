"use client";

// Create / edit / correct-and-resubmit form. Directory selection (registered clusters) and validated free text
// are both supported (HUB-6 option B); free text never grants authorization. The server re-validates everything.
import { useEffect, useRef, useState } from "react";
import { ApiError, apiGet, apiSend, friendlyError } from "@/lib/api-client";
import { TRUCK_SIZES, TRUCK_TYPES, fmtDateTime, toLocalInput } from "@/lib/request-ui";
import { Field, useIdempotencyKey } from "./common";

export interface ClusterOption {
  id: string;
  cluster_name: string;
  hub_name: string | null;
  region: string;
  dock_number: string | null;
  backlogs: number;
  backlogs_ts: string | null;
}

export interface FormRequest {
  id?: string;
  cluster: string;
  cluster_id: string | null;
  region: string;
  dock_no: string;
  backlogs: number;
  backlogs_timestamp: string | null;
  truck_size: string;
  truck_type: string;
}

export function RequestForm({ initial, mode, onDone, onCancel }: {
  initial?: FormRequest;
  mode: "create" | "edit" | "resubmit";
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const key = useIdempotencyKey(); // one key per submission attempt: a retry replays instead of repeating
  const [cluster, setCluster] = useState(initial?.cluster ?? "");
  const [picked, setPicked] = useState<ClusterOption | null>(null);
  const [clusterId, setClusterId] = useState<string | null>(initial?.cluster_id ?? null);
  const [region, setRegion] = useState(initial?.region ?? "");
  const [dock, setDock] = useState(initial?.dock_no ?? "");
  const [backlogs, setBacklogs] = useState(String(initial?.backlogs ?? 0));
  const [backlogTs, setBacklogTs] = useState<string | null>(initial?.backlogs_timestamp ?? null);
  const [size, setSize] = useState(initial?.truck_size ?? "6W");
  const [type, setType] = useState(initial?.truck_type ?? "WETLEASE");
  const [options, setOptions] = useState<ClusterOption[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  // Debounced directory search (3+ characters, like the original); typing clears a directory selection.
  useEffect(() => {
    if (picked && cluster === picked.cluster_name) return;
    const q = cluster.trim();
    if (q.length < 3) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const r = await apiGet<{ data: ClusterOption[] }>(`/clusters?search=${encodeURIComponent(q)}`);
        if (mine === seq.current) setOptions(r.data);
      } catch {
        if (mine === seq.current) setOptions([]);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [cluster, picked]);

  const choose = (o: ClusterOption) => {
    setPicked(o);
    setCluster(o.cluster_name);
    setClusterId(o.id);
    setRegion(o.region);
    setDock(o.dock_number ?? "");
    setBacklogs(String(o.backlogs));
    setBacklogTs(o.backlogs_ts);
    setOptions([]);
  };

  const submit = async () => {
    setBusy(true);
    setErrors({});
    setMessage(null);
    const body = {
      cluster: cluster.trim(),
      ...(clusterId ? { cluster_id: clusterId } : {}),
      region: region.trim(),
      dock_no: dock.trim(),
      backlogs: Number(backlogs),
      // The original dropped this field on every edit; it is always sent back, so the value is preserved.
      backlogs_timestamp: backlogTs,
      truck_size: size,
      truck_type: type,
    };
    try {
      if (mode === "create") await apiSend("POST", "/requests", body, key.get());
      else await apiSend("PUT", `/requests/${initial!.id}`, body, key.get());
      onDone(mode === "create" ? "Request created and sent for approval." : mode === "resubmit" ? "Request corrected and resubmitted for approval." : "Request updated.");
    } catch (e) {
      if (e instanceof ApiError && e.details && typeof e.details === "object") setErrors(e.details as Record<string, string>);
      setMessage(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const title = mode === "create" ? "New request" : mode === "resubmit" ? "Correct and resubmit" : "Edit request";
  return (
    <form className="ops-form" aria-label={title} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h3>{title}</h3>
      <Field label="Cluster" error={errors.cluster ?? errors.cluster_id}>
        <input role="combobox" aria-expanded={options.length > 0} aria-controls="cluster-options" aria-autocomplete="list" required maxLength={120} value={cluster}
          onChange={(e) => { setCluster(e.target.value); setPicked(null); setClusterId(null); }} placeholder="Search registered clusters or type a name" />
        {options.length > 0 && (
          <ul id="cluster-options" role="listbox" className="ops-options">
            {options.map((o) => (
              <li key={o.id} role="option" aria-selected={false}>
                <button type="button" className="text-link" onClick={() => choose(o)}>
                  {o.cluster_name} · Dock {o.dock_number ?? "—"} / {o.region}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Field>
      <div className="ops-grid">
        <Field label="Region" error={errors.region}>
          <input required maxLength={120} value={region} readOnly={!!picked} onChange={(e) => setRegion(e.target.value)} />
        </Field>
        <Field label="Dock #" error={errors.dock_no}>
          <input required maxLength={50} value={dock} onChange={(e) => setDock(e.target.value)} />
        </Field>
        <Field label="Backlog" error={errors.backlogs}>
          <input required type="number" min={0} step={1} value={backlogs} readOnly={!!picked} onChange={(e) => setBacklogs(e.target.value)} />
        </Field>
        <Field label="Backlog as of" error={errors.backlogs_timestamp}>
          {picked || !!clusterId ? (
            <output>{fmtDateTime(backlogTs)}</output>
          ) : (
            <input type="datetime-local" value={toLocalInput(backlogTs)} onChange={(e) => setBacklogTs(e.target.value || null)} />
          )}
        </Field>
        <Field label="LH size" error={errors.truck_size}>
          <select value={size} onChange={(e) => setSize(e.target.value)}>{TRUCK_SIZES.map((s) => <option key={s}>{s}</option>)}</select>
        </Field>
        <Field label="LH type" error={errors.truck_type}>
          <select value={type} onChange={(e) => setType(e.target.value)}>{TRUCK_TYPES.map((s) => <option key={s}>{s}</option>)}</select>
        </Field>
      </div>
      {message && <p role="alert" className="ops-error">{message}</p>}
      <div className="ops-actions">
        <button type="submit" className="ops-btn ops-primary" disabled={busy}>{busy ? "Saving…" : mode === "create" ? "Create request" : mode === "resubmit" ? "Resubmit" : "Save changes"}</button>
        <button type="button" className="ops-btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
