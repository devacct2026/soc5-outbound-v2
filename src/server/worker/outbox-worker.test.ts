import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffSeconds, redactError, runWorkerOnce, type ChannelHandler } from "./outbox-worker.ts";
import { MemoryOutboxPort } from "./ports.ts";
import { MemoryStore } from "../memory.ts";
import { runCommand } from "../commands.ts";
import { createRequest } from "../../domain/requests/lifecycle.ts";
import type { Actor } from "../../domain/requests/workflow.ts";

const pic: Actor = { id: "pic1", role: "ops_pic", active: true };
const details = { clusterId: null, cluster: "C", region: "R", dockNo: "1", backlogs: 1, backlogsTimestamp: null, truckSize: "4W" as const, truckType: "WETLEASE" as const };

async function seeded(features = { seatalkApproval: false, seatalkAlerts: true, googleSheets: true }) {
  const store = new MemoryStore();
  const t0 = new Date("2026-10-19T10:00:00Z");
  let clock = t0.getTime();
  store.now = () => new Date(clock);
  const id = crypto.randomUUID();
  const res = await runCommand(store, {
    actor: pic, requestId: id, creating: true, method: "POST", path: "/api/v1/requests", idempotencyKey: "worker-key-1", payload: {},
    authorize: () => true,
    decide: () => createRequest(pic, details, { now: t0, correlationId: "c1", newId: id }),
    features,
  });
  assert.equal(res.status, 200);
  return { store, advance: (s: number) => (clock += s * 1000), now: () => new Date(clock) };
}

test("backoff is exponential and capped", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map((a) => backoffSeconds(a, 30, 3600)), [30, 60, 120, 240, 480, 960, 3600]);
  assert.equal(backoffSeconds(100, 30, 3600), 3600);
  assert.equal(backoffSeconds(0, 30, 3600), 30);
});

test("commands enqueue outbox intents only for enabled channels; duplicates are ignored", async () => {
  const on = await seeded();
  assert.deepEqual(on.store.outbox.map((o) => o.channel).sort(), ["GOOGLE_SHEETS", "SEATALK_ALERT"]);
  const off = await seeded({ seatalkApproval: false, seatalkAlerts: false, googleSheets: false });
  assert.equal(off.store.outbox.length, 0, "disabled providers produce no work");
  assert.equal(off.store.notificationLog.length, 1, "in-app notification still persisted");
});

test("success: row completed and provider acknowledgment tracked separately", async () => {
  const s = await seeded();
  const calls: string[] = [];
  const handler: ChannelHandler = async (row) => { calls.push(row.channel); return { acknowledged: true }; };
  const out = await runWorkerOnce({ port: new MemoryOutboxPort(s.store), handlers: { SEATALK_ALERT: handler }, now: s.now() });
  assert.equal(out.completed, 1);
  assert.deepEqual(calls, ["SEATALK_ALERT"]);
  const sheets = s.store.outbox.find((o) => o.channel === "GOOGLE_SHEETS")!;
  assert.equal(sheets.status, "PENDING", "channel without a handler is untouched");
  assert.equal(sheets.attempts, 0);
});

test("failure: retry with exponential backoff, then dead-letter at max attempts, with alert", async () => {
  const s = await seeded();
  const port = new MemoryOutboxPort(s.store, 3);
  const alerts: string[] = [];
  const failing: ChannelHandler = async () => { throw new Error("provider down: Bearer abcdefghijklmnop12345"); };
  const tick = () => runWorkerOnce({ port, handlers: { SEATALK_ALERT: failing }, now: s.now(), config: { baseSeconds: 30, maxSeconds: 3600 }, onAlert: (m) => alerts.push(m) });

  let r = await tick();
  assert.equal(r.retried, 1);
  const row = s.store.outbox.find((o) => o.channel === "SEATALK_ALERT")!;
  assert.equal(row.status, "PENDING");
  assert.equal(row.attempts, 1);
  assert.ok(!/abcdefghijklmnop12345/.test(row.lastError ?? ""), "secrets redacted from persisted errors");
  // not due yet: no attempt
  s.advance(10);
  r = await tick();
  assert.equal(r.claimed, 0);
  // due after 30s (attempt 1 backoff), second failure waits 60s
  s.advance(30);
  r = await tick();
  assert.equal(r.retried, 1);
  assert.equal(row.attempts, 2);
  assert.equal(row.availableAt - s.now().getTime(), 60_000);
  s.advance(60);
  r = await tick();
  assert.equal(r.deadLettered, 1);
  assert.equal(row.status, "DEAD_LETTER");
  assert.ok(alerts.some((a) => a.includes("dead-letter")), "operator alert raised");
  // dead letters are never auto-claimed again
  s.advance(100_000);
  r = await tick();
  assert.equal(r.claimed, 0);
});

test("recovery: a stale PROCESSING row (crashed worker) is reclaimed; no duplicate completion", async () => {
  const s = await seeded();
  const port = new MemoryOutboxPort(s.store);
  const row = s.store.outbox.find((o) => o.channel === "SEATALK_ALERT")!;
  const rows = await port.claim(["SEATALK_ALERT"], 10, 300); // worker A claims then crashes
  assert.equal(rows.length, 1);
  assert.equal((await port.claim(["SEATALK_ALERT"], 10, 300)).length, 0, "locked rows are not double-claimed");
  s.advance(301);
  let done = 0;
  const out = await runWorkerOnce({ port, handlers: { SEATALK_ALERT: async () => { done++; return { acknowledged: false }; } }, now: s.now() });
  assert.equal(out.completed, 1);
  assert.equal(done, 1);
  assert.equal(row.status, "COMPLETED");
  assert.equal(row.attempts, 2);
});

test("lag alert when due work is stuck (no channel handlers => nothing drains)", async () => {
  const s = await seeded();
  s.advance(2000);
  const out = await runWorkerOnce({ port: new MemoryOutboxPort(s.store), handlers: {}, now: s.now(), config: { lagAlertSeconds: 900 } });
  assert.ok(out.alerts.some((a) => a.includes("oldest due")));
});

test("redactError strips tokens, jwts and truncates", () => {
  assert.ok(!redactError(new Error("authorization: Bearer secretsecretsecret")).includes("secretsecretsecret"));
  assert.ok(!redactError("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc").includes("eyJhbGci"));
  assert.ok(redactError("x".repeat(2000)).length <= 500);
});

test("lock ownership: a slow worker whose claim was reclaimed cannot overwrite the new owner's outcome", async () => {
  const s = await seeded();
  const port = new MemoryOutboxPort(s.store);
  const [slow] = await port.claim(["SEATALK_ALERT"], 10, 300); // worker A claims (attempt 1)
  s.advance(301);
  const [fast] = await port.claim(["SEATALK_ALERT"], 10, 300); // lock timed out: worker B reclaims (attempt 2)
  assert.equal(fast.attempts, 2);
  await port.complete(fast.id, fast.attempts, true);
  await port.deadLetter(slow.id, slow.attempts, "late failure from the original worker");
  await port.retryLater(slow.id, slow.attempts, new Date(), "stale");
  const row = s.store.outbox.find((o) => o.id === fast.id)!;
  assert.equal(row.status, "COMPLETED", "stale updates are no-ops");
  assert.equal(row.lastError, null);
});
