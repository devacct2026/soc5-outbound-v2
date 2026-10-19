"use client";

// Live KPI screens (lead 12). Intraday Dispatch is operational data for all four roles (HUB-5); KPI analytics,
// hourly charts and CSV export need the explicit reporting permission (KPI-6) and are enforced by the API.
import { useCallback, useEffect, useState } from "react";
import { ApiError, apiDownload, apiGet, friendlyError } from "@/lib/api-client";
import { useLiveRefresh } from "@/lib/use-live";
import { Field, Notice, useAccount, useSignedIn } from "./common";

const TZ = "Asia/Manila";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const monthStart = () => `${today().slice(0, 8)}01`;
const daysAgo = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Date.now() - n * 86_400_000));
const minutes = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} min`);
const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;

function Bars({ data, label }: { data: { label: string; value: number }[]; label: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <ol className="ops-bars" aria-label={label}>
      {data.map((d) => (
        <li key={d.label}>
          <span className="ops-bar-label">{d.label}</span>
          <span className="ops-bar" style={{ width: `${(d.value / max) * 100}%` }} role="presentation" />
          <span className="ops-bar-value">{d.value.toLocaleString()}</span>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- Intraday Dispatch
/** Clock reads happen after mount (never during prerender): the first paint has no date, then the defaults are filled in. */
function useAfterMount(init: () => void) {
  useEffect(() => {
    const t = setTimeout(init, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function IntradayPanel() {
  const signedIn = useSignedIn();
  const [date, setDate] = useState("");
  useAfterMount(() => setDate(today()));
  const [rows, setRows] = useState<{ hour: number; orderQty: number; syncedAt: string | null }[]>([]);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const load = useCallback(async () => {
    if (!date) return;
    try {
      setRows((await apiGet<{ data: { hour: number; orderQty: number; syncedAt: string | null }[] }>(`/dispatch/intraday?date=${date}`)).data);
      setNotice(null);
    } catch (e) {
      setNotice({ kind: "error", text: friendlyError(e) });
    }
  }, [date]);
  useLiveRefresh(load, ["intraday_dispatch"], signedIn);
  if (!signedIn) return null;
  // Shift order, as in the original: 6 AM through 5 AM next morning.
  const ordered = [...rows].sort((a, b) => ((a.hour + 18) % 24) - ((b.hour + 18) % 24));
  const total = rows.reduce((s, r) => s + r.orderQty, 0);
  const peak = rows.reduce<{ hour: number; orderQty: number } | null>((p, r) => (r.orderQty > (p?.orderQty ?? 0) ? r : p), null);
  const synced = rows.map((r) => r.syncedAt).filter((x): x is string => !!x).sort().at(-1);
  return (
    <section className="panel module-content" aria-labelledby="intraday-title">
      <div className="module-content-heading">
        <div>
          <h2 id="intraday-title">Intraday dispatch</h2>
          <p>{synced ? `Synced ${new Date(synced).toLocaleString("en-US", { timeZone: TZ })}` : "No synced data for this date"}</p>
        </div>
        <Field label="Date"><input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} /></Field>
      </div>
      <Notice notice={notice} />
      <p className="ops-summary">
        <strong>{total.toLocaleString()}</strong> orders{peak && peak.orderQty > 0 ? <> · peak <strong>{hourLabel(peak.hour)}</strong> ({peak.orderQty.toLocaleString()})</> : null}
      </p>
      <Bars label="Orders by hour" data={ordered.map((r) => ({ label: hourLabel(r.hour), value: r.orderQty }))} />
    </section>
  );
}

// ---------------------------------------------------------------- KPI reports
interface Summary { total: number; confirmed: number; cancelled: number; averageApprovalMinutes: number | null; averageWaitingMinutes: number | null; averageDwellMinutes: number | null }
interface Daily { date: string; total: number; confirmed: number }
interface Hourly { date: string; shiftStart: string; timezone: string; bins: { index: number; startsAt: string; count: number }[] }

export function ReportsPanel() {
  const signedIn = useSignedIn();
  const { state } = useAccount();
  const allowed = state.kind === "ready" && state.me.reporting_permission === true;
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [shiftDate, setShiftDate] = useState("");
  useAfterMount(() => { setFrom(monthStart()); setTo(today()); setShiftDate(today()); }); // KPI-5 default: month to date
  const [summary, setSummary] = useState<Summary | null>(null);
  const [daily, setDaily] = useState<Daily[]>([]);
  const [hourly, setHourly] = useState<Hourly | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!allowed || !from || !to || !shiftDate) return;
    try {
      const q = `date_from=${from}&date_to=${to}`;
      const [s, d, h] = await Promise.all([
        apiGet<Summary>(`/kpi/summary?${q}`),
        apiGet<{ data: Daily[] }>(`/kpi/daily?${q}`),
        apiGet<Hourly>(`/kpi/hourly?date=${shiftDate}`),
      ]);
      setSummary(s);
      setDaily(d.data);
      setHourly(h);
      setNotice(null);
    } catch (e) {
      setNotice({ kind: "error", text: e instanceof ApiError && e.status === 403 ? "KPI reports need the reporting permission, which an administrator assigns." : friendlyError(e) });
    }
  }, [allowed, from, to, shiftDate]);
  useLiveRefresh(load, ["requests"], signedIn && allowed);

  if (!signedIn) return null;
  if (state.kind !== "ready") return null;
  if (!allowed) {
    return (
      <section className="panel module-content" aria-labelledby="rep-title">
        <h2 id="rep-title">KPI reports</h2>
        <p className="module-note" role="status">Full KPI analytics and report exports need the reporting permission, which is assigned separately from your operational role. Ask an administrator if you need it.</p>
      </section>
    );
  }
  const exportCsv = async () => {
    setBusy(true);
    try {
      await apiDownload(`/kpi/export?date_from=${from}&date_to=${to}`, `requests_${from}_${to}.csv`);
    } catch (e) {
      setNotice({ kind: "error", text: friendlyError(e) });
    } finally {
      setBusy(false);
    }
  };
  const preset = (a: string, b: string) => () => { setFrom(a); setTo(b); };
  return (
    <section className="panel module-content" aria-labelledby="rep-title">
      <div className="module-content-heading">
        <div>
          <h2 id="rep-title">KPI reports</h2>
          <p>{from} to {to} · Asia/Manila</p>
        </div>
        <button type="button" className="ops-btn" disabled={busy} onClick={() => void exportCsv()}>{busy ? "Preparing…" : "Export CSV"}</button>
      </div>
      <Notice notice={notice} />
      <form className="ops-toolbar" aria-label="Reporting period" onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <Field label="From"><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
        <button type="button" className="ops-btn" onClick={preset(monthStart(), today())}>Month to date</button>
        <button type="button" className="ops-btn" onClick={preset(daysAgo(29), today())}>Last 30 days</button>
        <button type="submit" className="ops-btn ops-primary">Apply</button>
      </form>
      {summary && (
        <div className="module-metrics" aria-label="Summary">
          {([
            ["Requests", summary.total.toLocaleString()],
            ["Docked (confirmed)", summary.confirmed.toLocaleString()],
            ["Cancelled", summary.cancelled.toLocaleString()],
            ["Avg approval", minutes(summary.averageApprovalMinutes)],
            ["Avg waiting", minutes(summary.averageWaitingMinutes)],
            ["Avg dwell", minutes(summary.averageDwellMinutes)],
          ] as const).map(([k, v]) => (
            <article className="module-metric panel" key={k}><span>{k}</span><strong>{v}</strong></article>
          ))}
        </div>
      )}
      <h3>Daily trend</h3>
      {daily.length === 0 ? <p className="module-note">No requests in this period.</p> : (
        <div className="table-scroll">
          <table className="requests-table ops-table">
            <thead><tr><th scope="col">Date</th><th scope="col">Requests</th><th scope="col">Docked</th></tr></thead>
            <tbody>{daily.map((d) => <tr key={d.date}><td>{d.date}</td><td>{d.total}</td><td>{d.confirmed}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      <div className="ops-toolbar">
        <h3>Hourly requests</h3>
        <Field label="Shift starting"><input type="date" value={shiftDate} onChange={(e) => e.target.value && setShiftDate(e.target.value)} /></Field>
      </div>
      {hourly && (
        <>
          <p className="module-note">Shift starts {hourly.shiftStart} ({hourly.timezone})</p>
          <Bars label="Requests by hour of shift" data={hourly.bins.map((b) => ({ label: new Date(b.startsAt).toLocaleTimeString("en-US", { timeZone: hourly.timezone, hour: "numeric" }), value: b.count }))} />
        </>
      )}
    </section>
  );
}
