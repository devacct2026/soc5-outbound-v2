// Domain KPI calculations (KPI-1..KPI-5). The SQL functions in
// 20261019000100_workflow_functions.sql implement the same definitions for the
// Supabase path; both are covered by tests.
import type { RequestRecord } from "./requests/lifecycle.ts";

export interface Schedule {
  effectiveFrom: string; // YYYY-MM-DD
  shiftStart: string; // HH:MM
  intervalCount: number;
  timezone: string;
}

export const DEFAULT_SCHEDULE: Schedule = {
  effectiveFrom: "2000-01-01",
  shiftStart: "18:00",
  intervalCount: 13,
  timezone: "Asia/Manila",
};

/** Schedule in force on `date`: historical reports keep their original definition (KPI-4). */
export function scheduleFor(date: string, schedules: Schedule[]): Schedule {
  const eligible = schedules.filter((s) => s.effectiveFrom <= date);
  eligible.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return eligible[0] ?? DEFAULT_SCHEDULE;
}

function parts(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}

/** Local calendar date (YYYY-MM-DD) of an instant in `tz`. */
export function localDate(iso: string, tz: string): string {
  const p = parts(Date.parse(iso), tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** UTC instant (ms) of a wall-clock date+time in `tz` (handles DST via offset refinement). */
export function zonedToUtc(date: string, time: string, tz: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi, 0);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = parts(guess, tz);
    const seen = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    guess += wall - seen;
  }
  return guess;
}

const minutes = (a: string | null, b: string | null): number | null =>
  a && b ? (Date.parse(a) - Date.parse(b)) / 60000 : null;

function avg(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  if (!v.length) return null;
  return Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 100) / 100;
}

type KpiRow = Pick<
  RequestRecord,
  "status" | "requestTimestamp" | "submittedAt" | "approvedAt" | "provideTime" | "linehaulTripAt"
>;

export function kpiSummary(rows: KpiRow[], from: string, to: string, tz: string) {
  const inRange = rows.filter((r) => {
    const d = localDate(r.requestTimestamp, tz);
    return d >= from && d <= to;
  });
  return {
    total: inRange.length,
    confirmed: inRange.filter((r) => r.status === "DOCKED").length, // KPI-1
    cancelled: inRange.filter((r) => r.status === "CANCELLED").length,
    // KPI-2 Option B: final approval minus LATEST submission (earlier cycles excluded).
    averageApprovalMinutes: avg(inRange.map((r) => minutes(r.approvedAt, r.submittedAt))),
    // KPI-3 original formulas.
    averageWaitingMinutes: avg(inRange.map((r) => minutes(r.provideTime, r.requestTimestamp))),
    averageDwellMinutes: avg(inRange.map((r) => minutes(r.linehaulTripAt, r.requestTimestamp))),
  };
}

export function kpiDaily(rows: KpiRow[], from: string, to: string, tz: string) {
  const by = new Map<string, { total: number; confirmed: number }>();
  for (const r of rows) {
    const d = localDate(r.requestTimestamp, tz);
    if (d < from || d > to) continue;
    const e = by.get(d) ?? { total: 0, confirmed: 0 };
    e.total++;
    if (r.status === "DOCKED") e.confirmed++;
    by.set(d, e);
  }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, v]) => ({ date, ...v }));
}

/** Hourly request bins for the shift STARTING on `date`. */
export function kpiHourly(rows: Pick<KpiRow, "requestTimestamp">[], date: string, schedules: Schedule[]) {
  const s = scheduleFor(date, schedules);
  const start = zonedToUtc(date, s.shiftStart, s.timezone);
  const bins = Array.from({ length: s.intervalCount }, (_, index) => {
    const from = start + index * 3_600_000;
    const to = from + 3_600_000;
    const count = rows.filter((r) => {
      const t = Date.parse(r.requestTimestamp);
      return t >= from && t < to;
    }).length;
    return { index, startsAt: new Date(from).toISOString(), count };
  });
  return { date, shiftStart: s.shiftStart, timezone: s.timezone, bins };
}

/** Month-to-date default period (KPI-5), in the reporting timezone. */
export function monthToDate(now: Date, tz: string): { from: string; to: string } {
  const to = localDate(now.toISOString(), tz);
  return { from: `${to.slice(0, 8)}01`, to };
}

/** Last N calendar dates inclusive of today (default 30, KPI-5). */
export function lastDays(now: Date, tz: string, days = 30): { from: string; to: string } {
  const to = localDate(now.toISOString(), tz);
  const d = new Date(`${to}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return { from: d.toISOString().slice(0, 10), to };
}

/** CSV export; cells are neutralised against spreadsheet formula injection. */
export function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    let s = v === null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
