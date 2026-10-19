// Environment -> auth services. SeaTalk login is optional (needs the app credentials); everything else needs only
// the Supabase configuration. Secrets stay in the environment of the server process.
import { createRateLimiter } from "../rate-limit.ts";
import { createSeaTalkLogin, DEFAULT_SEATALK_PATHS } from "../seatalk/provider.ts";
import type { Rest } from "../supabase/rest.ts";
import type { AuthServices } from "./handlers.ts";
import { createGoTrue } from "./gotrue.ts";
import { SupabaseUsers } from "./users.ts";

export function authFromEnv(env: NodeJS.ProcessEnv, cfg: { url: string; anonKey: string; serviceKey: string }, rest: Rest): AuthServices | null {
  const webOrigin = env.SOC5_WEB_ORIGIN;
  const stateSecret = env.SOC5_AUTH_STATE_SECRET;
  if (!webOrigin || !stateSecret || stateSecret.length < 32) return null; // sign-in flows stay off until configured
  const appId = env.SOC5_SEATALK_APP_ID;
  const appSecret = env.SOC5_SEATALK_APP_SECRET;
  const redirect = env.SOC5_SEATALK_LOGIN_REDIRECT_URI;
  return {
    gotrue: createGoTrue(cfg),
    users: new SupabaseUsers(rest),
    webOrigin: webOrigin.replace(/\/$/, ""),
    stateSecret,
    ...(appId && appSecret && redirect
      ? {
          seatalk: {
            appId,
            redirectUri: redirect,
            sdkUrl: env.SOC5_SEATALK_SDK_URL ?? "https://static.cdn.haiserve.com/seatalk/client/shared/sop/auth.js",
            login: createSeaTalkLogin({ appId, appSecret, ...DEFAULT_SEATALK_PATHS, baseUrl: env.SOC5_SEATALK_BASE_URL ?? DEFAULT_SEATALK_PATHS.baseUrl, timeoutMs: 10_000 }),
          },
        }
      : {}),
    limiters: {
      backroomIp: createRateLimiter({ limit: 20, windowMs: 60_000 }),
      backroomOps: createRateLimiter({ limit: 5, windowMs: 60_000 }),
      otpIp: createRateLimiter({ limit: 10, windowMs: 60_000 }),
      otpEmail: createRateLimiter({ limit: 1, windowMs: 60_000 }),
      access: createRateLimiter({ limit: 3, windowMs: 10 * 60_000 }),
    },
  };
}
