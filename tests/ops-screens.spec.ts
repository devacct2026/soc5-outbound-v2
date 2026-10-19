import { test, expect, type Page } from "@playwright/test";

// Browser-level checks for the new screens. The API (and the realtime socket) are mocked at the network layer; the
// server-side rules themselves are covered by the unit/Nest/DB suites.
const ID = (n: number) => `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;
const base = (n: number, extra: Record<string, unknown> = {}) => ({
  id: ID(n), request_timestamp: "2026-10-19T10:00:00Z", cluster: `Cluster ${n}`, cluster_id: null, region: "NCR", dock_no: String(n), backlogs: 12,
  backlogs_timestamp: "2026-10-19T08:30:15.000Z", truck_size: "6W", truck_type: "WETLEASE", created_by: "me-1", status: "PENDING", display_status: "PENDING",
  approval_status: "PENDING", plate_number: null, driver_id: null, rejection_disposition: null, rejection_remarks: null, cancellation_remarks: null,
  linehaul_trip_no: null, docked_at: null, provide_time: null, next_action_role: "fte_ops", ...extra,
});

// Route priority is LAST-registered-first, so the safety net and defaults live in beforeEach (lowest priority) and
// every test's own mocks, registered later, win.
test.beforeEach(async ({ page }) => {
  // Any API call a test forgot to mock fails loudly here and never reaches a server.
  await page.route("**/api/v1/**", (r) => r.fulfill({ status: 599, json: { error: "UNMOCKED_IN_TEST", url: r.request().url() } }));
  await page.route("**/api/v1/requests?*", (r) => r.fulfill({ json: { data: [], has_more: false, next_cursor: null, limit: 25 } }));
  await page.route("**/api/v1/requests/metrics", (r) => r.fulfill({ json: { total: 0, awaiting_action: 0, by_status: {} } }));
  await page.route("**/api/v1/dispatch/intraday?*", (r) => r.fulfill({ json: { data: [] } }));
  await page.route("**/api/v1/notifications*", (r) => r.fulfill({ json: { data: [], unread: 0, has_more: false } }));
});

async function signedIn(page: Page, role: string, opts: { reporting?: boolean; must?: boolean; admin?: boolean } = {}) {
  await page.route("**/api/v1/auth/login", (r) => r.fulfill({ json: { access_token: "x".repeat(40), expires_in: 3600 } }));
  await page.route("**/api/v1/auth/status", (r) => r.fulfill({ json: { account_status: "ACTIVE", role, must_change_password: !!opts.must } }));
  await page.route("**/api/v1/auth/me", (r) => r.fulfill({ json: { id: "me-1", role, is_admin: !!opts.admin, reporting_permission: !!opts.reporting, must_change_password: !!opts.must } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Connect live data" }).click();
  await page.getByPlaceholder("Email").fill("u@example.com");
  await page.getByPlaceholder("Password").fill("not-a-real-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Connected to live API")).toBeVisible();
}
const go = async (page: Page, name: RegExp) => {
  await page.getByRole("link", { name }).first().click();
  await page.waitForURL((u) => u.pathname !== "/"); // the dashboard also hosts the account banners: wait until the module page replaced it
};

test("Requests: page-size choice, cursor pagination and server-side filters reach every request", async ({ page }) => {
  const urls: string[] = [];
  await page.route("**/api/v1/requests?*", (r) => {
    const u = new URL(r.request().url());
    urls.push(u.search);
    const cur = u.searchParams.get("cursor");
    if (u.searchParams.get("limit") === "100") return r.fulfill({ json: { data: [base(9)], has_more: false, next_cursor: null, limit: 100 } });
    if (!cur) return r.fulfill({ json: { data: [base(1)], has_more: true, next_cursor: "CUR2", limit: 25 } });
    return r.fulfill({ json: { data: [base(2)], has_more: false, next_cursor: null, limit: 25 } });
  });
  await signedIn(page, "fte_ops");
  await go(page, /^Requests/);
  await expect(page.getByText("REQ-00000001")).toBeVisible();
  await expect(page.getByLabel("Rows per page").locator("option")).toHaveText(["25", "50", "100"]);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("REQ-00000002")).toBeVisible();
  expect(urls.at(-1)).toContain("cursor=CUR2");
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page.getByText("REQ-00000001")).toBeVisible();
  await page.getByLabel("Rows per page").selectOption("100");
  await expect(page.getByText("REQ-00000009").first()).toBeVisible();
  expect(urls.at(-1)).toContain("limit=100");
  expect(urls.at(-1)).not.toContain("cursor");
  const filterForm = page.getByRole("form", { name: "Filter requests" });
  await filterForm.getByLabel("Status").selectOption("DOCKING");
  await filterForm.getByLabel("Plate number").fill("ABC 123");
  await filterForm.getByRole("button", { name: "Apply" }).click();
  await expect.poll(() => urls.at(-1)).toContain("status=DOCKING");
  expect(urls.at(-1)).toContain("search=ABC+123");
  // full backlog date/time is displayed, not just the date
  await expect(page.getByRole("cell", { name: /Oct 19, 2026, 4:30 PM/ }).first()).toBeVisible();
});

test("Request creation: directory pick fills region/dock/backlog with its time; submit sends an idempotency key and the full timestamp", async ({ page }) => {
  let posted: { key: string; body: Record<string, unknown> } | null = null;
  await page.route("**/api/v1/clusters?*", (r) => r.fulfill({ json: { data: [{ id: ID(77), cluster_name: "Alpha Hub", hub_name: "Alpha Hub", region: "Metro", dock_number: "7", backlogs: 40, backlogs_ts: "2026-10-19T08:30:15.000Z" }] } }));
  await page.route("**/api/v1/requests?*", (r) => r.fulfill({ json: { data: [], has_more: false, next_cursor: null, limit: 25 } }));
  await page.route("**/api/v1/requests", (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    posted = { key: r.request().headers()["idempotency-key"], body: r.request().postDataJSON() };
    return r.fulfill({ status: 201, json: { request: base(5) } });
  });
  await signedIn(page, "ops_pic");
  await go(page, /^Requests/);
  await page.getByRole("button", { name: "New request" }).click();
  await page.getByPlaceholder(/Search registered clusters/).fill("alp");
  await page.getByRole("button", { name: /Alpha Hub · Dock 7/ }).click();
  await expect(page.getByLabel("Region")).toHaveValue("Metro");
  await expect(page.getByLabel("Dock #")).toHaveValue("7");
  await expect(page.getByLabel("Backlog", { exact: true })).toHaveValue("40");
  await expect(page.getByText("Oct 19, 2026, 4:30 PM")).toBeVisible();
  await page.getByLabel("LH size").selectOption("10W");
  await page.getByRole("button", { name: "Create request" }).click();
  await expect(page.getByText("Request created and sent for approval.")).toBeVisible();
  expect(posted!.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(posted!.body).toEqual({ cluster: "Alpha Hub", cluster_id: ID(77), region: "Metro", dock_no: "7", backlogs: 40, backlogs_timestamp: "2026-10-19T08:30:15.000Z", truck_size: "10W", truck_type: "WETLEASE" });
});

test("Rejected request: the creator can correct and resubmit (backlog time preserved); a final FTE Ops rejection offers no edit or cancel", async ({ page }) => {
  let put: Record<string, unknown> | null = null;
  const rows = [
    base(1, { status: "REJECTED", display_status: "REJECTED", approval_status: "REJECTED", rejection_disposition: "RETURN_TO_OPS_PIC", rejection_remarks: "wrong dock", next_action_role: "ops_pic" }),
    base(2, { status: "REJECTED", display_status: "REJECTED", approval_status: "REJECTED", rejection_disposition: "FINAL_NO_ROUTE", rejection_remarks: "duplicate", next_action_role: null }),
    base(3, { status: "DOCKED", display_status: "DOCKED", approval_status: "APPROVED", plate_number: "ABC 123", driver_id: "55", linehaul_trip_no: "LT-1", docked_at: "2026-10-19T11:00:00Z" }),
  ];
  await page.route("**/api/v1/requests?*", (r) => r.fulfill({ json: { data: rows, has_more: false, next_cursor: null, limit: 25 } }));
  await page.route("**/api/v1/requests/*", (r) => {
    if (r.request().method() !== "PUT") return r.fallback();
    put = r.request().postDataJSON();
    return r.fulfill({ json: { request: rows[0] } });
  });
  await signedIn(page, "ops_pic");
  await go(page, /^Requests/);
  const r1 = page.getByRole("row", { name: /REQ-00000001/ });
  const r2 = page.getByRole("row", { name: /REQ-00000002/ });
  const r3 = page.getByRole("row", { name: /REQ-00000003/ });
  await expect(r2.getByRole("button", { name: /Correct|Edit|Cancel/ })).toHaveCount(0);
  await expect(r2.getByText("final")).toBeVisible();
  await expect(r3.getByRole("button", { name: "Edit after docking" })).toBeVisible();
  await expect(r3.getByRole("button", { name: "Print label" })).toBeVisible();
  await expect(r1.getByRole("button", { name: "Cancel" })).toBeVisible();
  await r1.getByRole("button", { name: "Correct & resubmit" }).click();
  await page.getByLabel("Dock #").fill("99");
  await page.getByRole("button", { name: "Resubmit", exact: true }).click();
  await expect(page.getByText("Request corrected and resubmitted for approval.")).toBeVisible();
  expect(put).toMatchObject({ dock_no: "99", backlogs_timestamp: "2026-10-19T08:30:15.000Z" });
});

test("Cancellation: FTE MM must give remarks; the dialog sends them with an idempotency key", async ({ page }) => {
  let sent: { body: unknown; key: string } | null = null;
  await page.route("**/api/v1/requests?*", (r) => r.fulfill({ json: { data: [base(4, { status: "REQUESTED", display_status: "REQUESTED", approval_status: "APPROVED", next_action_role: "fte_mm" })], has_more: false, next_cursor: null, limit: 25 } }));
  await page.route("**/api/v1/requests/*/cancel", (r) => { sent = { body: r.request().postDataJSON(), key: r.request().headers()["idempotency-key"] }; return r.fulfill({ json: { request: base(4) } }); });
  await signedIn(page, "fte_mm");
  await go(page, /^Requests/);
  await page.getByRole("button", { name: "Cancel" }).first().click();
  await expect(page.getByLabel("Remarks (required)")).toBeVisible();
  await page.getByLabel("Remarks (required)").fill("no truck available");
  await page.getByRole("button", { name: "Confirm cancellation" }).click();
  await expect(page.getByText("REQ-00000004 cancelled.")).toBeVisible();
  expect(sent!.body).toEqual({ cancellation_remarks: "no truck available" });
  expect(sent!.key).toMatch(/^[0-9a-f-]{36}$/);
});

test("FTE Ops bulk approval sends all selected ids once and reports per-request failures", async ({ page }) => {
  let sent: unknown = null;
  await page.route("**/api/v1/requests?*", (r) => r.fulfill({ json: { data: [base(1), base(2), base(3)], has_more: false, next_cursor: null, limit: 25 } }));
  await page.route("**/api/v1/requests/bulk-approve", (r) => { sent = r.request().postDataJSON(); return r.fulfill({ json: { data: [base(1), base(2)], failed: [{ id: ID(3), error: "NOT_APPROVED_IN_SEATALK" }] } }); });
  await signedIn(page, "fte_ops");
  await go(page, /^Requests/);
  await page.getByLabel("Select all approvable on this page").check();
  await page.getByRole("button", { name: /Apply SeaTalk approval to selected \(3\)/ }).click();
  await expect(page.getByText(/2 approved; not approved — REQ-00000003: Approve this request in SeaTalk Approval Center first/)).toBeVisible();
  expect(sent).toEqual({ ids: [ID(1), ID(2), ID(3)] });
});

test("Docking: Doc Officer assigns, then explicitly reassigns a driver; the print label opens with the driver ID", async ({ page }) => {
  const calls: string[] = [];
  let withDriver = false;
  const row = () => ({ ...base(6, { status: "DOCKING", display_status: "DOCKING", approval_status: "APPROVED", plate_number: "ABC 123", driver_id: withDriver ? "555" : null, next_action_role: "doc_officer" }) });
  await page.route("**/api/v1/requests/queue*", (r) => r.fulfill({ json: { data: [row()], has_more: false, next_cursor: null, limit: 25 } }));
  await page.route("**/api/v1/requests?*", (r) => r.fulfill({ json: { data: [], has_more: false, next_cursor: null, limit: 25 } }));
  await page.route("**/api/v1/requests/*/assign-driver", (r) => { calls.push(`assign ${JSON.stringify(r.request().postDataJSON())}`); withDriver = true; return r.fulfill({ json: { request: row() } }); });
  await page.route("**/api/v1/requests/*/reassign-driver", (r) => { calls.push(`reassign ${JSON.stringify(r.request().postDataJSON())}`); return r.fulfill({ json: { request: row() } }); });
  await signedIn(page, "doc_officer");
  await go(page, /^Docking/);
  await page.getByRole("button", { name: "Assign driver" }).click();
  await page.getByPlaceholder("Driver ID (1-10 digits)").fill("555");
  await page.getByRole("button", { name: /Confirm assign driver/i }).click();
  await expect(page.getByRole("dialog", { name: "Printable truck label" })).toBeVisible();
  await expect(page.locator('[data-label-field="driver"]')).toHaveText("555");
  await expect(page.locator('[data-label-field="plate"]')).toHaveText("ABC 123");
  await expect(page.getByRole("button", { name: "Print", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Reassign driver" }).click();
  await expect(page.getByPlaceholder("Driver ID (1-10 digits)")).toHaveValue("555");
  await page.getByPlaceholder("Driver ID (1-10 digits)").fill("777");
  await page.getByRole("button", { name: /Confirm reassign driver/i }).click();
  await expect(page.getByText("Reassign driver completed.")).toBeVisible();
  expect(calls).toEqual(['assign {"driver_id":"555"}', 'reassign {"driver_id":"777"}']);
});

test("Queue pagination: page size and the next page are fetched from the server", async ({ page }) => {
  const seen: string[] = [];
  await page.route("**/api/v1/requests/queue*", (r) => {
    const u = new URL(r.request().url());
    seen.push(u.search);
    return r.fulfill({ json: u.searchParams.get("cursor") ? { data: [base(2, { status: "REQUESTED", display_status: "REQUESTED" })], has_more: false, next_cursor: null, limit: 25 } : { data: [base(1, { status: "REQUESTED", display_status: "REQUESTED" })], has_more: true, next_cursor: "Q2", limit: 25 } });
  });
  await page.route("**/api/v1/requests?*", (r) => r.fulfill({ json: { data: [], has_more: false, next_cursor: null, limit: 25 } }));
  await signedIn(page, "fte_mm");
  await go(page, /^Queue/);
  await expect(page.getByText("REQ-00000001")).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("REQ-00000002")).toBeVisible();
  expect(seen.at(-1)).toContain("cursor=Q2");
  await page.getByLabel("Rows per page").selectOption("50");
  await expect.poll(() => seen.at(-1)).toContain("limit=50");
});

test("Notifications: real list, unread badge from the server, mark one and mark all read", async ({ page }) => {
  let unread = 2;
  const items = [
    { id: ID(1), event_type: "REQUEST_APPROVED", title: "Request approved", body: "REQ-1 is now REQUESTED.", request_id: ID(1), created_at: "2026-10-19T10:00:00Z", read: false },
    { id: ID(2), event_type: "REQUEST_CREATED", title: "New request awaiting approval", body: "", request_id: ID(2), created_at: "2026-10-19T09:00:00Z", read: false },
  ];
  const marked: string[] = [];
  await page.route("**/api/v1/notifications**", (r) => {
    const m = r.request().method();
    if (m === "PATCH") {
      marked.push(new URL(r.request().url()).pathname.split("/api/v1")[1]);
      if (r.request().url().endsWith("read-all")) { items.forEach((i) => (i.read = true)); unread = 0; } else { items[0].read = true; unread = 1; }
      return r.fulfill({ json: { ok: true } });
    }
    return r.fulfill({ json: { data: items, unread, has_more: false } });
  });
  await signedIn(page, "fte_mm");
  await expect(page.getByLabel(/Notifications, 2 unread/)).toBeVisible();
  await go(page, /^Notifications/);
  await expect(page.getByText("2 unread")).toBeVisible();
  await page.getByRole("button", { name: "Mark as read" }).first().click();
  await expect(page.getByText("1 unread")).toBeVisible();
  await page.getByRole("button", { name: "Mark all as read" }).click();
  await expect(page.getByText("0 unread")).toBeVisible();
  expect(marked).toEqual([`/notifications/${ID(1)}/read`, "/notifications/read-all"]);
});

test("Reports: reporting permission required; with it, summary, daily trend, hourly bars and an authorized CSV export", async ({ page }) => {
  await signedIn(page, "doc_officer");
  await go(page, /^Reports/);
  await expect(page.getByText(/need the reporting permission/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Export CSV" })).toHaveCount(0);
});

test("Reports with permission: KPI definitions render and CSV download carries the bearer token", async ({ page }) => {
  let exportAuth = "";
  await page.route("**/api/v1/kpi/summary*", (r) => r.fulfill({ json: { total: 10, confirmed: 6, cancelled: 1, averageApprovalMinutes: 12.5, averageWaitingMinutes: 30, averageDwellMinutes: 95.25 } }));
  await page.route("**/api/v1/kpi/daily*", (r) => r.fulfill({ json: { data: [{ date: "2026-10-18", total: 4, confirmed: 2 }, { date: "2026-10-19", total: 6, confirmed: 4 }] } }));
  await page.route("**/api/v1/kpi/hourly*", (r) => r.fulfill({ json: { date: "2026-10-19", shiftStart: "18:00", timezone: "Asia/Manila", bins: Array.from({ length: 13 }, (_, i) => ({ index: i, startsAt: new Date(Date.UTC(2026, 9, 19, 10 + i)).toISOString(), count: i })) } }));
  await page.route("**/api/v1/kpi/export*", (r) => { exportAuth = r.request().headers()["authorization"] ?? ""; return r.fulfill({ status: 200, headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="requests_x.csv"' }, body: "id\n1\n" }); });
  await signedIn(page, "doc_officer", { reporting: true });
  await go(page, /^Reports/);
  await expect(page.getByText("Docked (confirmed)")).toBeVisible();
  await expect(page.getByRole("heading", { name: "KPI reports" })).toBeVisible();
  await expect(page.getByText("95.3 min")).toBeVisible();
  await expect(page.getByRole("cell", { name: "2026-10-19" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  expect((await download).suggestedFilename()).toBe("requests_x.csv");
  expect(exportAuth).toMatch(/^Bearer x+$/);
});

test("Intraday dispatch is available to operational roles with live hourly data", async ({ page }) => {
  await signedIn(page, "doc_officer");
  await page.route("**/api/v1/dispatch/intraday?*", (r) => r.fulfill({ json: { data: Array.from({ length: 24 }, (_, h) => ({ hour: h, orderQty: h === 20 ? 80 : h === 6 ? 10 : 0, syncedAt: "2026-10-19T12:00:00Z" })) } }));
  await go(page, /^Intraday KPI/);
  await expect(page.locator(".ops-summary")).toContainText("90 orders");
  await expect(page.locator(".ops-summary")).toContainText("peak 8 PM");
});

test("Forced password change: the form blocks use until a 12+ character matching password is saved", async ({ page }) => {
  let sent: unknown = null;
  await page.route("**/api/v1/auth/password-changed", (r) => { sent = r.request().postDataJSON(); return r.fulfill({ json: { ok: true } }); });
  await signedIn(page, "ops_pic", { must: true });
  await go(page, /^Requests/);
  // Role queries skip the dashboard copy that Next keeps mounted (hidden) after navigation.
  const form = page.getByRole("form", { name: "Change password" });
  await expect(form.getByRole("heading", { name: "Change your password" })).toBeVisible();
  await form.getByLabel("New password", { exact: true }).fill("short-one");
  await form.getByLabel("Confirm new password").fill("short-one");
  await form.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "at least 12" })).toBeVisible();
  await form.getByLabel("New password", { exact: true }).fill("a-much-longer-passphrase");
  await form.getByLabel("Confirm new password").fill("a-different-passphrase");
  await form.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Passwords do not match.")).toBeVisible();
  await form.getByLabel("Confirm new password").fill("a-much-longer-passphrase");
  await form.getByRole("button", { name: "Change password" }).click();
  await expect.poll(() => sent).toEqual({ password: "a-much-longer-passphrase" });
});

test("Pending-approval accounts see a clear message and no operational data", async ({ page }) => {
  await page.route("**/api/v1/auth/login", (r) => r.fulfill({ json: { access_token: "x".repeat(40), expires_in: 3600 } }));
  await page.route("**/api/v1/auth/status", (r) => r.fulfill({ json: { account_status: "PENDING_APPROVAL", role: null, must_change_password: false } }));
  await page.route("**/api/v1/requests*", (r) => r.fulfill({ status: 401, json: { error: "UNAUTHENTICATED" } }));
  await page.goto("/requests");
  await page.evaluate(() => window.sessionStorage.setItem("soc5-access-token", JSON.stringify({ token: "x".repeat(40), exp: Date.now() + 3_600_000 })));
  await page.goto("/requests");
  await expect(page.getByText(/awaiting administrator approval/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "New request" })).toHaveCount(0);
});

test("Sign-in methods: Ops ID, email code and SeaTalk/Google options; Ops ID shows the forced-change flow", async ({ page }) => {
  let ops: unknown = null;
  await page.route("**/api/v1/auth/backroom/login", (r) => { ops = r.request().postDataJSON(); return r.fulfill({ json: { access_token: "y".repeat(40), expires_in: 3600, must_change_password: true } }); });
  await page.route("**/api/v1/auth/otp/request", (r) => r.fulfill({ json: { ok: true } }));
  await page.route("**/api/v1/auth/otp/verify", (r) => r.fulfill({ json: { access_token: "z".repeat(40), expires_in: 3600 } }));
  await page.route("**/api/v1/auth/seatalk/config", (r) => r.fulfill({ status: 503, json: { error: "SEATALK_LOGIN_DISABLED" } }));
  await page.route("**/api/v1/auth/status", (r) => r.fulfill({ json: { account_status: "ACTIVE", role: "ops_pic", must_change_password: true } }));
  await page.route("**/api/v1/auth/me", (r) => r.fulfill({ json: { id: "me-1", role: "ops_pic", is_admin: false, reporting_permission: false, must_change_password: true } }));
  await page.route("**/api/v1/requests*", (r) => r.fulfill({ json: { data: [], has_more: false, next_cursor: null, limit: 25, total: 0, awaiting_action: 0, by_status: {} } }));
  await page.route("**/api/v1/dispatch/intraday?*", (r) => r.fulfill({ json: { data: [] } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Connect live data" }).click();
  await page.getByRole("tab", { name: "SeaTalk" }).click();
  await expect(page.getByText("Login with SeaTalk is not configured.")).toBeVisible();
  await page.getByRole("tab", { name: "Google" }).click();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await page.getByRole("tab", { name: "Email code" }).click();
  await page.getByPlaceholder("Work email").fill("new@spxexpress.com");
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByPlaceholder("6-digit code")).toBeVisible();
  await page.getByRole("tab", { name: "Ops ID" }).click();
  await page.getByPlaceholder("Ops ID (ops12345)").fill("ops100");
  await page.getByPlaceholder("Password").fill("initial-password-1");
  await page.getByRole("button", { name: "Sign in with Ops ID" }).click();
  await expect(page.getByText("Connected to live API")).toBeVisible();
  expect(ops).toEqual({ ops_id: "ops100", password: "initial-password-1" });
  await expect(page.getByRole("heading", { name: "Change your password" })).toBeVisible();
});

test("OAuth/SeaTalk return page stores the fragment token, clears the address bar and signs in", async ({ page }) => {
  await page.goto(`/auth/callback#access_token=${"t".repeat(40)}&expires_in=3000&provider=seatalk`);
  await page.waitForURL("**/");
  const stored = await page.evaluate(() => window.sessionStorage.getItem("soc5-access-token"));
  expect(stored).toContain("t".repeat(40));
  expect(page.url()).not.toContain("access_token");
  await page.goto("/auth/callback?seatalk=pending");
  await expect(page.getByText(/awaiting administrator approval/)).toBeVisible();
  await page.goto("/auth/callback?seatalk=error&reason=disabled");
  await expect(page.getByRole("alert").filter({ hasText: "disabled" })).toBeVisible();
});

test("Users: FTE creates an Ops ID account and sees the one-time password once; admin approves a pending account with a role and reason", async ({ page }) => {
  const calls: { m: string; url: string; body: unknown }[] = [];
  let users: Record<string, unknown>[] = [
    { id: ID(21), name: "Pat Pic", role: "ops_pic", email: null, ops_id: "ops21", account_status: "ACTIVE", must_change_password: false },
    { id: ID(22), name: "New Hire", role: null, email: "new@spxexpress.com", ops_id: null, account_status: "PENDING_APPROVAL", must_change_password: false },
  ];
  await page.route("**/api/v1/users**", (r) => {
    const m = r.request().method();
    if (m === "GET") return r.fulfill({ json: { data: users } });
    calls.push({ m, url: new URL(r.request().url()).pathname, body: r.request().postDataJSON() });
    if (m === "POST" && r.request().url().endsWith("/users")) return r.fulfill({ status: 201, json: { id: ID(23), ops_id: "ops23", initial_password: "Initial-Pass-123!" } });
    return r.fulfill({ json: { ok: true, initial_password: "Reset-Pass-456!" } });
  });
  await page.route("**/api/v1/admin/accounts/*/approve", (r) => { calls.push({ m: "POST", url: new URL(r.request().url()).pathname, body: r.request().postDataJSON() }); users = users.map((u) => (u.id === ID(22) ? { ...u, role: "fte_mm", account_status: "ACTIVE" } : u)); return r.fulfill({ json: { ok: true } }); });
  await signedIn(page, "fte_ops", { admin: true });
  await go(page, /^Users/);
  await expect(page.getByRole("row", { name: /New Hire/ }).getByText("pending approval")).toBeVisible();
  await page.getByRole("button", { name: "Add Ops ID user" }).click();
  const addForm = page.getByRole("form", { name: "Add Ops ID user" });
  await addForm.getByLabel("Full name").fill("Dana Doc");
  await addForm.getByLabel("Ops ID").fill("OPS23");
  await addForm.getByLabel("Role").selectOption("doc_officer");
  await addForm.getByRole("button", { name: "Create user" }).click();
  await expect(page.getByText("Initial-Pass-123!")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("Initial-Pass-123!")).toHaveCount(0);
  await page.getByRole("button", { name: "Approve…" }).click();
  await page.getByLabel("Role (required)").selectOption("fte_mm");
  await page.getByLabel(/Reason/).fill("verified with SOC lead");
  await page.getByRole("button", { name: "Approve and assign role" }).click();
  await expect(page.getByText("Account approved.")).toBeVisible();
  expect(calls[0].body).toEqual({ name: "Dana Doc", ops_id: "OPS23", role: "doc_officer" });
  expect(calls[1].body).toEqual({ role: "fte_mm", reason: "verified with SOC lead" });
});

test("Realtime (WebSocket-first): joins with the user's token, refetches on changes, recovers after a reconnect, and does not poll while connected", async ({ page }) => {
  let listCalls = 0;
  const joins: string[] = [];
  let sockets = 0;
  let current: import("@playwright/test").WebSocketRoute | null = null;
  await page.routeWebSocket(/realtime\.test/, (ws) => {
    sockets++;
    current = ws;
    ws.onMessage((raw) => {
      const m = JSON.parse(String(raw)) as { topic: string; event: string; ref: string; payload: { access_token?: string } };
      if (m.event === "phx_join") {
        joins.push(`${m.topic}|${m.payload.access_token}`);
        ws.send(JSON.stringify({ topic: m.topic, event: "phx_reply", ref: m.ref, payload: { status: "ok", response: {} } }));
      }
      if (m.topic === "phoenix") ws.send(JSON.stringify({ topic: "phoenix", event: "phx_reply", ref: m.ref, payload: { status: "ok" } }));
    });
  });
  await page.route("**/api/v1/requests?*", (r) => { listCalls++; return r.fulfill({ json: { data: [base(1)], has_more: false, next_cursor: null, limit: 25 } }); });
  await signedIn(page, "fte_ops");
  await go(page, /^Requests/);
  await expect(page.getByText("REQ-00000001").first()).toBeVisible();
  await expect.poll(() => joins.length).toBe(3);
  expect(joins.every((j) => j.endsWith(`|${"x".repeat(40)}`))).toBe(true);
  expect(joins.map((j) => j.split("|")[0]).sort()).toEqual(["realtime:soc5-intraday_dispatch", "realtime:soc5-notifications", "realtime:soc5-requests"]);
  const settled = listCalls;
  current!.send(JSON.stringify({ topic: "realtime:soc5-requests", event: "postgres_changes", payload: { data: { table: "requests", type: "UPDATE" } } }));
  await expect.poll(() => listCalls).toBeGreaterThan(settled);
  // dropped connection -> reconnect with backoff -> a full refresh after the re-subscription
  const beforeDrop = listCalls;
  await current!.close();
  await expect.poll(() => sockets, { timeout: 8000 }).toBe(2);
  await expect.poll(() => listCalls, { timeout: 8000 }).toBeGreaterThan(beforeDrop);
});
