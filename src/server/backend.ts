// Backend wiring. getBackend() returns null (-> 503) until Supabase env is
// configured; tests construct a Backend directly with MemoryStore.
import type { Actor } from "../domain/requests/workflow.ts";
import type { RequestRecord } from "../domain/requests/lifecycle.ts";
import { DEFAULT_FEATURES, type Features } from "./commands.ts";
import type { Store } from "./store.ts";
import type { AdminPort } from "./admin.ts";
import type { SeatalkWiring } from "./seatalk/callback.ts";

/**
 * SEA-1: approval must go through the SeaTalk Approval Center. There is no
 * internal bypass: the default gate refuses every web approval until the
 * provider contract is verified in a sandbox (SEA-2) and the feature enabled.
 */
export interface ApprovalGate {
  authorizeWebApproval(actor: Actor, request: RequestRecord): Promise<{ ok: true } | { ok: false; code: "APPROVAL_PROVIDER_DISABLED" | "FORBIDDEN" }>;
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
  /** Shared secret for the Google Apps Script intraday sync (server-only). */
  intradaySecret?: string;
  /** Present only when a signature secret is configured; still gated by features.seatalkApproval. */
  seatalk?: SeatalkWiring;
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
  const { createSupabaseBackend } = await import("./supabase/backend.ts");
  const flag = (n: string) => process.env[n] === "true";
  cached = createSupabaseBackend({ url, anonKey: anon, serviceKey: service }, {
    features: { seatalkApproval: flag("SOC5_FEATURE_SEATALK_APPROVAL"), seatalkAlerts: flag("SOC5_FEATURE_SEATALK_ALERTS"), googleSheets: flag("SOC5_FEATURE_GOOGLE_SHEETS") },
    seatalkSecret: process.env.SOC5_SEATALK_CALLBACK_SECRET,
    seatalkMaxSkewSeconds: Number(process.env.SOC5_SEATALK_CALLBACK_MAX_SKEW_SECONDS ?? 300),
  });
  return cached;
}
