// Pure mapping from API payloads to the existing dashboard view-models (no React,
// no browser APIs), so the mapping is unit-tested under node:test.
import type { LinehaulRequest, RequestStatus } from "./dashboard-data.ts";

export interface ApiRequest {
  id: string;
  cluster: string;
  region: string;
  dock_no: string;
  plate_number: string | null;
  created_by: string;
  status: string;
  provide_time: string | null;
  request_timestamp: string;
}

export interface ApiIntradayRow {
  date: string;
  hour: number;
  orderQty: number;
  syncedAt: string | null;
}

export interface LiveActivity {
  title: string;
  detail: string;
  time: string;
  color: "green" | "blue" | "red";
}

export interface ApiMetrics {
  total: number;
  awaiting_action: number;
  by_status: Record<string, number>;
}

/** Stored workflow status -> dashboard label. Legacy raw statuses stay visible as "Legacy" (never converted silently). */
export function statusLabel(status: string): RequestStatus {
  switch (status) {
    case "PENDING":
    case "REROUTED":
      return "Pending";
    case "REQUESTED":
      return "Approved";
    case "DOCKING":
      return "In Queue";
    case "DOCKED":
      return "Docked";
    case "REJECTED":
      return "Rejected";
    case "CANCELLED":
      return "Cancelled";
    default:
      return "Legacy";
  }
}

const time = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Manila" })
    : "—";

export function mapRequest(r: ApiRequest): LinehaulRequest {
  return {
    id: `REQ-${r.id.slice(0, 8).toUpperCase()}`,
    hub: r.cluster,
    route: `${r.region} · Dock ${r.dock_no}`,
    plate: r.plate_number ?? "—",
    requestedBy: r.created_by.slice(0, 8),
    status: statusLabel(r.status),
    eta: time(r.provide_time ?? r.request_timestamp),
  };
}

/** Build the dashboard activity rail from the newest request records returned by the API. */
export function buildActivities(rows: ApiRequest[]): LiveActivity[] {
  return rows.slice(0, 6).map((r) => {
    const status = statusLabel(r.status);
    const color: LiveActivity["color"] = status === "Rejected" ? "red" : status === "Pending" ? "blue" : "green";
    return {
      title: `Request ${r.id.slice(0, 8).toUpperCase()} is ${status.toLowerCase()}`,
      detail: `${r.cluster} · ${r.region} · Dock ${r.dock_no}`,
      time: time(r.request_timestamp),
      color,
    };
  });
}

/** Convert the intraday Edge/API response into the chart view-model. */
export function buildHourlyVolume(rows: ApiIntradayRow[]) {
  return rows.map((r) => ({ hour: String(r.hour).padStart(2, "0"), trucks: r.orderQty }));
}

/** The request list is the only API contract that carries request timestamps, so use it for the flow chart. */
export function buildRequestFlow(rows: ApiRequest[]) {
  const counts = new Map<number, number>();
  for (const row of rows) {
    const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "2-digit", hourCycle: "h23", timeZone: "Asia/Manila" }).format(new Date(row.request_timestamp)));
    counts.set(hour, (counts.get(hour) ?? 0) + 1);
  }
  return Array.from({ length: 24 }, (_, hour) => ({
    hour: `${String(hour).padStart(2, "0")}:00`,
    requests: counts.get(hour) ?? 0,
  }));
}

const PIPELINE: { label: string; statuses: string[]; color: "amber" | "sky" | "green" | "purple" | "blue" | "slate" | "red" }[] = [
  { label: "Pending", statuses: ["PENDING", "REROUTED"], color: "amber" },
  { label: "Approved", statuses: ["REQUESTED"], color: "green" },
  { label: "In Queue", statuses: ["DOCKING"], color: "purple" },
  { label: "Docked", statuses: ["DOCKED"], color: "blue" },
  { label: "Rejected", statuses: ["REJECTED"], color: "red" },
  { label: "Cancelled", statuses: ["CANCELLED"], color: "slate" },
];

/** Pipeline rows from real status counts; percent = share of all requests. */
export function buildPipeline(m: ApiMetrics) {
  const total = Math.max(m.total, 1);
  return PIPELINE.map((p) => {
    const count = p.statuses.reduce((s, k) => s + (m.by_status[k] ?? 0), 0);
    return { label: p.label, count, percent: Math.round((count / total) * 100), color: p.color };
  });
}

export interface KpiView {
  label: string;
  value: string;
  change: string;
  direction: string;
  color: string;
  points: string;
}

const FLAT = "2,16 12,16 22,16 32,16 42,16 52,16 62,16 72,16 82,16";

/**
 * Live KPI cards from real counts. Cards without an approved definition show an em dash
 * instead of an invented figure (no undocumented business rules).
 */
export function buildKpis(m: ApiMetrics, intradayToday: number | null): KpiView[] {
  const c = (...k: string[]) => k.reduce((s, x) => s + (m.by_status[x] ?? 0), 0);
  const card = (label: string, value: string, color: string): KpiView => ({ label, value, change: "", direction: "flat", color, points: FLAT });
  return [
    card("Pending Requests", String(c("PENDING", "REROUTED")), "blue"),
    card("Approved Today", String(c("REQUESTED")), "green"),
    card("Trucks in Queue", String(c("DOCKING")), "blue"),
    card("Active Docks", String(c("DOCKED")), "purple"),
    card("Intraday Volume", intradayToday === null ? "—" : String(intradayToday), "sky"),
    card("SLA Risk", "—", "red"),
  ];
}
