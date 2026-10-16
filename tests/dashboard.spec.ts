import { expect, test } from "@playwright/test";

const routes = [
  ["/requests", "Requests"],
  ["/approvals", "Approvals"],
  ["/queue", "Queue"],
  ["/docking", "Docking"],
  ["/intraday-kpi", "Intraday KPI"],
  ["/notifications", "Notifications"],
  ["/users", "Users"],
  ["/reports", "Reports"],
  ["/settings", "Settings"],
] as const;

test("sidebar routes render and mark the active page", async ({ page }) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(message.text());
  });
  page.on("requestfailed", (request) => {
    if (
      request.url().startsWith("http://127.0.0.1:3000/") &&
      request.failure()?.errorText !== "net::ERR_ABORTED"
    ) {
      failures.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
    }
  });
  page.on("response", (response) => {
    if (response.url().startsWith("http://127.0.0.1:3000/") && response.status() >= 400) {
      failures.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Logistics Control Center" })).toBeVisible();
  for (const [route, title] of routes) {
    const navLink = page.locator(`a[href="${route}"]:visible`);
    await expect(navLink).toHaveCount(1);
    await navLink.click();
    await expect(page).toHaveURL(route);
    await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
    await expect(navLink.first()).toHaveAttribute("aria-current", "page");
  }
  expect(failures).toEqual([]);
});

test("dashboard filters and theme toggle respond to input", async ({ page }) => {
  await page.goto("/");
  const dateFilter = page.getByLabel("Reporting date range");
  const flowTicks = page.locator(".flow-panel .recharts-cartesian-axis-tick-value");
  await expect.poll(() => flowTicks.count()).toBeGreaterThan(0);
  const fullDayTickCount = await flowTicks.count();
  await dateFilter.selectOption("week");
  await expect(dateFilter).toHaveValue("week");
  await expect.poll(() => flowTicks.count()).toBeLessThan(fullDayTickCount);
  const weekTickCount = await flowTicks.count();
  const chartPeriod = page.getByLabel("Chart time period").first();
  await chartPeriod.selectOption("month");
  await expect(page.getByLabel("Chart time period").last()).toHaveValue("month");
  await expect(dateFilter).toHaveValue("month");
  await expect.poll(() => flowTicks.count()).toBeLessThan(weekTickCount);
  await page.getByLabel("Chart metric").selectOption("trucks");
  await expect(page.getByLabel("Chart metric")).toHaveValue("trucks");

  const themeToggle = page.getByRole("button", { name: "Toggle light and dark theme" });
  await themeToggle.focus();
  await page.keyboard.press("Enter");
  await expect(themeToggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.keyboard.press("Enter");
  await expect(themeToggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
});

test("responsive layout and mobile sidebar work at common widths", async ({ page }) => {
  for (const width of [1440, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Logistics Control Center" })).toBeVisible();
    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(documentWidth).toBeLessThanOrEqual(width);

    const menuButton = page.getByRole("button", { name: "Open navigation menu" });
    if (width <= 900) {
      await expect(menuButton).toBeVisible();
      await menuButton.click();
      await expect(menuButton).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Escape");
      await expect(menuButton).toHaveAttribute("aria-expanded", "false");
      await expect(menuButton).toBeFocused();
      await menuButton.click();
      await expect(menuButton).toHaveAttribute("aria-expanded", "true");
      await page.locator('a[href="/docking"]').click();
      await expect(page).toHaveURL("/docking");
      await expect(menuButton).toHaveAttribute("aria-expanded", "false");
    } else {
      await expect(menuButton).toBeHidden();
    }
  }
});

test("request details dialog supports keyboard focus and Escape", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const firstRequest = page.getByRole("button", { name: /View request/ }).first();
  await firstRequest.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Request details" });
  await expect(dialog).toBeVisible();
  const closeButton = page.getByRole("button", { name: "Close request details" });
  await expect(closeButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeButton).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(firstRequest).toBeFocused();
});
