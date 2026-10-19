import { test, expect } from "@playwright/test";

// The dashboard UI is unchanged when signed out (covered by dashboard.spec.ts).
// Here the API is mocked at the network layer to prove sign-in -> live data wiring.
const req = (n: number, status: string, plate: string | null) => ({
  id: `0000000${n}-0000-0000-0000-000000000000`, cluster: `Cluster ${n}`, region: "NCR", dock_no: String(n),
  plate_number: plate, created_by: "aaaaaaaa-1111", status, provide_time: null, request_timestamp: "2026-10-19T10:00:00Z",
});

test("signed-out shows the existing data; signing in swaps in live API data", async ({ page }) => {
  let authHeader = "";
  await page.route("**/api/v1/auth/login", (r) => r.fulfill({ json: { access_token: "x".repeat(40), expires_in: 3600 } }));
  await page.route("**/api/v1/requests?*", (r) => {
    authHeader = r.request().headers()["authorization"] ?? "";
    return r.fulfill({ json: { data: [req(1, "PENDING", null), req(2, "DOCKING", "ABC 123"), req(3, "DOCKED", "XYZ 999")], has_more: false, next_cursor: null, limit: 100 } });
  });
  await page.route("**/api/v1/requests/metrics", (r) => r.fulfill({ json: { total: 3, awaiting_action: 2, by_status: { PENDING: 1, DOCKING: 1, DOCKED: 1 } } }));
  await page.route("**/api/v1/dispatch/intraday?*", (r) => r.fulfill({ json: { data: [{ hour: 6, orderQty: 40 }, { hour: 7, orderQty: 2 }] } }));

  await page.goto("/");
  await expect(page.getByText("Logistics Control Center")).toBeVisible();
  await expect(page.getByText("Last updated today, 10:24 AM")).toBeVisible();

  await page.getByRole("button", { name: "Connect live data" }).click();
  await page.getByPlaceholder("Email").fill("ops@example.com");
  await page.getByPlaceholder("Password").fill("not-a-real-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page.getByText("Connected to live API")).toBeVisible();
  await expect(page.getByText("Cluster 2")).toBeVisible();
  await expect(page.getByText("ABC 123")).toBeVisible();
  await expect(page.getByText("Last updated today, 10:24 AM")).toHaveCount(0);
  await expect(page.locator(".kpi-card", { hasText: "Intraday Volume" }).locator(".kpi-value")).toHaveText("42");
  await expect(page.locator(".kpi-card", { hasText: "Trucks in Queue" }).locator(".kpi-value")).toHaveText("1");
  expect(authHeader).toMatch(/^Bearer x{40}$/);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Connect live data" })).toBeVisible();
  await expect(page.getByText("Last updated today, 10:24 AM")).toBeVisible();
});
