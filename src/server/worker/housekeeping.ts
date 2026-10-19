// Daily housekeeping: retention purge honoring legal holds (NOT-6) and expiry
// of idempotency keys (OPS-4). Runs at most once per UTC day per process.
import type { Rest } from "../supabase/rest.ts";

export function makeCleanupRunner(rest: Rest, now: () => Date = () => new Date()) {
  let lastDay = "";
  return async function cleanup(): Promise<boolean> {
    const day = now().toISOString().slice(0, 10);
    if (day === lastDay) return false;
    await rest.rpc("purge_expired", { p_now: now().toISOString() });
    lastDay = day;
    return true;
  };
}
