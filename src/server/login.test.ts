import { test } from "node:test";
import assert from "node:assert/strict";
import { makeLoginHandler } from "./login.ts";
import { makeBackend } from "./backend.ts";
import { MemoryStore } from "./memory.ts";
import { createRateLimiter } from "./rate-limit.ts";

const backend = () => makeBackend({ store: new MemoryStore(), authenticate: async () => null, anonLimiter: createRateLimiter({ limit: 3, windowMs: 60_000 }) });
const req = (body: unknown) => new Request("http://t/api/v1/auth/login", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const stub = (status: number, body: unknown, seen: { url?: string; headers?: Record<string, string>; body?: string }[] = []) =>
  (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), headers: init.headers as Record<string, string>, body: String(init.body) });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

test("login proxies the password grant with the anon key and returns only the access token", async () => {
  const seen: { url?: string; headers?: Record<string, string> }[] = [];
  const h = makeLoginHandler(() => ({ url: "https://x.supabase.co", anonKey: "anon", fetchImpl: stub(200, { access_token: "tok", refresh_token: "SECRET-REFRESH", expires_in: 3600, user: { id: "u" } }, seen) }));
  const res = await h(backend(), req({ email: "a@b.co", password: "pw" }));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { access_token: "tok", expires_in: 3600 });
  assert.ok(!text.includes("SECRET-REFRESH"), "refresh token never reaches the browser");
  assert.equal(seen[0].url, "https://x.supabase.co/auth/v1/token?grant_type=password");
  assert.equal(seen[0].headers?.apikey, "anon");
});

test("login: bad credentials are 401, provider failure 503, unconfigured 503, invalid input 422, throttled 429", async () => {
  const bad = makeLoginHandler(() => ({ url: "https://x", anonKey: "a", fetchImpl: stub(400, { error: "invalid_grant" }) }));
  assert.equal((await bad(backend(), req({ email: "a@b.co", password: "x" }))).status, 401);
  const down = makeLoginHandler(() => ({ url: "https://x", anonKey: "a", fetchImpl: stub(500, {}) }));
  assert.equal((await down(backend(), req({ email: "a@b.co", password: "x" }))).status, 503);
  assert.equal((await makeLoginHandler(() => null)(backend(), req({ email: "a@b.co", password: "x" }))).status, 503);
  const ok = makeLoginHandler(() => ({ url: "https://x", anonKey: "a", fetchImpl: stub(200, { access_token: "t" }) }));
  assert.equal((await ok(backend(), req({ email: "nope", password: "x" }))).status, 422);
  assert.equal((await ok(backend(), req("{bad"))).status, 400);
  const b = backend();
  const codes: number[] = [];
  for (let i = 0; i < 4; i++) codes.push((await ok(b, req({ email: "a@b.co", password: "x" }))).status);
  assert.deepEqual(codes, [200, 200, 200, 429]);
});
