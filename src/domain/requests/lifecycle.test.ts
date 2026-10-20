import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approve,
  assignDriver,
  assignTruck,
  cancel,
  createRequest,
  dock,
  editRequest,
  nextActionRole,
  overrideSafeguards,
  reassignDriver,
  rejectRecord,
  type RequestDetails,
  type RequestRecord,
} from "./lifecycle.ts";
import {
  parseBulkIds,
  parseDriver,
  parseEmpty,
  parseRemarks,
  parseRequestDetails,
  parseTruck,
} from "./validation.ts";
import { isActionableForRole, type Actor, type WorkflowResult } from "./workflow.ts";
import { decodeCursor, encodeCursor, paginate, parsePageSize } from "../pagination.ts";
import { canReadAnalytics, canReadIntraday, canView, displayStatus } from "../permissions.ts";

const pic: Actor = { id: "pic1", role: "ops_pic", active: true };
const pic2: Actor = { id: "pic2", role: "ops_pic", active: true };
const ops: Actor = { id: "ops1", role: "fte_ops", active: true };
const mm: Actor = { id: "mm1", role: "fte_mm", active: true };
const doc: Actor = { id: "doc1", role: "doc_officer", active: true };
const T0 = new Date("2026-10-19T10:00:00Z");
const ctx = (n = 0, extra: Partial<{ extraRecipientIds: string[] }> = {}) => ({
  now: new Date(T0.getTime() + n * 60_000),
  correlationId: `corr-${n}`,
  ...extra,
});
const details: RequestDetails = {
  clusterId: null, cluster: "C1", region: "NCR", dockNo: "D1", backlogs: 5,
  backlogsTimestamp: null, truckSize: "4W", truckType: "WETLEASE",
};
function ok(r: WorkflowResult): RequestRecord {
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error();
  return r.request as RequestRecord;
}
const created = (actor = pic) => ok(createRequest(actor, details, { ...ctx(0), newId: "r1" }));

test("only Ops PIC / FTE Ops create; starts PENDING with creator provenance and fte_ops notification", () => {
  const r = createRequest(pic, details, ctx());
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.request.status, "PENDING");
    assert.equal(r.request.approvalStatus, "PENDING");
    assert.equal(r.request.createdBy, "pic1");
    assert.equal(r.notifications[0].recipientRole, "fte_ops");
    assert.equal(r.event.type, "REQUEST_CREATED");
  }
  for (const a of [mm, doc, { ...pic, active: false }]) {
    assert.deepEqual(createRequest(a, details, ctx()), { ok: false, code: "FORBIDDEN" });
  }
});

test("full five-stage happy path (APR-1) with audit events and notifications", () => {
  let r = created();
  r = ok(approve(r, ops, ctx(1), "SEATALK"));
  assert.equal(r.status, "REQUESTED");
  assert.equal(r.approvalStatus, "APPROVED");
  r = ok(assignTruck(r, mm, { plateNumber: "ABC123", truckSize: "6W", truckType: "DRYLEASE" }, ctx(2)));
  assert.equal(r.status, "DOCKING");
  assert.equal(r.provideTime, ctx(2).now.toISOString(), "provide_time is server time");
  assert.equal(r.truckSize, "6W");
  r = ok(assignDriver(r, doc, "12345", ctx(3)));
  assert.equal(r.status, "DOCKING", "driver assignment keeps DOCKING");
  assert.equal(r.driverId, "12345");
  r = ok(dock(r, pic, "TRIP-9", ctx(4)));
  assert.equal(r.status, "DOCKED");
  assert.equal(r.linehaulTripNo, "TRIP-9");
  assert.ok(r.dockedAt && r.linehaulTripAt);
});

test("guards: wrong role, wrong state, inactive actor", () => {
  const r = created();
  assert.deepEqual(approve(r, mm, ctx(), "WEB"), { ok: false, code: "FORBIDDEN" });
  assert.deepEqual(approve(r, { ...ops, active: false }, ctx(), "WEB"), { ok: false, code: "FORBIDDEN" });
  assert.deepEqual(assignTruck(r, mm, { plateNumber: "A", truckSize: "4W", truckType: "WETLEASE" }, ctx()), { ok: false, code: "INVALID_STATE" });
  const approved = ok(approve(r, ops, ctx(1), "WEB"));
  assert.deepEqual(approve(approved, ops, ctx(2), "WEB"), { ok: false, code: "INVALID_STATE" });
  assert.deepEqual(assignDriver(approved, doc, "1", ctx()), { ok: false, code: "INVALID_STATE" });
});

test("driver rules: assign once, reassign explicit, trip needs driver, creator only (APR-4)", () => {
  let r = created();
  r = ok(approve(r, ops, ctx(1), "WEB"));
  r = ok(assignTruck(r, mm, { plateNumber: "P1", truckSize: "4W", truckType: "WETLEASE" }, ctx(2)));
  assert.deepEqual(dock(r, pic, "T", ctx(3)), { ok: false, code: "NO_DRIVER_ASSIGNED" });
  assert.deepEqual(reassignDriver(r, doc, "9", ctx(3)), { ok: false, code: "NO_DRIVER_ASSIGNED" });
  r = ok(assignDriver(r, doc, "111", ctx(3)));
  assert.deepEqual(assignDriver(r, doc, "222", ctx(4)), { ok: false, code: "DRIVER_ALREADY_ASSIGNED" });
  const re = reassignDriver(r, doc, "222", ctx(4));
  assert.equal(re.ok && re.event.metadata?.priorDriverId, "111");
  assert.deepEqual(dock(r, pic2, "T", ctx(5)), { ok: false, code: "FORBIDDEN" }, "non-creator Ops PIC denied");
  assert.deepEqual(dock(r, ops, "T", ctx(5)), { ok: false, code: "FORBIDDEN" });
});

test("APR-3 end to end: FTE Ops-created rejection is final and not editable", () => {
  const r = created(ops);
  const rej = ok(rejectRecord(r, ops, "wrong cluster", ctx(1)));
  assert.equal(rej.rejectionDisposition, "FINAL_NO_ROUTE");
  for (const a of [ops, mm, doc, pic]) {
    const out = editRequest(rej, a, { ...details, backlogs: 1 }, ctx(2));
    assert.equal(out.ok, false);
  }
  assert.deepEqual(editRequest(rej, ops, { ...details, backlogs: 1 }, ctx(2)), { ok: false, code: "NOT_CORRECTABLE" });
  assert.equal(cancel(rej, ops, "x", ctx(2)).ok, false, "final rejection cannot be reactivated by cancel");
  assert.equal(cancel(rej, { ...ops, isAdmin: true }, "x", ctx(2)).ok, false);
});

test("Ops PIC-created rejection: only the creator corrects; resubmission starts a new cycle", () => {
  const r = created(pic);
  const rej = ok(rejectRecord(r, ops, "fix", ctx(1)));
  assert.equal(rej.rejectionDisposition, "RETURN_TO_OPS_PIC");
  assert.deepEqual(editRequest(rej, pic2, details, ctx(2)), { ok: false, code: "FORBIDDEN" });
  const fixed = editRequest(rej, pic, { ...details, backlogs: 9 }, ctx(5));
  const r2 = ok(fixed);
  assert.equal(r2.status, "PENDING");
  assert.equal(r2.approvalVersion, 2);
  assert.equal(r2.submittedAt, ctx(5).now.toISOString(), "KPI-2 latest submission reset");
  assert.equal(r2.backlogs, 9);
  assert.equal(r2.rejectionDisposition, null);
  if (fixed.ok) {
    assert.deepEqual((fixed.event.metadata as { changes: unknown }).changes, { backlogs: { before: 5, after: 9 } });
  }
});

test("FTE MM rejection returns to FTE Ops; FTE Ops can correct and resubmit", () => {
  let r = ok(approve(created(), ops, ctx(1), "WEB"));
  r = ok(rejectRecord(r, mm, "no truck", ctx(2)));
  assert.equal(r.rejectionDisposition, "RETURN_TO_FTE_OPS");
  assert.equal(isActionableForRole(r, "fte_ops"), true);
  assert.deepEqual(editRequest(r, pic, details, ctx(3)), { ok: false, code: "FORBIDDEN" });
  assert.equal(editRequest(r, ops, details, ctx(3)).ok, true);
});

test("cancellation matrix (APR-6): FTE MM needs remarks; roles by next action; terminal states", () => {
  const pending = created();
  const c1 = ok(cancel(pending, pic, null, ctx(1)));
  assert.equal(c1.status, "CANCELLED");
  assert.equal(c1.approvalStatus, "CANCELLED");
  assert.equal(cancel(pending, pic2, null, ctx(1)).ok, false, "other Ops PIC cannot cancel");
  assert.equal(cancel(pending, ops, null, ctx(1)).ok, true);
  const requested = ok(approve(pending, ops, ctx(1), "WEB"));
  assert.deepEqual(cancel(requested, mm, "  ", ctx(2)), { ok: false, code: "REMARKS_REQUIRED" });
  assert.equal(cancel(requested, mm, "no capacity", ctx(2)).ok, true);
  assert.equal(cancel(requested, ops, null, ctx(2)).ok, false, "FTE Ops not responsible at REQUESTED");
  const docking = ok(assignTruck(requested, mm, { plateNumber: "X1", truckSize: "4W", truckType: "WETLEASE" }, ctx(3)));
  assert.equal(cancel(docking, mm, "x", ctx(4)).ok, false);
  assert.equal(cancel(c1, pic, null, ctx(5)).ok, false, "cancelled is terminal");
  // cancelling a correctable rejection clears routing so the DB constraint holds
  const rej = ok(rejectRecord(pending, ops, "fix", ctx(2)));
  const c2 = ok(cancel(rej, pic, null, ctx(3)));
  assert.equal(c2.rejectionDisposition, null);
  assert.equal(c2.rejectionReturnRole, null);
});

test("post-dock edit (APR-5): creator only, status stays DOCKED, before/after audited", () => {
  let r = ok(approve(created(), ops, ctx(1), "WEB"));
  r = ok(assignTruck(r, mm, { plateNumber: "P", truckSize: "4W", truckType: "WETLEASE" }, ctx(2)));
  r = ok(assignDriver(r, doc, "5", ctx(3)));
  r = ok(dock(r, pic, "T1", ctx(4)));
  assert.deepEqual(editRequest(r, pic2, { ...details, backlogs: 1 }, ctx(5)), { ok: false, code: "FORBIDDEN" });
  assert.deepEqual(editRequest(r, pic, details, ctx(5)), { ok: false, code: "VALIDATION_FAILED" });
  const out = editRequest(r, pic, { ...details, dockNo: "D9" }, ctx(5));
  const e = ok(out);
  assert.equal(e.status, "DOCKED");
  assert.equal(out.ok && out.event.type, "DOCKED_EDITED");
  assert.deepEqual(out.ok && (out.event.metadata as { changes: unknown }).changes, { dockNo: { before: "D1", after: "D9" } });
  assert.ok(out.ok && out.notifications.length >= 3, "affected roles notified");
});

test("queue predicates incl. DOCKING; next action role", () => {
  let r = ok(approve(created(), ops, ctx(1), "WEB"));
  assert.equal(isActionableForRole(r, "fte_mm"), true);
  r = ok(assignTruck(r, mm, { plateNumber: "P", truckSize: "4W", truckType: "WETLEASE" }, ctx(2)));
  assert.equal(isActionableForRole(r, "doc_officer"), true);
  assert.equal(isActionableForRole(r, "ops_pic", "pic1"), false);
  r = ok(assignDriver(r, doc, "5", ctx(3)));
  assert.equal(isActionableForRole(r, "doc_officer"), false);
  assert.equal(isActionableForRole(r, "ops_pic", "pic1"), true);
  assert.equal(isActionableForRole(r, "ops_pic", "pic2"), false);
  assert.equal(nextActionRole(r), "ops_pic");
});

test("admin override safeguards (HUB-4): permission, identity, justification", () => {
  const admin: Actor = { ...ops, id: "adm", isAdmin: true };
  assert.deepEqual(overrideSafeguards(ops, { justification: "x", identityVerified: true, asRole: "fte_mm" }), { ok: false, code: "FORBIDDEN" });
  assert.deepEqual(overrideSafeguards(admin, { justification: "x", identityVerified: false, asRole: "fte_mm" }), { ok: false, code: "FORBIDDEN" });
  assert.deepEqual(overrideSafeguards(admin, { justification: "  ", identityVerified: true, asRole: "fte_mm" }), { ok: false, code: "JUSTIFICATION_REQUIRED" });
  const g = overrideSafeguards(admin, { justification: "outage", identityVerified: true, asRole: "fte_mm" });
  assert.equal(g.ok && g.actingAs.role, "fte_mm");
  // an override still obeys workflow validation
  const r = created();
  if (g.ok) assert.deepEqual(assignTruck(r, g.actingAs, { plateNumber: "P", truckSize: "4W", truckType: "WETLEASE" }, ctx()), { ok: false, code: "INVALID_STATE" });
});

test("validation: strict fields, formats and bounds", () => {
  const good = { cluster: "C", region: "R", dock_no: "1", backlogs: 0, truck_size: "4W", truck_type: "DRYLEASE" };
  assert.equal(parseRequestDetails(good).ok, true);
  for (const bad of [
    { ...good, backlogs: -1 }, { ...good, backlogs: 1.5 }, { ...good, backlogs: "3" },
    { ...good, truck_size: "8W" }, { ...good, cluster: "x".repeat(121) }, { ...good, dock_no: "" },
    { ...good, backlogs_timestamp: "2026-02-30" }, { ...good, created_by: "evil" }, { ...good, status: "DOCKED" },
    { ...good, cluster_id: "nope" }, null, [],
  ]) assert.equal(parseRequestDetails(bad).ok, false, JSON.stringify(bad));
  assert.equal(parseDriver({ driver_id: "12345678901" }).ok, false);
  assert.equal(parseDriver({ driver_id: "12a" }).ok, false);
  assert.equal(parseDriver({ driver_id: "0123456789" }).ok, true);
  assert.equal(parseRemarks({ rejection_remarks: "" }, "rejection_remarks", true).ok, false);
  assert.equal(parseRemarks({ rejection_remarks: "x".repeat(2001) }, "rejection_remarks", true).ok, false);
  assert.equal(parseRemarks({ rejection_remarks: "x", return_role: "ops_pic" }, "rejection_remarks", true).ok, false);
  assert.equal(parseEmpty({ a: 1 }).ok, false);
  assert.equal(parseTruck({ plate_number: "ab 12", truck_size: "4W", truck_type: "WETLEASE", provide_time: "1999" }).ok, true);
  assert.equal(parseTruck({ plate_number: "<script>", truck_size: "4W", truck_type: "WETLEASE" }).ok, false);
  const id = "11111111-1111-1111-1111-111111111111";
  const id2 = "22222222-2222-2222-2222-222222222222";
  const id3 = "33333333-3333-3333-3333-333333333333";
  assert.equal(parseBulkIds({ ids: [id] }).ok, false);
  assert.equal(parseBulkIds({ ids: [id, id2] }).ok, false);
  assert.equal(parseBulkIds({ ids: [id, id2, id3] }).ok, true);
  assert.equal(parseBulkIds({ ids: [id, id] }).ok, false);
  assert.equal(parseBulkIds({ ids: [] }).ok, false);
  assert.equal(parseBulkIds({ ids: Array.from({ length: 101 }, (_, i) => `11111111-1111-1111-1111-${String(i).padStart(12, "0")}`) }).ok, false);
});

test("pagination: only 25/50/100, opaque stable cursors, no gaps or duplicates", () => {
  assert.deepEqual(parsePageSize(null), { ok: true, value: 25 });
  assert.deepEqual(parsePageSize("100"), { ok: true, value: 100 });
  for (const bad of ["10", "101", "0", "-5", "abc", "25.5", "1000"]) assert.equal(parsePageSize(bad).ok, false, bad);
  assert.equal(decodeCursor("garbage!!").ok, false);
  assert.equal(decodeCursor(Buffer.from('["x","y"]').toString("base64url")).ok, false);
  const rows = Array.from({ length: 60 }, (_, i) => ({
    ts: new Date(T0.getTime() - Math.floor(i / 3) * 1000).toISOString(), // 3-way timestamp ties
    id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
  }));
  const seen: string[] = [];
  let cursor = null as ReturnType<typeof decodeCursor> extends infer T ? (T extends { ok: true; value: infer V } ? V : never) : never;
  for (let guard = 0; guard < 10; guard++) {
    const p = paginate(rows, 25, cursor);
    seen.push(...p.data.map((r) => r.id));
    if (!p.nextCursor) break;
    const d = decodeCursor(p.nextCursor);
    assert.ok(d.ok);
    cursor = d.ok ? d.value : null;
  }
  assert.equal(seen.length, 60);
  assert.equal(new Set(seen).size, 60, "no duplicates across pages");
  assert.equal(encodeCursor({ ts: rows[0].ts, id: rows[0].id }).includes("="), false, "opaque base64url");
});

test("permissions: creator-scoped Ops PIC, broad ops roles, analytics permission independent of role", () => {
  assert.equal(canView(pic, { createdBy: "pic1" }), true);
  assert.equal(canView(pic2, { createdBy: "pic1" }), false);
  for (const a of [ops, mm, doc]) assert.equal(canView(a, { createdBy: "pic1" }), true);
  assert.equal(canView({ ...ops, active: false }, { createdBy: "pic1" }), false);
  assert.equal(canReadIntraday(pic), true);
  assert.equal(canReadAnalytics(ops), false);
  assert.equal(canReadAnalytics({ ...doc, reportingPermission: true }), true);
  assert.equal(displayStatus("fte_mm", "DOCKING"), "ASSIGNED");
  assert.equal(displayStatus("doc_officer", "REROUTED"), "PENDING");
  assert.equal(displayStatus("ops_pic", "DOCKING"), "DOCKING");
});
