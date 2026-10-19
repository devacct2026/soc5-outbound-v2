import { test, expect } from "@playwright/test";

// Runs against `next dev` with NO v2 Supabase configuration: every protected
// endpoint must fail closed (503) rather than guess, and responses must carry
// the security headers. No database is contacted.
const ENDPOINTS: [string, string][] = [
  ["GET", "/api/v1/requests/queue"],
  ["GET", "/api/v1/requests"],
  ["POST", "/api/v1/requests"],
  ["GET", "/api/v1/kpi/summary"],
  ["GET", "/api/v1/dispatch/intraday?date=2026-10-19"],
  ["GET", "/api/v1/notifications"],
  ["GET", "/api/v1/operations/outbox/status"],
];

for (const [method, path] of ENDPOINTS) {
  test(`${method} ${path} fails closed without backend configuration`, async ({ request }) => {
    const res = await request.fetch(path, { method, data: method === "POST" ? {} : undefined, headers: { authorization: "Bearer x".padEnd(40, "x") } });
    expect(res.status()).toBe(503);
    expect(await res.json()).toEqual({ error: "BACKEND_NOT_CONFIGURED" });
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  });
}

test("SeaTalk and intraday integration endpoints are disabled by default", async ({ request }) => {
  for (const path of ["/api/v1/integrations/seatalk/approval/approve", "/api/v1/integrations/seatalk/approval/reject", "/api/v1/integrations/seatalk/events", "/api/v1/integrations/intraday/sync"]) {
    const res = await request.post(path, { data: {} });
    expect(res.status(), path).toBe(503);
  }
});

test("pages carry security headers and the API does not advertise the framework", async ({ request }) => {
  const res = await request.get("/");
  const h = res.headers();
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["referrer-policy"]).toBeTruthy();
  expect(h["x-powered-by"]).toBeUndefined();
});
