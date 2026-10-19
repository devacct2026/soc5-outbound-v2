// Framework-neutral route table: the single source of truth for the HTTP surface
// served by the NestJS API (src/nest) and mirrored by the Next.js route wrappers.
import * as api from "./api.ts";
import * as admin from "./admin.ts";
import { approveCallback, challengeCallback, rejectCallback } from "./seatalk/routes.ts";
import { intradaySyncHandler } from "./intraday-sync.ts";
import { clusterSyncHandler } from "./cluster-sync.ts";
import { loginHandler } from "./login.ts";
import * as authFlows from "./auth/handlers.ts";
import type { Backend } from "./backend.ts";

export type RouteHandler = (backend: Backend | null, request: Request, params?: Record<string, string>) => Promise<Response>;

interface Route {
  method: string;
  /** Path relative to /api/v1 with :param segments. Static segments win over params. */
  path: string;
  handler: RouteHandler;
}

export const ROUTES: Route[] = [
  { method: "GET", path: "requests", handler: api.listHandler },
  { method: "POST", path: "requests", handler: api.createRequestHandler },
  { method: "GET", path: "requests/queue", handler: api.queueHandler },
  { method: "GET", path: "requests/metrics", handler: api.metricsHandler },
  { method: "POST", path: "requests/bulk-approve", handler: api.bulkApproveHandler },
  { method: "GET", path: "requests/:id", handler: api.getRequestHandler },
  { method: "PUT", path: "requests/:id", handler: api.updateRequestHandler },
  { method: "GET", path: "requests/:id/events", handler: api.eventsHandler },
  { method: "POST", path: "requests/:id/:action", handler: api.actionHandler },
  { method: "GET", path: "notifications", handler: api.notificationsHandler },
  { method: "PATCH", path: "notifications/read-all", handler: api.markAllReadHandler },
  { method: "PATCH", path: "notifications/:id/read", handler: api.markReadHandler },
  { method: "GET", path: "clusters", handler: api.clustersHandler },
  { method: "GET", path: "dispatch/intraday", handler: api.intradayHandler },
  { method: "GET", path: "kpi/summary", handler: api.kpiSummaryHandler },
  { method: "GET", path: "kpi/daily", handler: api.kpiDailyHandler },
  { method: "GET", path: "kpi/hourly", handler: api.kpiHourlyHandler },
  { method: "GET", path: "kpi/export", handler: api.kpiExportHandler },
  { method: "GET", path: "auth/me", handler: api.meHandler },
  { method: "POST", path: "presence/heartbeat", handler: api.heartbeatHandler },
  { method: "GET", path: "auth/status", handler: authFlows.accountStatusHandler },
  { method: "POST", path: "auth/backroom/login", handler: authFlows.backroomLoginHandler },
  { method: "POST", path: "auth/otp/request", handler: authFlows.otpRequestHandler },
  { method: "POST", path: "auth/otp/verify", handler: authFlows.otpVerifyHandler },
  { method: "GET", path: "auth/google/start", handler: authFlows.googleStartHandler },
  { method: "GET", path: "auth/seatalk/config", handler: authFlows.seatalkConfigHandler },
  { method: "GET", path: "auth/seatalk/callback", handler: authFlows.seatalkCallbackHandler },
  { method: "POST", path: "auth/password-changed", handler: authFlows.passwordChangedHandler },
  { method: "POST", path: "access-requests", handler: authFlows.accessRequestHandler },
  { method: "GET", path: "users", handler: authFlows.listUsersHandler },
  { method: "POST", path: "users", handler: authFlows.createUserHandler },
  { method: "PUT", path: "users/:id", handler: authFlows.updateUserHandler },
  { method: "PATCH", path: "users/:id/disable", handler: authFlows.disableUserHandler },
  { method: "POST", path: "users/:id/reset-password", handler: authFlows.resetPasswordHandler },
  { method: "POST", path: "auth/login", handler: loginHandler },
  { method: "GET", path: "operations/outbox/status", handler: admin.outboxStatusHandler },
  { method: "POST", path: "operations/outbox/:id/:action", handler: admin.outboxActionHandler },
  { method: "POST", path: "admin/accounts/:id/approve", handler: admin.approveAccountHandler },
  { method: "POST", path: "admin/accounts/:id/disable", handler: admin.disableAccountHandler },
  { method: "POST", path: "integrations/seatalk/approval/approve", handler: approveCallback },
  { method: "POST", path: "integrations/seatalk/approval/reject", handler: rejectCallback },
  { method: "POST", path: "integrations/seatalk/events", handler: challengeCallback },
  { method: "POST", path: "integrations/intraday/sync", handler: intradaySyncHandler },
  { method: "POST", path: "integrations/clusters/sync", handler: clusterSyncHandler },
];

export type Match =
  | { kind: "ok"; handler: RouteHandler; params: Record<string, string> }
  | { kind: "method-not-allowed" }
  | { kind: "not-found" };

/** Match with static-before-param precedence (so `requests/queue` never binds `:id`). */
export function matchRoute(method: string, path: string): Match {
  const segs = path.replace(/^\/+|\/+$/g, "").split("/");
  let pathMatched = false;
  let best: { route: Route; params: Record<string, string>; statics: number } | null = null;
  for (const route of ROUTES) {
    const parts = route.path.split("/");
    if (parts.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let statics = 0;
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(":")) {
        let v: string;
        try {
          v = decodeURIComponent(segs[i]);
        } catch {
          ok = false;
          break;
        }
        params[parts[i].slice(1)] = v;
      } else if (parts[i] === segs[i]) statics++;
      else {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    pathMatched = true;
    if (route.method !== method.toUpperCase()) continue;
    if (!best || statics > best.statics) best = { route, params, statics };
  }
  if (best) return { kind: "ok", handler: best.route.handler, params: best.params };
  return pathMatched ? { kind: "method-not-allowed" } : { kind: "not-found" };
}

/** Dispatch a Fetch-API request through the route table (used by the NestJS controller and tests). */
export async function dispatch(backend: Backend | null, request: Request, basePath = "/api/v1"): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${basePath}/`)) return notFound();
  const m = matchRoute(request.method, url.pathname.slice(basePath.length));
  if (m.kind === "not-found") return notFound();
  if (m.kind === "method-not-allowed") return new Response(JSON.stringify({ error: "METHOD_NOT_ALLOWED" }), { status: 405, headers: { "content-type": "application/json" } });
  return m.handler(backend, request, m.params);
}

const notFound = () => new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } });
