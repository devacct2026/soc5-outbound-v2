import { test } from "node:test";
import assert from "node:assert/strict";
import { canCancel as serverCanCancel, createRequest, editRequest, type RequestRecord } from "../domain/requests/lifecycle.ts";
import type { Actor, RejectionDisposition, Role } from "../domain/requests/workflow.ts";
import {
  canBulkSelect, canCancel, canEdit, canPrint, fmtDateTime, firstPage, labelKind, labelLoads, listQuery, nextPager, prevPager, queueActions, toLocalInput,
  type Me, type RowRequest,
} from "./request-ui.ts";

const NOW = new Date("2026-10-19T10:00:00Z");
const details = { clusterId: null, cluster: "C", region: "R", dockNo: "1", backlogs: 1, backlogsTimestamp: null, truckSize: "4W" as const, truckType: "WETLEASE" as const };
const changed = { ...details, backlogs: 2 };

function record(over: Partial<RequestRecord>, creator: Actor): RequestRecord {
  const r = createRequest(creator, details, { now: NOW, correlationId: "c", newId: crypto.randomUUID() });
  if (!r.ok) throw new Error("setup");
  return { ...(r.request as RequestRecord), ...over };
}

const roles: Role[] = ["ops_pic", "fte_ops", "fte_mm", "doc_officer"];
type Case = { name: string; over: Partial<RequestRecord>; creatorRole: "ops_pic" | "fte_ops" };
const cases: Case[] = [
  { name: "pending", over: {}, creatorRole: "ops_pic" },
  { name: "rerouted", over: { status: "REROUTED" }, creatorRole: "ops_pic" },
  { name: "requested", over: { status: "REQUESTED", approvalStatus: "APPROVED" }, creatorRole: "ops_pic" },
  { name: "docking no driver", over: { status: "DOCKING", approvalStatus: "APPROVED", plateNumber: "A1" }, creatorRole: "ops_pic" },
  { name: "docking with driver", over: { status: "DOCKING", approvalStatus: "APPROVED", plateNumber: "A1", driverId: "9" }, creatorRole: "ops_pic" },
  { name: "docked", over: { status: "DOCKED", approvalStatus: "APPROVED", plateNumber: "A1", driverId: "9", linehaulTripNo: "T" }, creatorRole: "ops_pic" },
  { name: "cancelled", over: { status: "CANCELLED", approvalStatus: "CANCELLED" }, creatorRole: "ops_pic" },
  ...(["RETURN_TO_OPS_PIC", "RETURN_TO_FTE_OPS", "FINAL_NO_ROUTE", "LEGACY_UNRESOLVED"] as RejectionDisposition[]).flatMap((d) =>
    (["ops_pic", "fte_ops"] as const).map((c) => ({
      name: `rejected ${d} by ${c}-created`, creatorRole: c,
      over: { status: "REJECTED" as const, approvalStatus: "REJECTED" as const, rejectionDisposition: d, rejectionReturnRole: d === "RETURN_TO_OPS_PIC" ? ("ops_pic" as const) : d === "RETURN_TO_FTE_OPS" ? ("fte_ops" as const) : null, rejectionRemarks: "no" },
    })),
  ),
];

test("UI offers edit/cancel/queue actions only where the server domain allows them (parity matrix over role x state x ownership)", () => {
  let checked = 0;
  for (const c of cases) {
    for (const role of roles) {
      for (const own of [true, false]) {
        const creator: Actor = { id: "creator", role: c.creatorRole, active: true };
        const actor: Actor = { id: own ? "creator" : "other", role, active: true };
        const rec = record({ createdBy: "creator", creatorRole: c.creatorRole, ...c.over }, creator);
        const me: Me = { id: actor.id, role };
        const row: RowRequest = {
          id: rec.id, status: rec.status, created_by: rec.createdBy, driver_id: rec.driverId, plate_number: rec.plateNumber,
          rejection_disposition: rec.rejectionDisposition,
        };
        const where = `${c.name} / ${role} / ${own ? "creator" : "non-creator"}`;
        // Edit: the UI must never offer what the server refuses, and must offer everything the server allows.
        const serverEdit = editRequest(rec, actor, changed, { now: NOW, correlationId: "x" }).ok;
        // Ops PIC only ever sees their own requests (creator-scoped visibility), so a non-creator ops_pic cannot reach the row at all.
        const visible = role !== "ops_pic" || own;
        if (visible) assert.equal(canEdit(me, row), serverEdit, `edit: ${where}`);
        if (visible) assert.equal(canCancel(me, row), serverCanCancel(rec, actor), `cancel: ${where}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 100);
});

test("queue actions match the workflow roles; reassign appears only once a driver exists; final rejections offer nothing", () => {
  const mk = (status: string, driver: string | null = null, by = "pic"): RowRequest => ({ id: "x", status, created_by: by, driver_id: driver, rejection_disposition: null });
  assert.deepEqual(queueActions({ id: "o", role: "fte_ops" }, mk("PENDING")), ["approve", "reject"]);
  assert.deepEqual(queueActions({ id: "m", role: "fte_mm" }, mk("REQUESTED")), ["assign-truck", "reject"]);
  assert.deepEqual(queueActions({ id: "d", role: "doc_officer" }, mk("DOCKING")), ["assign-driver"]);
  assert.deepEqual(queueActions({ id: "d", role: "doc_officer" }, mk("DOCKING", "123")), ["reassign-driver"]);
  assert.deepEqual(queueActions({ id: "pic", role: "ops_pic" }, mk("DOCKING", "123")), ["dock"]);
  assert.deepEqual(queueActions({ id: "other", role: "ops_pic" }, mk("DOCKING", "123")), [], "only the creator finalizes docking");
  assert.deepEqual(queueActions({ id: "pic", role: "ops_pic" }, mk("DOCKING")), []);
  assert.deepEqual(queueActions({ id: "o", role: "fte_ops" }, { ...mk("REJECTED"), rejection_disposition: "FINAL_NO_ROUTE" }), []);
  assert.equal(canBulkSelect({ id: "o", role: "fte_ops" }, mk("PENDING")), true);
  assert.equal(canBulkSelect({ id: "m", role: "fte_mm" }, mk("PENDING")), false);
  assert.equal(canBulkSelect({ id: "o", role: "fte_ops" }, mk("REQUESTED")), false);
  assert.equal(canPrint({ ...mk("DOCKING", "1"), plate_number: "A" }), true);
  assert.equal(canPrint({ ...mk("DOCKING"), plate_number: "A" }), false, "no label without a driver");
});

test("label template follows the number of loads; cluster text is split on commas", () => {
  assert.deepEqual(labelLoads(" A Hub , B Hub,, "), ["A Hub", "B Hub"]);
  assert.deepEqual([0, 1, 2, 3, 5].map(labelKind), ["single", "single", "coload", "triload", "triload"]);
});

test("filters and pagination: only set filters are sent; the cursor stack revisits earlier pages exactly", () => {
  assert.equal(listQuery({ status: "", search: "", dateFrom: "", dateTo: "" }, 25, null), "limit=25");
  assert.equal(listQuery({ status: "DOCKING", search: " ab 12 ", dateFrom: "2026-10-01", dateTo: "2026-10-19" }, 100, "CUR"), "limit=100&cursor=CUR&status=DOCKING&search=ab+12&date_from=2026-10-01&date_to=2026-10-19");
  let p = firstPage();
  p = nextPager(p, "c1");
  p = nextPager(p, "c2");
  assert.deepEqual([p.index, p.cursors[p.index]], [2, "c2"]);
  p = prevPager(p);
  assert.equal(p.cursors[p.index], "c1");
  p = nextPager(p, "c2b"); // going forward from a revisited page replaces the stale tail
  assert.deepEqual(p.cursors, [null, "c1", "c2b"]);
  assert.equal(nextPager(p, null), p, "no next cursor: stay put");
  assert.equal(prevPager(prevPager(prevPager(p))).index, 0);
});

test("date helpers render in the business timezone and tolerate bad input", () => {
  assert.equal(fmtDateTime("2026-10-19T10:30:00Z"), "Oct 19, 2026, 6:30 PM");
  assert.equal(fmtDateTime(null), "—");
  assert.equal(fmtDateTime("garbage"), "—");
  assert.equal(toLocalInput("2026-10-19T10:30:00Z"), "2026-10-19T18:30");
  assert.equal(toLocalInput(null), "");
});
