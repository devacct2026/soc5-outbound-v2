// Cluster import from the Google Apps Script (lead 7). Same contract as the original sync Edge Function:
// POST only, `x-sync-source: google-apps-script`, signed (x-sync-timestamp / x-sync-signature, 300 s skew),
// <= 1,000,000 bytes and <= 1000 rows, JSON array of
// { cluster_name, region, dock_number, backlogs, backlogs_ts }. Rows are validated and de-duplicated by
// name (last wins); the database upserts atomically and propagates backlog changes to matching requests.
import type { Backend } from "./backend.ts";
import { parseBacklogInstant } from "../domain/requests/validation.ts";
import { json } from "./api.ts";
import { readBodyLimited } from "./http-body.ts";
import { verifySyncSignature } from "./seatalk/contract.ts";
import type { ClusterImportRow } from "./store.ts";

export const CLUSTER_MAX_BODY_BYTES = 1_000_000;
export const CLUSTER_MAX_ROWS = 1000;
export const CLUSTER_FIELDS = ["cluster_name", "region", "dock_number", "backlogs", "backlogs_ts"] as const;

export function parseClusterRows(rows: unknown[]): { rows: ClusterImportRow[]; rejected: number; duplicatesRemoved: number } {
  const by = new Map<string, ClusterImportRow>();
  let rejected = 0;
  let valid = 0;
  for (const r of rows) {
    if (!r || typeof r !== "object" || Array.isArray(r)) { rejected++; continue; }
    const o = r as Record<string, unknown>;
    const name = String(o.cluster_name ?? "").trim();
    const region = String(o.region ?? "").trim();
    const dockRaw = o.dock_number;
    const dock = dockRaw === null || dockRaw === undefined ? "" : String(dockRaw).trim();
    const backlogsRaw = o.backlogs;
    const backlogs = backlogsRaw === null || backlogsRaw === undefined || backlogsRaw === "" ? 0 : Number(backlogsRaw);
    const tsRaw = o.backlogs_ts;
    let ts: string | null = null;
    if (tsRaw !== null && tsRaw !== undefined && tsRaw !== "") {
      ts = typeof tsRaw === "string" ? parseBacklogInstant(tsRaw) : null;
      if (!ts) { rejected++; continue; }
    }
    if (!name || name.length > 120 || !region || region.length > 120 || dock.length > 50 || !Number.isInteger(backlogs) || backlogs < 0 || backlogs > 1_000_000) {
      rejected++;
      continue;
    }
    valid++;
    by.set(name, { name, region, dockNo: dock || null, backlogs, backlogsTimestamp: ts });
  }
  return { rows: [...by.values()], rejected, duplicatesRemoved: valid - by.size };
}

export async function clusterSyncHandler(backend: Backend | null, request: Request): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!backend) return json(503, { error: "BACKEND_NOT_CONFIGURED" });
  const secret = process.env.SOC5_CLUSTER_SYNC_SECRET ?? backend.clusterSyncSecret;
  if (!secret) return json(503, { error: "CLUSTER_SYNC_DISABLED" });
  if ((request.headers.get("x-sync-source") ?? request.headers.get("x-source") ?? "").trim().toLowerCase() !== "google-apps-script") return json(403, { error: "Forbidden: unknown sync source" });
  const raw = await readBodyLimited(request, CLUSTER_MAX_BODY_BYTES);
  if (raw === null) return json(413, { error: "Payload too large." });
  const sig = verifySyncSignature(secret, request.headers, raw, backend.now());
  if (!sig.ok) return json(401, { error: "Unauthorized" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json(400, { error: "Unable to process cluster sync request." });
  }
  const body = parsed as { rows?: unknown; data?: unknown } | null;
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(body?.rows) ? body.rows : Array.isArray(body?.data) ? body.data : parsed && typeof parsed === "object" ? [parsed] : null;
  if (!Array.isArray(rows)) return json(422, { error: "No valid cluster rows supplied.", received: 1, rejected: 1 });
  if (rows.length > CLUSTER_MAX_ROWS) return json(413, { error: "Too many rows supplied." });
  const v = parseClusterRows(rows);
  if (!v.rows.length) return json(422, { error: "No valid cluster rows supplied.", received: rows.length, rejected: v.rejected });
  let out: { processed: number };
  try {
    out = await backend.store.importClusters(v.rows, "google-apps-script");
  } catch (error) {
    console.error("Cluster sync database write failed", error);
    return json(502, { error: "Unable to persist cluster data." });
  }
  // Counts only: never provider or database details.
  return json(200, {
    success: true, received: rows.length, processed: out.processed, rejected: v.rejected,
    duplicatesRemoved: v.duplicatesRemoved, source: "cluster!A1:E1000", fields: CLUSTER_FIELDS,
  });
}
