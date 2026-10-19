import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAuthCallback } from "./auth-callback.ts";

const TOKEN = "a".repeat(40);

test("tokens are read only from the URL fragment", () => {
  assert.deepEqual(parseAuthCallback(`#access_token=${TOKEN}&expires_in=3000&provider=seatalk`, "?seatalk=success"), { kind: "token", token: TOKEN, expiresIn: 3000, provider: "seatalk" });
  assert.deepEqual(parseAuthCallback(`#access_token=${TOKEN}&expires_in=nonsense`, ""), { kind: "token", token: TOKEN, expiresIn: 3600, provider: null });
  assert.equal(parseAuthCallback("", `?access_token=${TOKEN}`).kind, "none", "a token in the query string is ignored");
});

test("malformed or hostile tokens are refused", () => {
  assert.equal(parseAuthCallback("#access_token=short", "").kind, "none");
  assert.equal(parseAuthCallback(`#access_token=${"a".repeat(30)}<script>`, "").kind, "none");
});

test("pending, error reasons and provider errors map to safe messages", () => {
  assert.deepEqual(parseAuthCallback("", "?seatalk=pending"), { kind: "pending" });
  const e = parseAuthCallback("", "?seatalk=error&reason=disabled");
  assert.equal(e.kind === "error" && /disabled/.test(e.message), true);
  const unknown = parseAuthCallback("", "?seatalk=error&reason=<img src=x>");
  assert.equal(unknown.kind === "error" && !unknown.message.includes("<"), true, "unknown reasons never echo input");
  const g = parseAuthCallback("#error=access_denied&error_description=Email domain not allowed", "");
  assert.equal(g.kind === "error" && g.message.includes("Email domain not allowed"), true);
  assert.equal(parseAuthCallback("", "").kind, "none");
});
