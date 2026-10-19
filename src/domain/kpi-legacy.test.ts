import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLegacy, previewReconciliation, type LegacyRow } from "./legacy-status.ts";
import { kpiDaily, kpiHourly, kpiSummary, lastDays, localDate, monthToDate, scheduleFor, toCsv, zonedToUtc, DEFAULT_SCHEDULE, type Schedule } from "./kpi.ts";

const row = (o: Partial<LegacyRow>): LegacyRow => ({ id: "r", status: "ASSIGNED", ...o });

test("ST-1/ST-7: ASSIGNED is historical-only and never auto-converted or actionable", () => {
  const p = classifyLegacy(row({ status: "ASSIGNED", plateNumber: "X", driverId: "1" }));
  assert.equal(p.outcome, "PRESERVE");
  assert.equal(p.targetStatus, null);
  assert.equal(p.actionable, false);
  assert.equal(p.legacyReview, "UNRESOLVED");
});

test("ST-2: REJECTED_BY_MM is preserved, never cancelled or reactivated", () => {
  const p = classifyLegacy(row({ status: "REJECTED_BY_MM" }));
  assert.equal(p.outcome, "PRESERVE");
  assert.notEqual(p.targetStatus, "CANCELLED");
  assert.equal(p.actionable, false);
});

test("ST-3: CONFIRMED -> DOCKED only with verified equivalence AND complete docking evidence", () => {
  const evidence = { plateNumber: "P", driverId: "1", linehaulTripNo: "T", linehaulTripAt: "2026-01-01T00:00:00Z" };
  assert.equal(classifyLegacy(row({ status: "CONFIRMED", ...evidence })).outcome, "PRESERVE", "unverified");
  assert.equal(classifyLegacy(row({ status: "CONFIRMED", ...evidence, businessEquivalenceVerified: true })).targetStatus, "DOCKED");
  assert.equal(classifyLegacy(row({ status: "CONFIRMED", businessEquivalenceVerified: true })).outcome, "MANUAL_REVIEW", "incomplete evidence");
  assert.equal(classifyLegacy(row({ status: "CONFIRMED", ...evidence, businessEquivalenceVerified: true })).actionable, false);
});

test("ST-4: FOR_DOCKING -> DOCKING only when complete and authorized; incomplete stays non-actionable", () => {
  const full = { plateNumber: "P", truckSize: "4W", truckType: "WETLEASE", provideTime: "2026-01-01T00:00:00Z" };
  assert.equal(classifyLegacy(row({ status: "FOR_DOCKING", ...full, actorAuthorizationVerified: true })).targetStatus, "DOCKING");
  assert.equal(classifyLegacy(row({ status: "FOR_DOCKING", ...full })).outcome, "MANUAL_REVIEW");
  const inc = classifyLegacy(row({ status: "FOR_DOCKING", plateNumber: "P", actorAuthorizationVerified: true }));
  assert.equal(inc.outcome, "MANUAL_REVIEW");
  assert.equal(inc.actionable, false);
});

test("ST-5: APPROVED -> REQUESTED only with approval evidence; ST-6 flags ambiguity", () => {
  const ok = classifyLegacy(row({ status: "APPROVED", approvedAt: "2026-01-01T00:00:00Z", approvedBy: "u", actorAuthorizationVerified: true }));
  assert.equal(ok.targetStatus, "REQUESTED");
  assert.equal(classifyLegacy(row({ status: "APPROVED" })).outcome, "MANUAL_REVIEW");
  assert.equal(classifyLegacy(row({ status: "APPROVED", approvedAt: "x", approvedBy: "u", actorAuthorizationVerified: true, approvalStatus: "REJECTED" })).outcome, "MANUAL_REVIEW", "conflicting evidence");
  assert.equal(classifyLegacy(row({ status: "WEIRD" })).outcome, "MANUAL_REVIEW");
  assert.equal(classifyLegacy(row({ status: "PENDING" })).outcome, "NO_CHANGE");
});

test("preview: originals preserved, no side effects, source/target counts reconcile", () => {
  const rows = [
    row({ id: "1", status: "ASSIGNED" }), row({ id: "2", status: "REJECTED_BY_MM" }), row({ id: "3", status: "PENDING" }),
    row({ id: "4", status: "APPROVED", approvedAt: "x", approvedBy: "u", actorAuthorizationVerified: true }), row({ id: "5", status: "FOR_DOCKING" }),
  ];
  const rep = previewReconciliation(rows);
  assert.equal(rep.sourceCount, 5);
  assert.equal(rep.targetCount, 5);
  assert.equal(rep.reconciled, true);
  assert.equal(rep.sideEffects, false);
  assert.ok(rep.proposals.every((x) => x.preserveOriginal && x.sideEffects === false));
  assert.deepEqual(rep.byOutcome, { AUTO_CONVERT: 1, PRESERVE: 2, MANUAL_REVIEW: 1, NO_CHANGE: 1 });
  assert.equal(previewReconciliation([row({ id: "d" }), row({ id: "d" })]).reconciled, false, "duplicate ids detected");
});

// ------------------------------------------------------------------ KPI
const mk = (o: Partial<Parameters<typeof kpiSummary>[0][number]>) => ({
  status: "PENDING" as const, requestTimestamp: "2026-10-20T10:00:00Z", submittedAt: "2026-10-20T10:00:00Z",
  approvedAt: null, provideTime: null, linehaulTripAt: null, ...o,
});

test("KPI-1/2/3: confirmed = DOCKED; approval uses latest submission; waiting and dwell formulas", () => {
  const s = kpiSummary([
    mk({ status: "DOCKED", submittedAt: "2026-10-20T10:30:00Z", approvedAt: "2026-10-20T10:40:00Z", provideTime: "2026-10-20T11:00:00Z", linehaulTripAt: "2026-10-20T12:00:00Z" }),
    mk({ status: "CANCELLED" }),
    mk({ status: "CONFIRMED" as never }),
  ], "2026-10-20", "2026-10-20", "Asia/Manila");
  assert.equal(s.total, 3);
  assert.equal(s.confirmed, 1, "raw CONFIRMED is not canonical DOCKED");
  assert.equal(s.cancelled, 1);
  assert.equal(s.averageApprovalMinutes, 10, "previous rejection/resubmission cycles excluded");
  assert.equal(s.averageWaitingMinutes, 60);
  assert.equal(s.averageDwellMinutes, 120);
  assert.equal(kpiSummary([], "2026-10-20", "2026-10-20", "Asia/Manila").averageApprovalMinutes, null, "missing timestamps => null, not NaN");
});

test("KPI date boundaries follow the reporting timezone (Manila = UTC+8)", () => {
  assert.equal(localDate("2026-10-20T15:59:59Z", "Asia/Manila"), "2026-10-20");
  assert.equal(localDate("2026-10-20T16:00:00Z", "Asia/Manila"), "2026-10-21");
  const rows = [mk({ requestTimestamp: "2026-10-20T15:59:59Z" }), mk({ requestTimestamp: "2026-10-20T16:00:00Z" })];
  assert.equal(kpiSummary(rows, "2026-10-20", "2026-10-20", "Asia/Manila").total, 1);
  assert.deepEqual(kpiDaily(rows, "2026-10-01", "2026-10-31", "Asia/Manila"), [
    { date: "2026-10-20", total: 1, confirmed: 0 }, { date: "2026-10-21", total: 1, confirmed: 0 },
  ]);
});

test("KPI-4: shift bins start at 18:00 local, 13 hourly intervals, schedule boundaries inclusive/exclusive", () => {
  assert.equal(new Date(zonedToUtc("2026-10-20", "18:00", "Asia/Manila")).toISOString(), "2026-10-20T10:00:00.000Z");
  const rows = [
    { requestTimestamp: "2026-10-20T09:59:59Z" }, // 17:59:59 local: before shift
    { requestTimestamp: "2026-10-20T10:00:00Z" }, // bin 0 start (inclusive)
    { requestTimestamp: "2026-10-20T10:59:59Z" },
    { requestTimestamp: "2026-10-20T11:00:00Z" }, // bin 1
    { requestTimestamp: "2026-10-20T22:59:59Z" }, // last bin (index 12) end - 1s
    { requestTimestamp: "2026-10-20T23:00:00Z" }, // after the 13th interval (exclusive)
  ];
  const h = kpiHourly(rows, "2026-10-20", [DEFAULT_SCHEDULE]);
  assert.equal(h.bins.length, 13);
  assert.deepEqual(h.bins.map((b) => b.count), [2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
});

test("KPI-4: historical reports keep the schedule in force on their date; DST-safe conversion", () => {
  const schedules: Schedule[] = [
    DEFAULT_SCHEDULE,
    { effectiveFrom: "2026-11-01", shiftStart: "06:00", intervalCount: 12, timezone: "Asia/Manila" },
  ];
  assert.equal(scheduleFor("2026-10-31", schedules).intervalCount, 13);
  assert.equal(scheduleFor("2026-11-01", schedules).intervalCount, 12);
  assert.equal(kpiHourly([], "2026-10-20", schedules).bins.length, 13, "history unchanged by later schedule");
  assert.equal(kpiHourly([], "2026-11-02", schedules).bins.length, 12);
  // US DST spring-forward: 2026-03-08 02:00 does not exist in New York; conversion must not throw/loop
  assert.ok(Number.isFinite(zonedToUtc("2026-03-08", "02:30", "America/New_York")));
  assert.equal(new Date(zonedToUtc("2026-07-01", "18:00", "America/New_York")).toISOString(), "2026-07-01T22:00:00.000Z");
});

test("KPI-5 defaults: month-to-date and last 30 calendar dates", () => {
  const now = new Date("2026-10-19T10:00:00Z");
  assert.deepEqual(monthToDate(now, "Asia/Manila"), { from: "2026-10-01", to: "2026-10-19" });
  assert.deepEqual(lastDays(now, "Asia/Manila"), { from: "2026-09-20", to: "2026-10-19" });
});

test("CSV export neutralises formula injection and escapes quotes/newlines", () => {
  const csv = toCsv(["a", "b"], [["=SUM(A1)", 'he said "hi"'], ["+1", "line\nbreak"], ["-x", "@y"], [null, 5]]);
  const lines = csv.split("\r\n");
  assert.equal(lines[1], `'=SUM(A1),"he said ""hi"""`);
  assert.ok(lines[2].startsWith("'+1,"));
  assert.ok(csv.includes(`"line\nbreak"`));
  assert.ok(lines[3].startsWith("'-x,'@y"));
  assert.equal(lines[4], ",5");
});
