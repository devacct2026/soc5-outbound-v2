// Server-side input validation (the UI is never the authority). Unknown fields
// are rejected. Hand-written to keep the domain dependency-free.
import { DEFAULT_SCHEDULE, zonedToUtc } from "../kpi.ts";
import {
  TRUCK_SIZES,
  TRUCK_TYPES,
  type RequestDetails,
  type TruckInput,
  type TruckSize,
  type TruckType,
} from "./lifecycle.ts";

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PLATE = /^[A-Za-z0-9][A-Za-z0-9 -]{0,19}$/;
const TRIP = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,49}$/;
const DRIVER = /^[0-9]{1,10}$/;

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function strictKeys(body: Obj, allowed: string[], errors: Record<string, string>) {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) errors[k] = "unknown field";
}

function str(body: Obj, key: string, max: number, errors: Record<string, string>): string {
  const v = body[key];
  if (typeof v !== "string" || !v.trim()) {
    errors[key] = "required";
    return "";
  }
  if (v.trim().length > max) errors[key] = `max ${max} characters`;
  return v.trim();
}

export function isRealDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const ZONED = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Backlog date/time (lead 8): the FULL instant is preserved, never truncated to a date.
 * Accepts an ISO instant with offset/Z, a zone-less wall-clock date-time (read in the business
 * timezone), or a bare date (start of that business day, kept for legacy clients). Returns a UTC
 * ISO string, or null when the value is not a real date/time.
 */
export function parseBacklogInstant(v: string, tz: string = DEFAULT_SCHEDULE.timezone): string | null {
  const input = v.trim();
  if (isRealDate(input)) return new Date(zonedToUtc(input, "00:00", tz)).toISOString();
  const m = ZONED.exec(input);
  if (!m) return null;
  const [, date, hh, mm, ss, zone] = m;
  if (!isRealDate(date) || +hh > 23 || +mm > 59 || (ss !== undefined && +ss > 59)) return null;
  let ms: number;
  if (zone) {
    ms = Date.parse(input.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  } else {
    ms = zonedToUtc(date, `${hh}:${mm}`, tz) + (ss ? Number(ss) * 1000 : 0);
  }
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function parseRequestDetails(body: unknown): Parsed<RequestDetails> {
  const errors: Record<string, string> = {};
  if (!isObj(body)) return { ok: false, errors: { body: "JSON object required" } };
  strictKeys(
    body,
    ["cluster", "cluster_id", "region", "dock_no", "backlogs", "backlogs_timestamp", "truck_size", "truck_type"],
    errors,
  );
  const cluster = str(body, "cluster", 120, errors);
  const region = str(body, "region", 120, errors);
  const dockNo = str(body, "dock_no", 50, errors);
  const backlogs = body.backlogs;
  if (typeof backlogs !== "number" || !Number.isInteger(backlogs) || backlogs < 0 || backlogs > 1_000_000) {
    errors.backlogs = "non-negative integer required";
  }
  let backlogsTimestamp: string | null = null;
  if (body.backlogs_timestamp != null) {
    const parsedAt = typeof body.backlogs_timestamp === "string" ? parseBacklogInstant(body.backlogs_timestamp) : null;
    if (!parsedAt) errors.backlogs_timestamp = "ISO date-time (or YYYY-MM-DD) required";
    else backlogsTimestamp = parsedAt;
  }
  let clusterId: string | null = null;
  if (body.cluster_id != null) {
    if (!isUuid(body.cluster_id)) errors.cluster_id = "uuid required";
    else clusterId = body.cluster_id;
  }
  if (!TRUCK_SIZES.includes(body.truck_size as TruckSize)) errors.truck_size = `one of ${TRUCK_SIZES.join(", ")}`;
  if (!TRUCK_TYPES.includes(body.truck_type as TruckType)) errors.truck_type = `one of ${TRUCK_TYPES.join(", ")}`;
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      clusterId,
      cluster,
      region,
      dockNo,
      backlogs: backlogs as number,
      backlogsTimestamp,
      truckSize: body.truck_size as TruckSize,
      truckType: body.truck_type as TruckType,
    },
  };
}

export function parseRemarks(body: unknown, key: string, required: boolean): Parsed<string | null> {
  if (body === undefined || body === null) body = {};
  if (!isObj(body)) return { ok: false, errors: { body: "JSON object required" } };
  const errors: Record<string, string> = {};
  strictKeys(body, [key], errors);
  const v = body[key];
  if (v !== undefined && typeof v !== "string") errors[key] = "string required";
  else if (typeof v === "string" && v.length > 2000) errors[key] = "max 2000 characters";
  else if (required && (typeof v !== "string" || !v.trim())) errors[key] = "required";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: typeof v === "string" && v.trim() ? v.trim() : null };
}

export function parseEmpty(body: unknown): Parsed<null> {
  if (body === undefined || body === null) return { ok: true, value: null };
  if (isObj(body) && Object.keys(body).length === 0) return { ok: true, value: null };
  return { ok: false, errors: { body: "no fields accepted" } };
}

export function parseTruck(body: unknown): Parsed<TruckInput> {
  const errors: Record<string, string> = {};
  if (!isObj(body)) return { ok: false, errors: { body: "JSON object required" } };
  // provide_time is tolerated but ignored: the server always uses its own clock.
  strictKeys(body, ["plate_number", "truck_size", "truck_type", "provide_time"], errors);
  const plate = typeof body.plate_number === "string" ? body.plate_number.trim().toUpperCase() : "";
  if (!PLATE.test(plate)) errors.plate_number = "1-20 letters, digits, spaces or hyphens";
  if (!TRUCK_SIZES.includes(body.truck_size as TruckSize)) errors.truck_size = `one of ${TRUCK_SIZES.join(", ")}`;
  if (!TRUCK_TYPES.includes(body.truck_type as TruckType)) errors.truck_type = `one of ${TRUCK_TYPES.join(", ")}`;
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: { plateNumber: plate, truckSize: body.truck_size as TruckSize, truckType: body.truck_type as TruckType },
  };
}

export function parseDriver(body: unknown): Parsed<string> {
  const errors: Record<string, string> = {};
  if (!isObj(body)) return { ok: false, errors: { body: "JSON object required" } };
  strictKeys(body, ["driver_id"], errors);
  const v = typeof body.driver_id === "string" ? body.driver_id.trim() : "";
  if (!DRIVER.test(v)) errors.driver_id = "1-10 digits";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: v };
}

export function parseTrip(body: unknown): Parsed<string> {
  const errors: Record<string, string> = {};
  if (!isObj(body)) return { ok: false, errors: { body: "JSON object required" } };
  strictKeys(body, ["linehaul_trip_no"], errors);
  const v = typeof body.linehaul_trip_no === "string" ? body.linehaul_trip_no.trim() : "";
  if (!TRIP.test(v)) errors.linehaul_trip_no = "1-50 letters, digits or . _ / -";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: v };
}

export function parseBulkIds(body: unknown): Parsed<string[]> {
  if (!isObj(body)) return { ok: false, errors: { body: "JSON object required" } };
  const errors: Record<string, string> = {};
  strictKeys(body, ["ids"], errors);
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length < 3 || ids.length > 100) errors.ids = "3-100 ids required";
  else if (!ids.every(isUuid)) errors.ids = "all ids must be uuids";
  else if (new Set(ids).size !== ids.length) errors.ids = "ids must be distinct";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: ids as string[] };
}
