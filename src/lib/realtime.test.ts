import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffMs, startRealtime, type RealtimeStatus } from "./realtime.ts";

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({}); }
  recv(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
  /** Reply "ok" to every join sent so far. */
  ackJoins() { for (const m of this.sent.filter((x) => x.event === "phx_join")) this.recv({ topic: m.topic, event: "phx_reply", payload: { status: "ok", response: {} }, ref: m.ref }); }
}

function harness(token: () => string | null = () => "jwt-1") {
  FakeSocket.all = [];
  const timers: { fn: () => void; ms: number; id: number; live: boolean }[] = [];
  let n = 0;
  const statuses: RealtimeStatus[] = [];
  const changes: string[] = [];
  let recovered = 0;
  const h = startRealtime({
    url: "https://proj.supabase.co", anonKey: "anon", getToken: token, tables: ["requests", "notifications"],
    onChange: (t) => changes.push(t), onStatus: (s) => statuses.push(s), onRecover: () => recovered++,
    WebSocketImpl: FakeSocket as never,
    setTimer: (fn, ms) => { const t = { fn, ms, id: ++n, live: true }; timers.push(t); return t.id; },
    clearTimer: (id) => { const t = timers.find((x) => x.id === id); if (t) t.live = false; },
  });
  const fire = (ms?: number) => { const t = timers.find((x) => x.live && (ms === undefined || x.ms === ms)); if (!t) throw new Error("no timer"); t.live = false; t.fn(); };
  return { h, statuses, changes, recovered: () => recovered, fire, timers, sock: () => FakeSocket.all.at(-1)! };
}

test("connects with the anon key, joins one channel per table with the user's token, becomes connected only when all joins are acknowledged", () => {
  const t = harness();
  assert.equal(t.sock().url, "wss://proj.supabase.co/realtime/v1/websocket?apikey=anon&vsn=1.0.0");
  t.sock().open();
  const joins = t.sock().sent.filter((m) => m.event === "phx_join");
  assert.equal(joins.length, 2);
  const j = joins[0] as { topic: string; payload: { access_token: string; config: { postgres_changes: unknown[] } } };
  assert.equal(j.payload.access_token, "jwt-1");
  assert.deepEqual(j.payload.config.postgres_changes, [{ event: "*", schema: "public", table: "requests" }]);
  t.sock().recv({ topic: joins[0].topic, event: "phx_reply", payload: { status: "ok" } });
  assert.equal(t.h.status(), "connecting");
  t.sock().recv({ topic: joins[1].topic, event: "phx_reply", payload: { status: "ok" } });
  assert.equal(t.h.status(), "connected");
  assert.deepEqual(t.statuses, ["connecting", "connected"]);
  assert.equal(t.recovered(), 0, "the first subscription is not a recovery");
});

test("postgres_changes notify per table; unknown tables and malformed frames are ignored", () => {
  const t = harness();
  t.sock().open();
  t.sock().ackJoins();
  t.sock().recv({ topic: "realtime:soc5-requests", event: "postgres_changes", payload: { data: { table: "requests", type: "UPDATE" } } });
  t.sock().recv({ topic: "realtime:soc5-notifications", event: "postgres_changes", payload: { data: { table: "notifications", type: "INSERT" } } });
  t.sock().recv({ event: "postgres_changes", payload: { data: { table: "profiles" } } });
  t.sock().onmessage?.({ data: "not json" });
  assert.deepEqual(t.changes, ["requests", "notifications"]);
});

test("reconnect recovery: a dropped socket reconnects with exponential backoff and a re-subscription triggers a full refresh exactly once", () => {
  const t = harness();
  const first = t.sock();
  first.open();
  first.ackJoins();
  first.onclose?.({});
  assert.equal(t.h.status(), "disconnected");
  assert.equal(t.timers.at(-1)!.ms, 1000, "first retry after 1 s");
  t.fire(1000);
  const second = t.sock();
  assert.notEqual(second, first);
  second.open();
  second.onclose?.({}); // dropped again before joining
  assert.equal(t.timers.filter((x) => x.live).at(-1)!.ms, 2000, "backoff doubles");
  assert.equal(t.recovered(), 0, "no recovery until a subscription is re-established");
  t.fire(2000);
  const third = t.sock();
  third.open();
  third.ackJoins();
  assert.equal(t.h.status(), "connected");
  assert.equal(t.recovered(), 1, "recovered after the re-subscription");
  third.ackJoins(); // duplicate acks must not double-fire
  assert.equal(t.recovered(), 1);
  assert.deepEqual([backoffMs(0), backoffMs(1), backoffMs(5), backoffMs(20)], [1000, 2000, 30000, 30000]);
});

test("a join error or server close tears the socket down and retries", () => {
  const t = harness();
  const s = t.sock();
  s.open();
  s.recv({ topic: "realtime:soc5-requests", event: "phx_reply", payload: { status: "error" } });
  assert.equal(t.h.status(), "disconnected");
  assert.ok(s.closed);
  t.fire(1000);
  assert.notEqual(t.sock(), s);
});

test("heartbeats are sent; a missed reply means the link is dead and it reconnects", () => {
  const t = harness();
  t.sock().open();
  t.sock().ackJoins();
  t.fire(25_000);
  assert.equal(t.sock().sent.filter((m) => m.topic === "phoenix" && m.event === "heartbeat").length, 1);
  t.sock().recv({ topic: "phoenix", event: "phx_reply", payload: { status: "ok" } }); // reply received
  t.fire(25_000);
  assert.equal(t.sock().sent.filter((m) => m.event === "heartbeat").length, 2);
  const before = t.sock();
  t.fire(25_000); // no reply to the second beat
  assert.equal(t.h.status(), "disconnected");
  assert.ok(before.closed);
});

test("a refreshed token is pushed to every channel; a signed-out user stops the connection for good", () => {
  let token: string | null = "jwt-1";
  const t = harness(() => token);
  t.sock().open();
  t.sock().ackJoins();
  token = "jwt-2";
  t.fire(25_000);
  const pushes = t.sock().sent.filter((m) => m.event === "access_token");
  assert.equal(pushes.length, 2);
  assert.equal((pushes[0].payload as { access_token: string }).access_token, "jwt-2");
  t.sock().recv({ topic: "phoenix", event: "phx_reply", payload: { status: "ok" } });
  token = null;
  const s = t.sock();
  t.fire(25_000);
  assert.ok(s.closed);
  assert.equal(t.h.status(), "disconnected");
  assert.equal(t.timers.filter((x) => x.live).length, 0, "no retry timers after sign-out");
  const none = harness(() => null);
  assert.equal(FakeSocket.all.length, 0, "no token: never opens a socket");
  assert.equal(none.h.status(), "disconnected");
});

test("stop() cancels retries and closes the socket", () => {
  const t = harness();
  t.sock().open();
  const s = t.sock();
  t.h.stop();
  assert.ok(s.closed);
  assert.equal(t.timers.filter((x) => x.live).length, 0);
  s.onclose?.({});
  assert.equal(FakeSocket.all.length, 1, "no reconnect after stop");
});
