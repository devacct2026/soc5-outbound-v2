// Backend wiring. getBackend() returns null (-> 503) until Supabase env is
// configured; tests construct a Backend directly with MemoryStore.
import type { Actor } from "../domain/requests/workflow.ts";
import type { RequestRecord } from "../domain/requests/lifecycle.ts";
import { DEFAULT_FEATURES, type Features } from "./commands.ts";
import type { Store } from "./store.ts";
import type { AdminPort } from "./admin.ts";
import type { SeatalkWiring } from "./seatalk/callback.ts";
import type { ApprovalCoordinator } from "./seatalk/approvals.ts";
import type { ApprovalStore } from "./seatalk/contract.ts";
import { createRateLimiter, type RateLimiter } from "./rate-limit.ts";

/**
 * SEA-1: approval must go through the SeaTalk Approval Center. There is no
 * internal bypass: the default gate refuses every web approval until the
 * provider contract is verified in a sandbox (SEA-2) and the feature enabled.
 */
export type GateFailure =
  | "APPROVAL_PROVIDER_DISABLED"
  | "FORBIDDEN"
  | "NOT_ASSIGNED_APPROVER"
  | "NOT_APPROVED_IN_SEATALK"
  | "PROVIDER_UNAVAILABLE";
export type GateResult =
  | { ok: true; /** Where the decision came from; a verified SeaTalk decision is recorded as SEATALK. */ source?: "WEB" | "SEATALK"; applied?: () => Promise<void> }
  | { ok: false; code: GateFailure };
export interface ApprovalGate {
  authorizeWebApproval(actor: Actor, request: RequestRecord): Promise<GateResult>;
}

/**
 * SEA-1/SEA-5: "approving" in the web UI is only the application of a decision SeaTalk has already recorded.
 * It requires the caller to hold the open assignment and the provider to report the item approved by that
 * same employee. A provider outage leaves the request pending; nothing is ever approved locally.
 */
export function createSeatalkApprovalGate(coordinator: ApprovalCoordinator, approvals: ApprovalStore): ApprovalGate {
  return {
    async authorizeWebApproval(actor, request) {
      const v = await coordinator.verifyWebApproval(actor, request.id);
      if (!v.ok) return { ok: false, code: v.code };
      return { ok: true, source: "SEATALK", applied: () => approvals.closeAssignment(v.assignment.id, "APPROVED") };
    },
  };
}
export const disabledApprovalGate: ApprovalGate = {
  async authorizeWebApproval() {
    return { ok: false, code: "APPROVAL_PROVIDER_DISABLED" };
  },
};

/** HUB-4: strong identity verification for administrator overrides (unconfigured => denied). */
export interface IdentityVerifier {
  verifyStrongIdentity(actor: Actor, request: Request): Promise<boolean>;
}
export const denyIdentityVerifier: IdentityVerifier = { verifyStrongIdentity: async () => false };

export interface Backend {
  store: Store;
  /** Validate the bearer token and load the CURRENT active profile; null if denied. */
  authenticate(request: Request): Promise<Actor | null>;
  features: Features;
  approvalGate: ApprovalGate;
  identity: IdentityVerifier;
  now: () => Date;
  admin?: AdminPort;
  /** Per-actor budget for authenticated calls (optional; off in tests). */
  actorLimiter?: RateLimiter;
  /** Per-address budget applied BEFORE authentication to blunt token guessing. */
  anonLimiter?: RateLimiter;
  /** Shared secret for the Google Apps Script intraday sync (server-only). */
  intradaySecret?: string;
  /** Shared secret for the Google Apps Script cluster sync (server-only). */
  clusterSyncSecret?: string;
  /** Present only when a signature secret is configured; still gated by features.seatalkApproval. */
  seatalk?: SeatalkWiring;
  /** Presence/routing/provisioning (present when the SeaTalk provider is configured). */
  approvals?: ApprovalCoordinator;
  /** A heartbeat counts as "present" for this long (SEA-6 sandbox default 60 s). */
  presenceActiveSeconds?: number;
}

export function makeBackend(
  parts: Pick<Backend, "store" | "authenticate"> & Partial<Omit<Backend, "store" | "authenticate">>,
): Backend {
  return {
    features: DEFAULT_FEATURES,
    approvalGate: disabledApprovalGate,
    identity: denyIdentityVerifier,
    now: () => new Date(),
    ...parts,
  };
}

/** Parse a positive number from config; anything else falls back to the default. */
export function positiveNumber(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n > 0 ? n : dflt;
}

let cached: Backend | null | undefined;

export async function getBackend(): Promise<Backend | null> {
  if (cached !== undefined) return cached;
  const url = process.env.SOC5_SUPABASE_URL;
  const anon = process.env.SOC5_SUPABASE_ANON_KEY;
  const service = process.env.SOC5_SUPABASE_SERVICE_ROLE_KEY; // server-only; never NEXT_PUBLIC_
  if (!url || !anon || !service) {
    cached = null;
    return cached;
  }
  const { createSupabaseBackend, SupabaseStore } = await import("./supabase/backend.ts");
  const { Rest } = await import("./supabase/rest.ts");
  const { approvalCoordinatorFromEnv } = await import("./seatalk/wiring.ts");
  const rest = new Rest({ url, serviceKey: service });
  const approvals = approvalCoordinatorFromEnv(process.env, rest, new SupabaseStore(rest)) ?? undefined;
  const flag = (n: string) => process.env[n] === "true";
  const perMinute = (name: string, dflt: number) => createRateLimiter({ limit: positiveNumber(process.env[name], dflt), windowMs: 60_000 });
  cached = createSupabaseBackend({ url, anonKey: anon, serviceKey: service }, {
    actorLimiter: perMinute("SOC5_RATE_LIMIT_ACTOR_PER_MIN", 300),
    anonLimiter: perMinute("SOC5_RATE_LIMIT_ANON_PER_MIN", 60),
    features: { seatalkApproval: flag("SOC5_FEATURE_SEATALK_APPROVAL"), seatalkAlerts: flag("SOC5_FEATURE_SEATALK_ALERTS"), googleSheets: flag("SOC5_FEATURE_GOOGLE_SHEETS") },
    seatalkSecret: process.env.SOC5_SEATALK_CALLBACK_SECRET,
    seatalkEventSecret: process.env.SOC5_SEATALK_SIGNING_SECRET,
    approvals,
    presenceActiveSeconds: positiveNumber(process.env.SOC5_PRESENCE_ACTIVE_SECONDS, 60),
    seatalkMaxSkewSeconds: positiveNumber(process.env.SOC5_SEATALK_CALLBACK_MAX_SKEW_SECONDS, 300),
  });
  return cached;
}
