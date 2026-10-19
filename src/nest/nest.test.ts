import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "./main.ts";
import { makeBackend } from "../server/backend.ts";
import { MemoryStore } from "../server/memory.ts";
import { matchRoute } from "../server/routes-table.ts";
import type { Actor } from "../domain/requests/workflow.ts";

const actors: Record<string, Actor> = {
  pic1: { id: "pic1", role: "ops_pic", active: true },
  ops1: { id: "ops1", role: "fte_ops", active: true },
};

async function boot(configured = true) {
  const store = new MemoryStore();
  const backend = makeBackend({
    store,
    authenticate: async (r) => actors[r.headers.get("authorization")?.replace("Bearer ", "") ?? ""] ?? null,
    approvalGate: { authorizeWebApproval: async () => ({ ok: true }) },
  });
  const app = await createApp(configured ? backend : null);
  await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  return { app, base, store };
}
const good = { cluster: "C1", region: "NCR", dock_no: "D1", backlogs: 4, truck_size: "4W", truck_type: "WETLEASE" };
let n = 0;
const call = (base: string, who: string | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${who}` } : {}), ...(method !== "GET" ? { "idempotency-key": `nest-key-${++n}-${Math.random()}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("route table: static segments win over params; method mismatch and unknown paths are distinguished", () => {
  assert.equal(matchRoute("GET", "requests/queue").kind, "ok");
  const queue = matchRoute("GET", "requests/queue");
  const byId = matchRoute("GET", "requests/11111111-1111-1111-1111-111111111111");
  assert.ok(queue.kind === "ok" && byId.kind === "ok" && queue.handler !== byId.handler, "queue is not bound as :id");
  assert.equal(matchRoute("DELETE", "requests").kind, "method-not-allowed");
  assert.equal(matchRoute("GET", "nope/nothing").kind, "not-found");
  const act = matchRoute("POST", "requests/abc/approve");
  assert.ok(act.kind === "ok" && act.params.id === "abc" && act.params.action === "approve");
  assert.equal(matchRoute("GET", "requests/%E0%A4%A").kind, "not-found");
});

test("NestJS API serves the full workflow over real HTTP with identical behaviour and secure headers", async () => {
  const { app, base, store } = await boot();
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const noAuth = await call(base, null, "GET", "/api/v1/requests/queue");
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.headers.get("x-content-type-options"), "nosniff");
    assert.equal(noAuth.headers.get("x-powered-by"), null);

    const created = await call(base, "pic1", "POST", "/api/v1/requests", good);
    assert.equal(created.status, 201);
    const { request } = (await created.json()) as { request: { id: string; status: string; created_by: string } };
    assert.equal(request.created_by, "pic1");

    const queue = await call(base, "ops1", "GET", "/api/v1/requests/queue?limit=25");
    assert.equal(queue.status, 200);
    assert.equal(((await queue.json()) as { data: unknown[] }).data.length, 1);
    assert.equal((await call(base, "ops1", "GET", "/api/v1/requests/queue?limit=7")).status, 422);

    const approved = await call(base, "ops1", "POST", `/api/v1/requests/${request.id}/approve`, {});
    assert.equal(approved.status, 200);
    assert.equal(((await approved.json()) as { request: { status: string } }).request.status, "REQUESTED");
    assert.equal(store.eventLog.length, 2);

    // idempotent replay over HTTP
    const key = { "idempotency-key": "nest-replay-0001" };
    const a = await call(base, "pic1", "POST", "/api/v1/requests", good, key);
    const b = await call(base, "pic1", "POST", "/api/v1/requests", good, key);
    assert.deepEqual(await a.json(), await b.json());
    assert.equal(store.requests.size, 2);

    assert.equal((await call(base, "pic1", "DELETE", "/api/v1/requests")).status, 405);
    assert.equal((await call(base, "pic1", "GET", "/api/v1/unknown")).status, 404);
    const huge = await fetch(`${base}/api/v1/requests`, { method: "POST", headers: { authorization: "Bearer pic1", "idempotency-key": "nest-huge-0001", "content-type": "application/json" }, body: "x".repeat(1_100_000) });
    assert.equal(huge.status, 413);
  } finally {
    await app.close();
  }
});

test("NestJS API fails closed (503) without a configured backend", async () => {
  const { app, base } = await boot(false);
  try {
    assert.equal((await call(base, "pic1", "GET", "/api/v1/requests")).status, 503);
  } finally {
    await app.close();
  }
});

test("NestJS serves the parity routes with the same fail-closed behaviour (auth flows, sync endpoints, presence, users)", async () => {
  const { app, base } = await boot();
  const off = await boot(false);
  try {
    // Configured backend but no sign-in services / SeaTalk / sync secrets: every optional surface is explicitly off, never open.
    for (const [method, path] of [
      ["POST", "/api/v1/auth/backroom/login"], ["POST", "/api/v1/auth/otp/request"], ["GET", "/api/v1/auth/google/start"],
      ["GET", "/api/v1/auth/seatalk/config"], ["POST", "/api/v1/access-requests"],
    ] as const) {
      assert.equal((await call(base, null, method, path, method === "POST" ? {} : undefined)).status, 503, `${method} ${path}`);
    }
    assert.equal((await call(base, null, "POST", "/api/v1/integrations/clusters/sync", [])).status, 503, "cluster sync disabled without a secret");
    assert.equal((await call(base, "ops1", "POST", "/api/v1/presence/heartbeat")).status, 503, "no approval provider configured");
    assert.equal((await call(base, "pic1", "GET", "/api/v1/users")).status, 503);
    assert.equal((await call(base, null, "GET", "/api/v1/auth/status")).status, 503);
    // Authenticated reads of the new shapes work over real HTTP.
    const n = await call(base, "ops1", "GET", "/api/v1/notifications?limit=5");
    assert.deepEqual(await n.json(), { data: [], unread: 0, has_more: false });
    assert.equal((await call(base, "ops1", "GET", "/api/v1/notifications?limit=500")).status, 422);
    assert.equal((await call(base, "pic1", "GET", "/api/v1/clusters?search=zz")).status, 422);
    for (const [method, path] of [["POST", "/api/v1/auth/backroom/login"], ["GET", "/api/v1/users"], ["POST", "/api/v1/presence/heartbeat"]] as const) {
      assert.equal((await call(off.base, "ops1", method, path, method === "POST" ? {} : undefined)).status, 503, `unconfigured ${path}`);
    }
  } finally {
    await app.close();
    await off.app.close();
  }
});
