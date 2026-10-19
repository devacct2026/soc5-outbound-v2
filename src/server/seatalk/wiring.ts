// Environment -> SeaTalk wiring, shared by the API process and the worker. Returns null (and never throws)
// when the provider is not fully configured, so a disabled provider is visible as missing capability
// rather than half-working. Secrets are read only here and never logged.
import type { Rest } from "../supabase/rest.ts";
import { positiveNumber } from "../backend.ts";
import { ApprovalCoordinator, type RequestReader } from "./approvals.ts";
import { SupabaseApprovalPort } from "./approvals-ports.ts";
import { createSeaTalkProvider, DEFAULT_SEATALK_PATHS } from "./provider.ts";

export function approvalCoordinatorFromEnv(env: NodeJS.ProcessEnv, rest: Rest, requests: RequestReader): ApprovalCoordinator | null {
  const appId = env.SOC5_SEATALK_APP_ID;
  const appSecret = env.SOC5_SEATALK_APP_SECRET;
  const tokenSecret = env.SOC5_SEATALK_APPROVAL_TOKEN_SECRET;
  const approveUrl = env.SOC5_SEATALK_APPROVE_CALLBACK_URL;
  const rejectUrl = env.SOC5_SEATALK_REJECT_CALLBACK_URL;
  if (!appId || !appSecret || !tokenSecret || tokenSecret.length < 32 || !approveUrl || !rejectUrl) return null;
  const provider = createSeaTalkProvider({
    appId,
    appSecret,
    baseUrl: env.SOC5_SEATALK_BASE_URL ?? DEFAULT_SEATALK_PATHS.baseUrl,
    tokenPath: DEFAULT_SEATALK_PATHS.tokenPath,
    createPath: DEFAULT_SEATALK_PATHS.createPath,
    getPath: DEFAULT_SEATALK_PATHS.getPath,
    timeoutMs: positiveNumber(env.SOC5_SEATALK_TIMEOUT_MS, 10_000),
  });
  return new ApprovalCoordinator({
    port: new SupabaseApprovalPort(rest),
    provider,
    requests,
    config: {
      tokenSecret,
      approveUrl,
      rejectUrl,
      syncMode: env.SOC5_SEATALK_SYNC_MODE === "recreate" ? "recreate" : "off",
      retrySeconds: positiveNumber(env.SOC5_SEATALK_DELIVERY_RETRY_SECONDS, 300),
    },
  });
}
