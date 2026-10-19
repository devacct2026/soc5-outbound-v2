// Intraday dispatch sync from Google Apps Script (docs/backend/06-integrations.md).
// Contract choices where the original Edge Function is not in this checkout:
// signature = hex HMAC-SHA256(secret, `${x-timestamp}.${rawBody}`), 300s skew.
import type { Backend } from "./backend.ts";
import { isRealDate } from "../domain/requests/validation.ts";
import { json } from "./api.ts";
import { verifyCallbackSignature } from "./seatalk/contract.ts";

export const MAX_BODY_BYTES = 1_000_000;
export const MAX_ROWS = 1000;
const ACCEPTED_STATUS = "SOC_LHTransporting";

export interface IntradayRow {
  date: string;
  hour: number;
  orderQty: number;
}

export function aggregateRows(rows: unknown[]): { rows: IntradayRow[]; rejected: number; skipped: number } {
  const by = new Map<string, IntradayRow>();
  let rejected = 0;
  let skipped = 0;
  for (const r of rows) {
    if (!r || typeof r !== "object") { rejected++; continue; }
    const o = r as Record<string, unknown>;
    const date = o.date;
    const hour = o.hour;
    const qty = o.order_qty ?? o.orderQty;
    if (typeof date !== "string" || !isRealDate(date) || typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 23 || typeof qty !== "number" || !Number.isFinite(qty) || qty < 0) {
      rejected++;
      continue;
    }
    if (o.status !== undefined && o.status !== ACCEPTED_STATUS) { skipped++; continue; }
    const key = `${date}|${hour}`;
    const prior = by.get(key);
    by.set(key, { date, hour, orderQty: (prior?.orderQty ?? 0) + qty }); // duplicate keys aggregate
  }
  return { rows: [...by.values()], rejected, skipped };
}

export async function intradaySyncHandler(backend: Backend | null, request: Request): Promise<Response> {
  if (!backend) return json(503, { error: "BACKEND_NOT_CONFIGURED" });
  const secret = process.env.INTRADAY_SYNC_SECRET ?? backend.intradaySecret;
  if (!secret) return json(503, { error: "INTRADAY_SYNC_DISABLED" });
  if (request.headers.get("x-source") !== "google-apps-script") return json(403, { error: "FORBIDDEN" });
  const len = Number(request.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return json(413, { error: "PAYLOAD_TOO_LARGE" });
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return json(413, { error: "PAYLOAD_TOO_LARGE" });
  const sig = verifyCallbackSignature({ secret, maxSkewSeconds: 300 }, request.headers, raw, backend.now());
  if (!sig.ok) return json(401, { error: "INVALID_SIGNATURE" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json(400, { error: "BAD_REQUEST" });
  }
  const rows = (parsed as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return json(400, { error: "BAD_REQUEST" });
  if (rows.length > MAX_ROWS) return json(413, { error: "TOO_MANY_ROWS" });
  const agg = aggregateRows(rows);
  if (agg.rows.length) await backend.store.upsertIntraday(agg.rows);
  // Counts only: never provider/database details.
  return json(200, { received: rows.length, processed: agg.rows.length, rejected: agg.rejected + agg.skipped });
}
