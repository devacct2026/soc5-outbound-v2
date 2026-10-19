// Intraday dispatch sync from Google Apps Script (docs/backend/06-integrations.md).
// Contract choices where the original Edge Function is not in this checkout:
// signature = hex HMAC-SHA256(secret, `${x-timestamp}.${rawBody}`), 300s skew.
import type { Backend } from "./backend.ts";
import { isRealDate } from "../domain/requests/validation.ts";
import { json } from "./api.ts";
import { readBodyLimited } from "./http-body.ts";
import { verifySyncSignature } from "./seatalk/contract.ts";

export const MAX_BODY_BYTES = 1_000_000;
export const MAX_ROWS = 1000;
const ACCEPTED_STATUS = "SOC_LHTransporting";

export interface IntradayRow {
  date: string;
  hour: number;
  orderQty: number;
}

type IncomingRow = {
  status_desc?: unknown;
  status?: unknown;
  c_date_6am?: unknown;
  pkg_vol?: unknown;
  process_hours?: unknown;
  date?: unknown;
  dispatch_date?: unknown;
  hour?: unknown;
  order_qty?: unknown;
  orderQty?: unknown;
};

export function aggregateRows(rows: unknown[]): { rows: IntradayRow[]; rejected: number; skipped: number } {
  const by = new Map<string, IntradayRow>();
  let rejected = 0;
  let skipped = 0;
  for (const r of rows) {
    if (!r || typeof r !== "object" || Array.isArray(r)) { rejected++; continue; }
    const o = r as IncomingRow;
    const status = o.status_desc ?? o.status;
    if (status !== undefined && typeof status !== "string") { rejected++; continue; }
    if (status && status.trim() !== ACCEPTED_STATUS) { skipped++; continue; }
    const date = o.c_date_6am ?? o.dispatch_date ?? o.date;
    const hour = Number(o.process_hours ?? o.hour);
    const rawQty = o.pkg_vol ?? o.order_qty ?? o.orderQty ?? 0;
    const qty = Number(String(rawQty).replaceAll(",", ""));
    if (typeof date !== "string" || !isRealDate(date) || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isFinite(qty) || qty < 0) {
      rejected++;
      continue;
    }
    const key = `${date}|${hour}`;
    const prior = by.get(key);
    by.set(key, { date, hour, orderQty: (prior?.orderQty ?? 0) + qty }); // duplicate keys aggregate
  }
  return { rows: [...by.values()], rejected, skipped };
}

export async function intradaySyncHandler(backend: Backend | null, request: Request): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!backend) return json(503, { error: "BACKEND_NOT_CONFIGURED" });
  const secret = process.env.SOC5_INTRADAY_SYNC_SECRET ?? backend.intradaySecret;
  if (!secret) return json(503, { error: "INTRADAY_SYNC_DISABLED" });
  if ((request.headers.get("x-sync-source") ?? request.headers.get("x-source") ?? "").trim().toLowerCase() !== "google-apps-script") return json(403, { error: "Forbidden: unknown sync source" });
  const raw = await readBodyLimited(request, MAX_BODY_BYTES);
  if (raw === null) return json(413, { error: "Payload too large." });
  const sig = verifySyncSignature(secret, request.headers, raw, backend.now());
  if (!sig.ok) return json(401, { error: "Unauthorized" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json(400, { error: "Unable to process intraday sync request." });
  }
  const body = parsed as { rows?: unknown; data?: unknown } | null;
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(body?.rows) ? body.rows : Array.isArray(body?.data) ? body.data : parsed && typeof parsed === "object" ? [parsed] : null;
  if (!Array.isArray(rows)) return json(422, { error: "No valid intraday rows supplied.", received: 1, rejected: 1 });
  if (rows.length > MAX_ROWS) return json(413, { error: "Too many rows supplied." });
  const agg = aggregateRows(rows);
  if (!agg.rows.length) return json(422, { error: "No valid intraday rows supplied.", received: rows.length, rejected: agg.rejected });
  try {
    await backend.store.upsertIntraday(agg.rows);
  } catch (error) {
    console.error("Intraday sync database write failed", error);
    return json(502, { error: "Unable to persist intraday dispatch data." });
  }
  // Source-compatible counts: filtered status rows are skipped, not rejected.
  return json(200, { success: true, received: rows.length, processed: agg.rows.length, rejected: agg.rejected });
}
