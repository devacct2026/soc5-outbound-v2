// SeaTalk Open Platform client: app access token, Approval Center create/get item.
//
// CONTRACT PROVENANCE (SEA-2, no invented endpoints):
//  * create item  POST {base}/approval_center/v2/create  - OFFICIAL (docs/seatalk-integration/seatalk-approval/create_approval_item.md,
//                  vendored from open.seatalk.io); payload field names, limits and `{code}` response as documented.
//  * get item     GET  {base}/approval_center/v2/get?item_id=  - OFFICIAL path; the page shows a JSON sample for a GET, the
//                  query-string form is what the original (working) integration used. LIVE-UNVERIFIED.
//  * app token    POST {base}/auth/app_access_token {app_id, app_secret} -> {code, app_access_token, expire_in}. Referenced by the
//                  official pages as "Get App Access Token"; its own page is not vendored, so request/response field names come
//                  from the original integration's notes. LIVE-UNVERIFIED.
//  * error codes  The official error-code table is not available: any non-zero `code` is treated as a provider rejection.
// Nothing here has run against a SeaTalk tenant. Secrets never leave this module (never logged, never in errors).
import { createHmac } from "node:crypto";

export type ProviderCategory = "AUTHENTICATION" | "PERMISSION" | "VALIDATION" | "RATE_LIMIT" | "TRANSIENT" | "DISABLED";

export class SeaTalkProviderError extends Error {
  category: ProviderCategory;
  constructor(category: ProviderCategory, message: string) {
    super(`seatalk ${category}: ${message}`);
    this.category = category;
  }
  get retryable() {
    return this.category === "TRANSIENT" || this.category === "RATE_LIMIT" || this.category === "AUTHENTICATION";
  }
}

export interface SeaTalkConfig {
  appId: string;
  appSecret: string;
  baseUrl: string; // https://openapi.seatalk.io
  tokenPath: string; // /auth/app_access_token
  createPath: string; // /approval_center/v2/create
  getPath: string; // /approval_center/v2/get
  timeoutMs: number;
}
export const DEFAULT_SEATALK_PATHS = {
  baseUrl: "https://openapi.seatalk.io",
  tokenPath: "/auth/app_access_token",
  createPath: "/approval_center/v2/create",
  getPath: "/approval_center/v2/get",
};

/** Item state labels used by the official `status.state` field (0 pending, 1 approved, 2 rejected, 3 terminated, 4 cancelled). */
export type ItemState = 0 | 1 | 2 | 4;
const STATE_TEXT: Record<ItemState, string> = { 0: "Pending", 1: "Approved", 2: "Rejected", 4: "Cancelled" };

export interface ApprovalItemInput {
  itemId: string; // <= 30 chars
  applicantName: string;
  title: string;
  subtitle?: string;
  description?: string;
  createdAtSec: number;
  updatedAtSec: number;
  state: ItemState;
  approveUrl: string;
  rejectUrl: string;
  pending: { employeeCode: string; ts: number }[];
  approved: { employeeCode: string; ts: number }[];
  rejected: { employeeCode: string; ts: number }[];
  chain: { employeeCode: string; actionTime: number; state: 0 | 1 | 2 | 3 | 4; comment?: string }[];
}

const clip = (s: string, n: number) => Array.from(s).slice(0, n).join("");
const text = (s: string, n: number) => ({ en: clip(s, n) });

/** Build the official create-item body. Throws on contract violations rather than sending a request the provider would reject. */
export function buildCreateBody(i: ApprovalItemInput): Record<string, unknown> {
  if (!i.itemId || Array.from(i.itemId).length > 30) throw new SeaTalkProviderError("VALIDATION", "item_id must be 1-30 characters");
  if (!i.applicantName.trim()) throw new SeaTalkProviderError("VALIDATION", "applicant_name is required");
  for (const u of [i.approveUrl, i.rejectUrl]) {
    if (u.length > 500 || !/^https:\/\//.test(u)) throw new SeaTalkProviderError("VALIDATION", "callback urls must be https and <= 500 chars");
  }
  const lists = [i.pending, i.approved, i.rejected, i.chain];
  if (lists.some((l) => l.length > 100)) throw new SeaTalkProviderError("VALIDATION", "lists are limited to 100 entries");
  return {
    item_id: i.itemId,
    created_at: i.createdAtSec,
    updated_at: i.updatedAtSec,
    applicant_name: clip(i.applicantName, 50),
    has_attachments: false,
    item_name: text("Truck request", 50),
    item_state: text(STATE_TEXT[i.state], 20),
    title: text(i.title, 100),
    ...(i.subtitle ? { subtitle: text(i.subtitle, 100) } : {}),
    ...(i.description ? { description: text(i.description, 500) } : {}),
    approval_chain: {
      approvers: i.chain.map((a) => ({
        employee_code: a.employeeCode,
        action_time: a.actionTime,
        status: { state: a.state },
        ...(a.comment ? { comment: clip(a.comment, 500) } : {}),
      })),
    },
    status: { state: i.state, text: text(STATE_TEXT[i.state], 50) },
    action_button: 1, // Approve + Reject + Snooze directly in the list
    approve_url: i.approveUrl,
    reject_url: i.rejectUrl,
    pending_list: i.pending.map((p) => ({ employee_code: p.employeeCode, ts: p.ts })),
    approved_list: i.approved.map((p) => ({ employee_code: p.employeeCode, ts: p.ts })),
    rejected_list: i.rejected.map((p) => ({ employee_code: p.employeeCode, ts: p.ts })),
  };
}

export interface ProviderItem {
  itemId: string;
  state: number;
  approved: { employeeCode: string; ts: number }[];
  rejected: { employeeCode: string; ts: number }[];
  /** Approver comments by employee code (rejection reasons), when SeaTalk returns them. */
  comments: Record<string, string>;
}

export interface ApprovalProvider {
  createItem(input: ApprovalItemInput): Promise<void>;
  getItem(itemId: string): Promise<ProviderItem>;
}

export const disabledApprovalProvider: ApprovalProvider = {
  async createItem() {
    throw new SeaTalkProviderError("DISABLED", "provider not configured");
  },
  async getItem() {
    throw new SeaTalkProviderError("DISABLED", "provider not configured");
  },
};

function classify(status: number): ProviderCategory {
  if (status === 401) return "AUTHENTICATION";
  if (status === 403) return "PERMISSION";
  if (status === 429) return "RATE_LIMIT";
  if (status >= 500) return "TRANSIENT";
  return "VALIDATION";
}

type Authed = (method: "GET" | "POST", path: string, opts: { body?: unknown; query?: Record<string, string> }) => Promise<Record<string, unknown>>;

/** Shared HTTP core: app access token (cached, one transparent refresh on 401), timeouts, error classification. */
function makeAuthedCaller(cfg: SeaTalkConfig, fetchImpl: typeof fetch, now: () => Date): Authed {
  const base = cfg.baseUrl.replace(/\/$/, "");
  let cached: { token: string; until: number } | null = null;

  async function call(method: "GET" | "POST", path: string, opts: { body?: unknown; query?: Record<string, string>; token?: string }) {
    const qs = opts.query ? `?${new URLSearchParams(opts.query)}` : "";
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}${qs}`, {
        method,
        headers: {
          accept: "application/json",
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(cfg.timeoutMs),
        cache: "no-store",
      });
    } catch {
      throw new SeaTalkProviderError("TRANSIENT", "network error or timeout"); // never include the URL/credentials
    }
    if (!res.ok) throw new SeaTalkProviderError(classify(res.status), `HTTP ${res.status}`);
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new SeaTalkProviderError("TRANSIENT", "non-JSON response");
    }
    if (!data || typeof data !== "object") throw new SeaTalkProviderError("TRANSIENT", "empty response");
    const code = (data as { code?: unknown }).code;
    if (code !== undefined && code !== 0) throw new SeaTalkProviderError("VALIDATION", `provider code ${String(code)}`);
    return data as Record<string, unknown>;
  }

  async function token(force = false): Promise<string> {
    if (!force && cached && cached.until > now().getTime()) return cached.token;
    const r = await call("POST", cfg.tokenPath, { body: { app_id: cfg.appId, app_secret: cfg.appSecret } });
    const t = r.app_access_token;
    if (typeof t !== "string" || !t) throw new SeaTalkProviderError("AUTHENTICATION", "no access token in response");
    const ttl = typeof r.expire_in === "number" && r.expire_in > 60 ? r.expire_in : 3600;
    cached = { token: t, until: now().getTime() + (ttl - 60) * 1000 };
    return t;
  }

  return async (method, path, opts) => {
    try {
      return await call(method, path, { ...opts, token: await token() });
    } catch (e) {
      if (e instanceof SeaTalkProviderError && e.category === "AUTHENTICATION") {
        cached = null;
        return call(method, path, { ...opts, token: await token(true) });
      }
      throw e;
    }
  };
}

export function createSeaTalkProvider(
  cfg: SeaTalkConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): ApprovalProvider {
  const authed = makeAuthedCaller(cfg, fetchImpl, now);
  return {
    async createItem(input) {
      await authed("POST", cfg.createPath, { body: buildCreateBody(input) });
    },
    async getItem(itemId) {
      const r = await authed("GET", cfg.getPath, { query: { item_id: itemId } });
      const item = r.item as Record<string, unknown> | undefined;
      if (!item || typeof item !== "object") throw new SeaTalkProviderError("TRANSIENT", "item missing in response");
      const list = (v: unknown) =>
        Array.isArray(v)
          ? v.flatMap((x) => {
              const o = x as { employee_code?: unknown; ts?: unknown };
              return typeof o?.employee_code === "string" ? [{ employeeCode: o.employee_code, ts: Number(o.ts ?? 0) }] : [];
            })
          : [];
      const comments: Record<string, string> = {};
      const chain = (item.approval_chain as { approvers?: unknown } | undefined)?.approvers;
      if (Array.isArray(chain)) {
        for (const a of chain as { employee_code?: unknown; comment?: unknown }[]) {
          if (typeof a?.employee_code === "string" && typeof a.comment === "string" && a.comment) comments[a.employee_code] = a.comment;
        }
      }
      return {
        itemId,
        state: Number((item.status as { state?: unknown } | undefined)?.state ?? -1),
        approved: list(item.approved_list),
        rejected: list(item.rejected_list),
        comments,
      };
    },
  };
}

// ----------------------------------------------------------- Login with SeaTalk (OFFICIAL contract)
export interface SeaTalkEmployee {
  employeeCode: string;
  name: string;
  email: string;
}
export interface SeaTalkLogin {
  /** GET {base}/open_login/code2employee?code=  (vendored official page: verify_login_with_seatalk_code.md). */
  codeToEmployee(code: string): Promise<SeaTalkEmployee>;
}
export function createSeaTalkLogin(cfg: SeaTalkConfig, fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()): SeaTalkLogin {
  const authed = makeAuthedCaller(cfg, fetchImpl, now);
  return {
    async codeToEmployee(code) {
      const r = await authed("GET", "/open_login/code2employee", { query: { code } });
      const e = r.employee as { employee_code?: unknown; name?: unknown; email?: unknown } | undefined;
      if (!e || typeof e.employee_code !== "string" || !e.employee_code || typeof e.email !== "string") {
        throw new SeaTalkProviderError("VALIDATION", "employee missing in response");
      }
      return { employeeCode: e.employee_code, name: typeof e.name === "string" ? e.name : "", email: e.email.trim().toLowerCase() };
    },
  };
}

// --------------------------------------------------------------- callback tokens
/** Per-assignment one-time secret: HMAC(secret, assignmentId). Only its SHA-256 is stored. */
export const approvalToken = (secret: string, assignmentId: string) =>
  createHmac("sha256", secret).update(assignmentId).digest("hex");

/** item ids are <= 30 chars: `a_` + 28 hex characters of the assignment id (unique per assignment). */
export const itemIdFor = (assignmentId: string) => `a_${assignmentId.replace(/-/g, "").slice(0, 28)}`;
