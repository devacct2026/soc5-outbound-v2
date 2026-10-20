// Pure view helpers for the request screens. The server remains the authority for every rule below (role, state,
// ownership); these only decide which buttons to OFFER, mirroring src/domain/requests/lifecycle.ts.
export type Role = "ops_pic" | "fte_ops" | "fte_mm" | "doc_officer";

export interface RowRequest {
  id: string;
  status: string;
  display_status?: string;
  created_by: string;
  driver_id: string | null;
  plate_number?: string | null;
  rejection_disposition: string | null;
  next_action_role?: Role | null;
}
export interface Me {
  id: string;
  role: Role;
  is_admin?: boolean;
  reporting_permission?: boolean;
  must_change_password?: boolean;
}

export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export const TRUCK_SIZES = ["4W", "4WAUV", "4WCV", "6W", "10W", "6WF"] as const;
export const TRUCK_TYPES = ["WETLEASE", "DRYLEASE"] as const;
export const STATUS_FILTERS = ["PENDING", "REROUTED", "REQUESTED", "REJECTED", "CANCELLED", "DOCKING", "DOCKED"] as const;

export const reqCode = (id: string) => `REQ-${id.slice(0, 8).toUpperCase()}`;

const TZ = "Asia/Manila";
/** e.g. "Oct 19, 2026, 6:30 PM" in the business timezone; "—" when absent or invalid. */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/** <input type="datetime-local"> value (business-time wall clock) for an ISO instant. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(d).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export function canEdit(me: Me, r: RowRequest): boolean {
  if (r.status === "PENDING" || r.status === "REROUTED") return me.role === "fte_ops";
  if (r.status === "DOCKED") return me.role === "ops_pic" && r.created_by === me.id;
  if (r.status === "REJECTED") {
    if (r.rejection_disposition === "RETURN_TO_OPS_PIC") return me.role === "ops_pic" && r.created_by === me.id;
    if (r.rejection_disposition === "RETURN_TO_FTE_OPS") return me.role === "fte_ops";
  }
  return false; // FINAL_NO_ROUTE and LEGACY_UNRESOLVED are never editable or resubmittable
}

export const editLabel = (r: RowRequest) => (r.status === "REJECTED" ? "Correct & resubmit" : r.status === "DOCKED" ? "Edit after docking" : "Edit");

export function canCancel(me: Me, r: RowRequest): boolean {
  const pre = r.status === "PENDING" || r.status === "REROUTED";
  switch (me.role) {
    case "ops_pic":
      return r.created_by === me.id && (pre || (r.status === "REJECTED" && r.rejection_disposition === "RETURN_TO_OPS_PIC"));
    case "fte_ops":
      return pre || (r.status === "REJECTED" && r.rejection_disposition === "RETURN_TO_FTE_OPS");
    case "fte_mm":
      return r.status === "REQUESTED";
    default:
      return false;
  }
}

export const cancelNeedsRemarks = (me: Me) => me.role === "fte_mm";

/** Only a request that already has a driver can be printed (the label carries the driver QR/ID). */
export const canPrint = (r: RowRequest) => !!r.driver_id && !!r.plate_number;

export const canBulkSelect = (me: Me, r: RowRequest) => me.role === "fte_ops" && (r.status === "PENDING" || r.status === "REROUTED");
export const canAssignDriver = (me: Me, r: RowRequest) => me.role === "doc_officer" && r.status === "DOCKING" && !r.driver_id;

export type QueueAction = "approve" | "reject" | "assign-truck" | "assign-driver" | "reassign-driver" | "dock";

export function queueActions(me: Me, r: RowRequest): QueueAction[] {
  switch (r.status) {
    case "PENDING":
    case "REROUTED":
      return me.role === "fte_ops" ? ["approve", "reject"] : [];
    case "REQUESTED":
      return me.role === "fte_mm" ? ["assign-truck", "reject"] : [];
    case "DOCKING":
      if (me.role === "doc_officer") return r.driver_id ? ["reassign-driver"] : ["assign-driver"];
      if (me.role === "ops_pic" && r.driver_id && r.created_by === me.id) return ["dock"];
      return [];
    default:
      return [];
  }
}

/** Label template: one load = single, two = co-load, three or more = tri-load (extra loads are not printed). */
export type LabelKind = "single" | "coload" | "triload";
export const labelLoads = (cluster: string) => cluster.split(",").map((s) => s.trim()).filter(Boolean);
export const labelKind = (loads: number): LabelKind => (loads <= 1 ? "single" : loads === 2 ? "coload" : "triload");

export interface ListFilters {
  status: string;
  search: string;
  dateFrom: string;
  dateTo: string;
}

/** Query string for GET /requests; empty filters are omitted. The server validates every value. */
export function listQuery(f: ListFilters, limit: number, cursor: string | null): string {
  const p = new URLSearchParams({ limit: String(limit) });
  if (cursor) p.set("cursor", cursor);
  if (f.status) p.set("status", f.status);
  if (f.search.trim()) p.set("search", f.search.trim());
  if (f.dateFrom) p.set("date_from", f.dateFrom);
  if (f.dateTo) p.set("date_to", f.dateTo);
  return p.toString();
}

/** Cursor-stack pagination state (previous pages are revisited from their stored cursor, never guessed). */
export interface Pager {
  cursors: (string | null)[]; // cursors[i] is the cursor that loads page i
  index: number;
}
export const firstPage = (): Pager => ({ cursors: [null], index: 0 });
export const nextPager = (p: Pager, next: string | null): Pager =>
  next ? { cursors: [...p.cursors.slice(0, p.index + 1), next], index: p.index + 1 } : p;
export const prevPager = (p: Pager): Pager => ({ ...p, index: Math.max(0, p.index - 1) });
