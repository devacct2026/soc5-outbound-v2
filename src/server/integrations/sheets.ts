// Google Sheets request synchronization (docs/backend/06-integrations.md).
// Credentials are server-only. The column set below is a v2 definition: the
// original 19-column layout is not in this checkout and must be confirmed
// against the production sheet before enabling (recorded as a blocker).
import { createSign } from "node:crypto";
import type { RequestRecord } from "../../domain/requests/lifecycle.ts";
import { toCsv } from "../../domain/kpi.ts";

export const SHEET_COLUMNS = [
  "request_id", "request_timestamp", "cluster", "region", "dock_no", "backlogs", "truck_size", "truck_type",
  "status", "approval_status", "approved_at", "plate_number", "provide_time", "driver_id", "driver_assigned_at",
  "linehaul_trip_no", "docked_at", "cancellation_remarks", "created_by",
] as const;

/** Neutralise spreadsheet formula injection even though cells are written RAW. */
export const safeCell = (v: unknown): string | number => {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return v;
  const s = String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};

export function buildSheetRows(requests: RequestRecord[]): (string | number)[][] {
  const sorted = [...requests].sort((a, b) => (a.requestTimestamp < b.requestTimestamp ? -1 : 1));
  return sorted.map((r) =>
    [
      r.id, r.requestTimestamp, r.cluster, r.region, r.dockNo, r.backlogs, r.truckSize, r.truckType, r.status,
      r.approvalStatus, r.approvedAt, r.plateNumber, r.provideTime, r.driverId, r.driverAssignedAt, r.linehaulTripNo,
      r.dockedAt, r.cancellationRemarks, r.createdBy,
    ].map(safeCell),
  );
}

export interface SheetsClient {
  /** Replace the data range; clear stale rows only after a successful write. */
  replace(header: string[], rows: (string | number)[][], previousRowCount: number): Promise<{ written: number }>;
}
export const disabledSheetsClient: SheetsClient = {
  async replace() {
    throw new Error("Google Sheets sync is disabled");
  },
};

export const MAX_SHEET_ROWS = 50_000;

export async function syncRequestsToSheet(
  client: SheetsClient,
  requests: RequestRecord[],
  previousRowCount: number,
  maxRows = MAX_SHEET_ROWS,
) {
  if (requests.length > maxRows) throw new Error(`row count ${requests.length} exceeds limit ${maxRows}`);
  return client.replace([...SHEET_COLUMNS], buildSheetRows(requests), previousRowCount);
}

// ---------------------------------------------------------- REST client
export interface GoogleCreds {
  clientEmail: string;
  privateKey: string; // PEM; server-only
  spreadsheetId: string;
  sheetName: string;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Service-account OAuth (JWT bearer) + Sheets values API over fetch. Untested against Google. */
export function createGoogleSheetsClient(creds: GoogleCreds, fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()): SheetsClient {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(creds.spreadsheetId)}/values`;
  async function token(): Promise<string> {
    const iat = Math.floor(now().getTime() / 1000);
    const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = b64u(JSON.stringify({
      iss: creds.clientEmail, scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3000,
    }));
    const sig = createSign("RSA-SHA256").update(`${head}.${claim}`).sign(creds.privateKey);
    const res = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${b64u(sig)}` }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`google token request failed: ${res.status}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }
  return {
    async replace(header, rows, previousRowCount) {
      const t = await token();
      const headers = { authorization: `Bearer ${t}`, "content-type": "application/json" };
      const sheet = encodeURIComponent(creds.sheetName);
      const lastCol = String.fromCharCode(64 + header.length); // A..S for 19 columns
      const put = await fetchImpl(`${base}/${sheet}!A1:${lastCol}${rows.length + 1}?valueInputOption=RAW`, {
        method: "PUT", headers, body: JSON.stringify({ values: [header, ...rows] }), signal: AbortSignal.timeout(60_000),
      });
      if (!put.ok) throw new Error(`sheets write failed: ${put.status}`);
      if (previousRowCount > rows.length) {
        const clear = await fetchImpl(`${base}/${sheet}!A${rows.length + 2}:${lastCol}${previousRowCount + 1}:clear`, {
          method: "POST", headers, body: "{}", signal: AbortSignal.timeout(30_000),
        });
        if (!clear.ok) throw new Error(`sheets clear failed: ${clear.status}`); // stale rows cleared only after a good write
      }
      return { written: rows.length };
    },
  };
}

export { toCsv };
