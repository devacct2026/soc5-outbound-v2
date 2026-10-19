import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    ...devices["Desktop Chrome"],
    browserName: "chromium",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Public-by-design realtime settings so the WebSocket path can be exercised against a mocked socket.
    env: {
      NEXT_PUBLIC_SOC5_REALTIME_URL: "https://realtime.test",
      NEXT_PUBLIC_SOC5_REALTIME_ANON_KEY: "anon-test-key",
      // E2E must never reach a real project: blank values override anything in .env.local, so unmocked API calls
      // answer 503 locally instead of contacting a configured backend.
      SOC5_SUPABASE_URL: "",
      SOC5_SUPABASE_ANON_KEY: "",
      SOC5_SUPABASE_SERVICE_ROLE_KEY: "",
    },
  },
});
