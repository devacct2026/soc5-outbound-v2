import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateRows, intradaySyncHandler } from "./intraday-sync.ts";
import { makeBackend } from "./backend.ts";
import { MemoryStore } from "./memory.ts";
import { signSync } from "./seatalk/contract.ts";

const SECRET = "intraday-sync-secret";
const NOW = new Date("2026-10-19T10:00:00Z");

function setup() {
  const store = new MemoryStore();
  store.now = () => NOW;
  const backend = makeBackend({ store, now: () => NOW, intradaySecret: SECRET, authenticate: async () => null });
  return { store, backend };
}

function syncRequest(body: unknown, over: { secret?: string; timestamp?: string; source?: string } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const timestamp = over.timestamp ?? String(Math.floor(NOW.getTime() / 1000));
  return new Request("http://t/api/v1/integrations/intraday/sync", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sync-source": over.source ?? "google-apps-script",
      "x-sync-timestamp": timestamp,
      "x-sync-signature": signSync(over.secret ?? SECRET, timestamp, raw),
    },
    body: raw,
  });
}

test("intraday sync preserves source aliases, status filtering, comma quantities, duplicate aggregation and boundaries", async () => {
  const { backend, store } = setup();
  const rows = [
    { status_desc: "SOC_LHTransporting", c_date_6am: "2026-10-19", process_hours: "0", pkg_vol: "1,200" },
    { dispatch_date: "2026-10-19", hour: 0, order_qty: "3" },
    { date: "2026-10-19", hour: "23", orderQty: 4 },
    { status_desc: "COMPLETE", date: "2026-10-19", hour: 1, order_qty: 99 },
    { date: "not-a-date", hour: 25, order_qty: -1 },
  ];
  const response = await intradaySyncHandler(backend, syncRequest({ data: rows }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, received: 5, processed: 2, rejected: 1 });
  assert.deepEqual(store.dispatch.get("2026-10-19")?.sort((a, b) => a.hour - b.hour).map((r) => [r.hour, r.orderQty]), [[0, 1203], [23, 4]]);

  const repeated = await intradaySyncHandler(backend, syncRequest({ rows: [{ date: "2026-10-19", hour: 0, order_qty: 1203 }] }));
  assert.equal(repeated.status, 200);
  assert.equal(store.dispatch.get("2026-10-19")?.find((r) => r.hour === 0)?.orderQty, 1203, "repeated import upserts instead of accumulating");

  const singleton = await intradaySyncHandler(backend, syncRequest({ date: "2026-10-20", hour: 23, order_qty: "5" }));
  assert.equal(singleton.status, 200);
  assert.equal(store.dispatch.get("2026-10-20")?.find((r) => r.hour === 23)?.orderQty, 5);
});

test("intraday sync rejects invalid authentication, stale requests, malformed input and database failures safely", async () => {
  const { backend } = setup();
  assert.equal((await intradaySyncHandler(backend, syncRequest([], { secret: "wrong" }))).status, 401);
  const missingSignature = new Request("http://t/api/v1/integrations/intraday/sync", { method: "POST", headers: { "x-sync-source": "google-apps-script" }, body: "[]" });
  assert.equal((await intradaySyncHandler(backend, missingSignature)).status, 401);
  assert.equal((await intradaySyncHandler(backend, syncRequest([], { timestamp: String(Math.floor(NOW.getTime() / 1000) - 301) }))).status, 401);
  assert.equal((await intradaySyncHandler(backend, syncRequest("{bad"))).status, 400);
  const invalid = await intradaySyncHandler(backend, syncRequest({ rows: [{ dispatch_date: "2026-02-30", hour: 24, order_qty: -1 }] }));
  assert.equal(invalid.status, 422);

  const failing = setup();
  failing.store.upsertIntraday = async () => { throw new Error("database unavailable"); };
  const response = await intradaySyncHandler(failing.backend, syncRequest([{ date: "2026-10-19", hour: 1, order_qty: 2 }]));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "Unable to persist intraday dispatch data." });
});

test("intraday pure aggregation retains valid date/hour semantics and separates skipped rows", () => {
  const result = aggregateRows([
    { date: "2026-10-19", hour: 0, order_qty: "2" },
    { date: "2026-10-19", hour: 0, order_qty: "3" },
    { status_desc: "OTHER", date: "2026-10-19", hour: 0, order_qty: 99 },
    { date: "2026-10-19", hour: 24, order_qty: 1 },
  ]);
  assert.deepEqual(result, { rows: [{ date: "2026-10-19", hour: 0, orderQty: 5 }], rejected: 1, skipped: 1 });
});
