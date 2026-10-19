// Administrator operations: outbox monitoring/replay/abandon (NOT-5), account
// approval (SEA-7), account disable with immediate revocation (OPS-3). All
// require a server-side admin flag, a reason, and write immutable audit.
import { isUuid } from "../domain/requests/validation.ts";
import { isAdmin } from "../domain/permissions.ts";
import { OPERATIONAL_ROLES } from "../domain/permissions.ts";
import type { Role } from "../domain/requests/workflow.ts";
import type { Backend } from "./backend.ts";
import { json } from "./api.ts";
import { errorResponse } from "./commands.ts";
import type { OutboxStats } from "./worker/outbox-worker.ts";

export interface AdminPort {
  outboxStats(now: Date): Promise<OutboxStats>;
  outboxAction(actorId: string, id: string, action: "RETRY" | "ABANDON", reason: string): Promise<{ ok: true } | { ok: false; code: string }>;
  approveAccount(actorId: string, userId: string, role: Role, reason: string): Promise<{ ok: true } | { ok: false; code: string }>;
  disableAccount(actorId: string, userId: string, reason: string): Promise<{ ok: true } | { ok: false; code: string }>;
}

type Params = Record<string, string> | undefined;
type AdminBackend = Backend;

const send = (code: string, details?: unknown) => {
  const r = errorResponse(code, details);
  return json(r.status, r.body);
};
const STATUS: Record<string, string> = {
  FORBIDDEN: "FORBIDDEN", NOT_FOUND: "NOT_FOUND", INVALID_STATE: "INVALID_STATE",
  REASON_REQUIRED: "VALIDATION_FAILED", INVALID_ACTION: "VALIDATION_FAILED",
};

async function adminCtx(backend: AdminBackend | null, request: Request) {
  if (!backend?.admin) return { res: send("BACKEND_NOT_CONFIGURED") };
  const actor = await backend.authenticate(request);
  if (!actor || !actor.active) return { res: send("UNAUTHENTICATED") };
  if (!isAdmin(actor)) return { res: send("FORBIDDEN") };
  return { backend, admin: backend.admin, actor };
}

async function readReason(request: Request, extra: string[] = []): Promise<{ reason: string; body: Record<string, unknown> } | Response> {
  const key = request.headers.get("idempotency-key");
  if (!key || key.length < 8) return send("IDEMPOTENCY_KEY_REQUIRED");
  let body: unknown;
  try {
    body = JSON.parse((await request.text()) || "{}");
  } catch {
    return send("BAD_REQUEST");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return send("BAD_REQUEST");
  const b = body as Record<string, unknown>;
  const unknown_ = Object.keys(b).filter((k) => k !== "reason" && !extra.includes(k));
  if (unknown_.length) return send("VALIDATION_FAILED", Object.fromEntries(unknown_.map((k) => [k, "unknown field"])));
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (reason.length < 5 || reason.length > 1000) return send("VALIDATION_FAILED", { reason: "5-1000 characters required" });
  return { reason, body: b };
}

export async function outboxStatusHandler(backend: AdminBackend | null, request: Request): Promise<Response> {
  const c = await adminCtx(backend, request);
  if (c.res) return c.res;
  return json(200, await c.admin.outboxStats(c.backend.now())); // counts only: never payloads
}

export async function outboxActionHandler(backend: AdminBackend | null, request: Request, params: Params): Promise<Response> {
  const c = await adminCtx(backend, request);
  if (c.res) return c.res;
  const action = params?.action === "retry" ? "RETRY" : params?.action === "abandon" ? "ABANDON" : null;
  if (!action || !isUuid(params?.id ?? "") && !/^o\d+$/.test(params?.id ?? "")) return send("NOT_FOUND");
  const r = await readReason(request);
  if (r instanceof Response) return r;
  const out = await c.admin.outboxAction(c.actor.id, params!.id, action, r.reason);
  return out.ok ? json(200, { ok: true }) : send(STATUS[out.code] ?? "VALIDATION_FAILED");
}

export async function approveAccountHandler(backend: AdminBackend | null, request: Request, params: Params): Promise<Response> {
  const c = await adminCtx(backend, request);
  if (c.res) return c.res;
  if (!isUuid(params?.id ?? "")) return send("NOT_FOUND");
  const r = await readReason(request, ["role"]);
  if (r instanceof Response) return r;
  const role = r.body.role as Role;
  if (!OPERATIONAL_ROLES.includes(role)) return send("VALIDATION_FAILED", { role: "explicit operational role required" });
  const out = await c.admin.approveAccount(c.actor.id, params!.id, role, r.reason);
  return out.ok ? json(200, { ok: true }) : send(STATUS[out.code] ?? "VALIDATION_FAILED");
}

export async function disableAccountHandler(backend: AdminBackend | null, request: Request, params: Params): Promise<Response> {
  const c = await adminCtx(backend, request);
  if (c.res) return c.res;
  if (!isUuid(params?.id ?? "")) return send("NOT_FOUND");
  const r = await readReason(request);
  if (r instanceof Response) return r;
  const out = await c.admin.disableAccount(c.actor.id, params!.id, r.reason);
  return out.ok ? json(200, { ok: true }) : send(STATUS[out.code] ?? "VALIDATION_FAILED");
}
