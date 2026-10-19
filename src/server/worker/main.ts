// Dedicated background worker (OPS-5). Run: `npm run worker` (loop) or
// `npm run worker -- --once` (single tick, for cron/CI). Server-only: reads the
// service-role key from the environment and never logs it.
import { makeCleanupRunner } from "./housekeeping.ts";
import { runWorkerOnce, type Channel, type ChannelHandler } from "./outbox-worker.ts";
import { SupabaseOutboxPort } from "./ports.ts";
import { Rest } from "../supabase/rest.ts";
import { SupabaseStore } from "../supabase/backend.ts";
import { createGoogleSheetsClient, syncRequestsToSheet } from "../integrations/sheets.ts";

export function buildHandlers(env: NodeJS.ProcessEnv, store: SupabaseStore): Partial<Record<Channel, ChannelHandler>> {
  const handlers: Partial<Record<Channel, ChannelHandler>> = {};
  // Google Sheets: only when explicitly enabled AND credentials are present.
  if (env.SOC5_FEATURE_GOOGLE_SHEETS === "true" && env.GOOGLE_SA_EMAIL && env.GOOGLE_SA_PRIVATE_KEY && env.GOOGLE_SHEET_ID) {
    const client = createGoogleSheetsClient({
      clientEmail: env.GOOGLE_SA_EMAIL,
      privateKey: env.GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, "\n"),
      spreadsheetId: env.GOOGLE_SHEET_ID,
      sheetName: env.GOOGLE_SHEET_NAME ?? "Requests",
    });
    let previous = 0;
    handlers.GOOGLE_SHEETS = async () => {
      const rows = await store.reportingRows("2000-01-01", "2999-12-31");
      const r = await syncRequestsToSheet(client, rows, previous);
      previous = r.written;
      return { acknowledged: true };
    };
  }
  // SEATALK_ALERT / SEATALK_APPROVAL_SYNC: intentionally unregistered until the
  // provider contract is verified in a sandbox (SEA-2). Rows are never claimed.
  return handlers;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const url = env.SOC5_SUPABASE_URL;
  const key = env.SOC5_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("worker: SOC5_SUPABASE_URL and SOC5_SUPABASE_SERVICE_ROLE_KEY are required (legacy SUPABASE_* names are intentionally ignored)");
    return 2;
  }
  const rest = new Rest({ url, serviceKey: key });
  const port = new SupabaseOutboxPort(rest);
  const store = new SupabaseStore(rest);
  const handlers = buildHandlers(env, store);
  const cleanup = makeCleanupRunner(rest);
  const intervalMs = Number(env.WORKER_INTERVAL_SECONDS ?? 15) * 1000;
  // BullMQ + Redis scheduling (architecture target). The DB outbox remains authoritative.
  if (env.SOC5_QUEUE === "bullmq" && !argv.includes("--once")) {
    const redisUrl = env.SOC5_REDIS_URL;
    if (!redisUrl) {
      console.error("worker: SOC5_REDIS_URL is required when SOC5_QUEUE=bullmq");
      return 2;
    }
    const { startBullWorker } = await import("./bullmq.ts");
    const { Redis: IORedis } = await import("ioredis");
    const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    const handle = await startBullWorker({
      connection,
      intervalMs,
      deps: { port, handlers, onAlert: (m) => console.error(`ALERT ${m}`), housekeeping: cleanup },
    });
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", () => resolve());
      process.once("SIGINT", () => resolve());
    });
    await handle.close();
    connection.disconnect();
    return 0;
  }
  let stop = false;
  process.on("SIGTERM", () => (stop = true));
  process.on("SIGINT", () => (stop = true));

  do {
    try {
      const t = await runWorkerOnce({ port, handlers, now: new Date(), onAlert: (m) => console.error(`ALERT ${m}`) });
      console.log(JSON.stringify({ at: new Date().toISOString(), ...t, alerts: t.alerts.length }));
      await cleanup();
    } catch (e) {
      console.error("worker tick failed:", e instanceof Error ? e.message : "unknown error");
    }
    if (argv.includes("--once")) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  } while (!stop);
  return 0;
}
