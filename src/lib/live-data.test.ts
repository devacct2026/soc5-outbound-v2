import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKpis, buildPipeline, mapRequest, statusLabel } from "./live-data.ts";

test("status labels: workflow statuses map to dashboard labels; legacy values are never silently converted", () => {
  assert.deepEqual(["PENDING", "REROUTED", "REQUESTED", "DOCKING", "DOCKED", "REJECTED", "CANCELLED"].map(statusLabel), ["Pending", "Pending", "Approved", "In Queue", "Docked", "Rejected", "Cancelled"]);
  for (const legacy of ["ASSIGNED", "CONFIRMED", "REJECTED_BY_MM", "FOR_DOCKING", "APPROVED"]) assert.equal(statusLabel(legacy), "Legacy");
});

test("mapRequest builds the table row without inventing data", () => {
  const r = mapRequest({ id: "abcdef12-0000-0000-0000-000000000000", cluster: "Pasig", region: "NCR", dock_no: "7", plate_number: null, created_by: "11111111-2222", status: "PENDING", provide_time: null, request_timestamp: "2026-10-19T10:00:00Z" });
  assert.equal(r.id, "REQ-ABCDEF12");
  assert.equal(r.plate, "—");
  assert.equal(r.route, "NCR · Dock 7");
  assert.equal(r.status, "Pending");
});

test("pipeline and KPI cards come from real counts; undefined metrics show a dash", () => {
  const m = { total: 10, awaiting_action: 6, by_status: { PENDING: 2, REROUTED: 1, REQUESTED: 3, DOCKING: 2, DOCKED: 1, REJECTED: 1 } };
  const p = buildPipeline(m);
  assert.equal(p.find((x) => x.label === "Pending")?.count, 3);
  assert.equal(p.find((x) => x.label === "Pending")?.percent, 30);
  assert.equal(p.reduce((s, x) => s + x.count, 0), 10);
  const k = buildKpis(m, 428);
  assert.deepEqual(k.map((x) => x.value), ["3", "3", "2", "1", "428", "—"]);
  assert.equal(buildKpis(m, null)[4].value, "—");
  assert.equal(buildPipeline({ total: 0, awaiting_action: 0, by_status: {} })[0].percent, 0);
});
