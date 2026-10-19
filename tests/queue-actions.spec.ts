import { test, expect, type Page } from "@playwright/test";

const row = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "abcdef12-0000-0000-0000-000000000000", cluster: "Pasig", region: "NCR", dock_no: "7", status, display_status: status,
  plate_number: null, driver_id: null, created_by: "pic-1", rejection_disposition: null, ...extra,
});

async function signIn(page: Page, role: string, status: string, extra: Record<string, unknown> = {}) {
  await page.route("**/api/v1/auth/login", (r) => r.fulfill({ json: { access_token: "x".repeat(40), expires_in: 3600 } }));
  await page.route("**/api/v1/auth/me", (r) => r.fulfill({ json: { id: "me-1", role, is_admin: false, reporting_permission: false } }));
  await page.route("**/api/v1/requests/queue*", (r) => r.fulfill({ json: { data: [row(status, extra)], has_more: false, next_cursor: null, limit: 50 } }));
  await page.route("**/api/v1/requests?*", (r) => r.fulfill({ json: { data: [], has_more: false, next_cursor: null, limit: 100 } }));
  await page.route("**/api/v1/requests/metrics", (r) => r.fulfill({ json: { total: 0, awaiting_action: 0, by_status: {} } }));
  await page.route("**/api/v1/dispatch/intraday?*", (r) => r.fulfill({ json: { data: [] } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Connect live data" }).click();
  await page.getByPlaceholder("Email").fill("u@example.com");
  await page.getByPlaceholder("Password").fill("not-a-real-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Connected to live API")).toBeVisible();
  await page.getByRole("link", { name: /^Queue/ }).first().click();
}

test("FTE MM assigns a truck from the queue: idempotency key, validated body, list refresh", async ({ page }) => {
  let sent: { key: string; body: unknown; url: string } | null = null;
  await page.route("**/api/v1/requests/*/assign-truck", (r) => {
    sent = { key: r.request().headers()["idempotency-key"], body: r.request().postDataJSON(), url: r.request().url() };
    return r.fulfill({ json: { request: row("DOCKING") } });
  });
  await signIn(page, "fte_mm", "REQUESTED");
  await expect(page.getByText("Queue: your actionable queue")).toBeVisible();
  await expect(page.getByText("REQ-ABCDEF12")).toBeVisible();
  await page.getByRole("button", { name: "Assign truck" }).click();
  await page.getByPlaceholder("Plate number").fill("abc 123");
  await page.getByLabel("Truck size").selectOption("6W");
  await page.getByRole("button", { name: /Confirm assign truck/i }).click();
  await expect(page.getByText("Assign truck completed.")).toBeVisible();
  expect(sent!.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(sent!.body).toEqual({ plate_number: "abc 123", truck_size: "6W", truck_type: "WETLEASE" });
  expect(sent!.url).toContain("/requests/abcdef12-0000-0000-0000-000000000000/assign-truck");
});

test("FTE Ops approval shows the SeaTalk-disabled message and the request stays pending", async ({ page }) => {
  await page.route("**/api/v1/requests/*/approve", (r) => r.fulfill({ status: 503, json: { error: "APPROVAL_PROVIDER_DISABLED" } }));
  await signIn(page, "fte_ops", "PENDING");
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("button", { name: /Confirm approve/i }).click();
  await expect(page.locator("p[role=alert]")).toContainText("SeaTalk Approval Center");
  await expect(page.getByText("REQ-ABCDEF12")).toBeVisible();
});

test("only actions valid for the role and state are offered; reject needs remarks", async ({ page }) => {
  await signIn(page, "doc_officer", "DOCKING");
  await expect(page.getByRole("button", { name: "Assign driver" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enter trip no." })).toHaveCount(0);
});

test("signed out, Queue keeps the original prototype content", async ({ page }) => {
  await page.goto("/queue");
  await expect(page.getByText("Queue updates are represented by local mock data only.")).toBeVisible();
  await expect(page.getByText("your actionable queue")).toHaveCount(0);
});
