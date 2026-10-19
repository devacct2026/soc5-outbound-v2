import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "./memory-store.ts";
import { rejectRequest } from "./service.ts";
import type { Actor, WorkflowRequest } from "../../domain/requests/workflow.ts";

const fteOps: Actor = { id: "ops1", role: "fte_ops", active: true };
const req: WorkflowRequest = {
  id: "r1",
  status: "PENDING",
  approvalStatus: "PENDING",
  createdBy: "ops9",
  creatorRole: "fte_ops",
  rejectionDisposition: null,
  rejectionReturnRole: null,
  rejectionRemarks: null,
  approvalVersion: 1,
  approvalCorrelationId: "c1",
};

test("final rejection commits request, one audit event, creator notification", async () => {
  const store = new MemoryStore([req]);
  const out = await rejectRequest(store, {
    requestId: "r1", actor: fteOps, remarks: "no", correlationId: "c2",
  });
  assert.equal(out.ok, true);
  assert.equal(store.requests.get("r1")?.rejectionDisposition, "FINAL_NO_ROUTE");
  assert.equal(store.events.length, 1);
  assert.equal([...store.notifications.values()][0].recipientUserId, "ops9");
});

test("retry with the same idempotency key does not duplicate event or notification", async () => {
  const store = new MemoryStore([req]);
  const args = { requestId: "r1", actor: fteOps, remarks: "no", correlationId: "c2", idempotencyKey: "k1" };
  await rejectRequest(store, args);
  const again = await rejectRequest(store, args);
  assert.equal(again.ok, true);
  assert.equal(store.events.length, 1);
  assert.equal(store.notifications.size, 1);
});

test("a second reject of a rejected request is an invalid-state conflict", async () => {
  const store = new MemoryStore([req]);
  await rejectRequest(store, { requestId: "r1", actor: fteOps, remarks: "no", correlationId: "c2" });
  const out = await rejectRequest(store, { requestId: "r1", actor: fteOps, remarks: "no", correlationId: "c3" });
  assert.deepEqual(out, { ok: false, code: "INVALID_STATE" });
  assert.equal(store.events.length, 1);
});

test("forbidden actor and missing request write nothing", async () => {
  const store = new MemoryStore([req]);
  const pic: Actor = { id: "p", role: "ops_pic", active: true };
  assert.deepEqual(
    await rejectRequest(store, { requestId: "r1", actor: pic, remarks: "x", correlationId: "c" }),
    { ok: false, code: "FORBIDDEN" },
  );
  assert.deepEqual(
    await rejectRequest(store, { requestId: "nope", actor: fteOps, remarks: "x", correlationId: "c" }),
    { ok: false, code: "NOT_FOUND" },
  );
  assert.equal(store.events.length, 0);
});
