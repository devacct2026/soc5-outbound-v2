// Google Sheets request synchronization (docs/backend/06-integrations.md), restored to the ORIGINAL 19-column
// layout (source: backend/app/Integrations/GoogleSheets/GoogleSheetsRequestSync.php):
//  * columns A..S with the exact header texts below;
//  * attribution = actor of the LAST REQUEST_APPROVED / TRUCK_ASSIGNED / driver-assignment event, creator name for OPS/PIC;
//  * timestamps formatted `n/j/Y G:i:s` (no zero padding, 24 h) in Asia/Manila; null/empty = "";
//  * rows ordered by request time ascending, header first, full snapshot written with valueInputOption=RAW and the
//    leftover range cleared only AFTER a successful write.
// Deviation (security hardening, documented in the parity matrix): cell text beginning with = + - @ is prefixed
// with an apostrophe so a later export to Excel cannot evaluate it as a formula.
// Credentials are server-only. Not exercised against live Google (no approved credentials).
import { createSign } from "node:crypto";
import { toCsv } from "../../domain/kpi.ts";

export const SHEET_HEADERS = [
  "Request time",
  "Cluster",
  "Region",
  "Dock #",
  "Backlog",
  "Backlogs Time Stamp",
  "LH type (input by FTE MM) (Request)",
  "Ops FTE",
  "Plate number",
  "MM FTE",
  "LH size",
  "LH type (input by FTE MM)",
  "Provide Time",
  "Linehaul Trip",
  "Assigned time",
  "Docked Time",
  "DOC Officer",
  "OPS/PIC",
  "Status",
] as const;
export const SHEET_COLUMNS = SHEET_HEADERS; // back-compat alias
export const SHEET_TIMEZONE = "Asia/Manila";

/** One request plus its server-side attribution (see sheet_export_rows). */
export interface SheetSource {
  requestTimestamp: string;
  cluster: string;
  region: string;
  dockNo: string | null;
  backlogs: number;
  backlogsTimestamp: string | null;
  lhTypeRequest: string | null;
  opsFte: string | null;
  plateNumber: string | null;
  mmFte: string | null;
  truckSize: string;
  truckType: string;
  provideTime: string | null;
  linehaulTripNo: string | null;
  assignedTime: string | null;
  dockedAt: string | null;
  docOfficer: string | null;
  opsPic: string | null;
  status: string;
}

/** `n/j/Y G:i:s` in the business timezone, e.g. 9/5/2026 14:03:09. Empty for null/invalid input. */
export function formatSheetTime(iso: string | null | undefined, tz: string = SHEET_TIMEZONE): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(t))) p[x.type] = x.value;
  return `${p.month}/${p.day}/${p.year} ${Number(p.hour) % 24}:${p.minute}:${p.second}`;
}

/** Neutralise spreadsheet formula injection (see deviation note above). */
export const safeCell = (v: unknown): string | number => {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return v;
  const s = String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};

export function buildSheetRows(requests: SheetSource[]): (string | number)[][] {
  const sorted = [...requests].sort((a, b) => (a.requestTimestamp < b.requestTimestamp ? -1 : a.requestTimestamp > b.requestTimestamp ? 1 : 0));
  return sorted.map((r) =>
    [
      formatSheetTime(r.requestTimestamp),
      r.cluster,
      r.region,
      r.dockNo,
      r.backlogs,
      formatSheetTime(r.backlogsTimestamp),
      r.lhTypeRequest ?? r.truckType,
      r.opsFte,
      r.plateNumber,
      r.mmFte,
      r.truckSize,
      r.truckType,
      formatSheetTime(r.provideTime),
      r.linehaulTripNo,
      formatSheetTime(r.assignedTime),
      formatSheetTime(r.dockedAt),
      r.docOfficer,
      r.opsPic,
      r.status,
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
  requests: SheetSource[],
  previousRowCount: number,
  maxRows = MAX_SHEET_ROWS,
) {
  if (requests.length > maxRows) throw new Error(`row count ${requests.length} exceeds limit ${maxRows}`);
  return client.replace([...SHEET_HEADERS], buildSheetRows(requests), previousRowCount);
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
      // Sheet names are quoted in A1 notation; an embedded quote is doubled (as the original did).
      const sheet = encodeURIComponent(`'${creds.sheetName.replace(/'/g, "''")}'`);
      const lastCol = String.fromCharCode(64 + header.length); // A..S for the 19 columns
      const put = await fetchImpl(`${base}/${sheet}!A1:${lastCol}${rows.length + 1}?valueInputOption=RAW`, {
        method: "PUT", headers, body: JSON.stringify({ values: [header, ...rows] }), signal: AbortSignal.timeout(60_000),
      });
      if (!put.ok) throw new Error(`sheets write failed: ${put.status}`);
      // Stale rows below the new data and anything the old layout left in T:Z, cleared only after a good write.
      const ranges = [`'${creds.sheetName.replace(/'/g, "''")}'!T1:Z`, `'${creds.sheetName.replace(/'/g, "''")}'!A${rows.length + 2}:${lastCol}`];
      const clear = await fetchImpl(`${base}:batchClear`, {
        method: "POST", headers, body: JSON.stringify({ ranges }), signal: AbortSignal.timeout(30_000),
      });
      if (!clear.ok) throw new Error(`sheets clear failed: ${clear.status}`);
      void previousRowCount;
      return { written: rows.length };
    },
  };
}

export { toCsv };
