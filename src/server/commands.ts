// Command service: authorization -> idempotent replay -> pure workflow decision
// -> atomic commit (request + audit event + notifications + outbox + response).
import { createHash } from "node:crypto";
import { canView } from "../domain/permissions.ts";
import type { Actor, NotificationIntent, WorkflowResult } from "../domain/requests/workflow.ts";
import type { RequestRecord } from "../domain/requests/lifecycle.ts";
import { toApiRequest } from "./api-shape.ts";
import {
  VersionConflictError,
  withVersionRetry,
  type IdemScope,
  type OutboxIntent,
  type Store,
  type StoredResponse,
} from "./store.ts";

export const ERROR_STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  NOT_CORRECTABLE: 409,
  DRIVER_ALREADY_ASSIGNED: 409,
  NO_DRIVER_ASSIGNED: 409,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  REMARKS_REQUIRED: 422,
  VALIDATION_FAILED: 422,
  JUSTIFICATION_REQUIRED: 422,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  BAD_REQUEST: 400,
  APPROVAL_PROVIDER_DISABLED: 503,
  BACKEND_NOT_CONFIGURED: 503,
  RATE_LIMITED: 429,
  RANGE_TOO_LARGE: 422,
  PAYLOAD_TOO_LARGE: 413,
};

export const errorResponse = (code: string, details?: unknown): StoredResponse => ({
  status: ERROR_STATUS[code] ?? 500,
  body: details === undefined ? { error: code } : { error: code, details },
});

/** Stable JSON (sorted keys) so equivalent payloads hash identically. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
export const payloadHash = (payload: unknown, extra = "") =>
  createHash("sha256").update(canonicalJson(payload)).update(extra).digest("hex");

export interface Features {
  seatalkApproval: boolean;
  seatalkAlerts: boolean;
  googleSheets: boolean;
}
export const DEFAULT_FEATURES: Features = { seatalkApproval: false, seatalkAlerts: false, googleSheets: false };

export interface CommandSpec {
  actor: Actor;
  /** Existing request id, or the id to assign on creation. */
  requestId: string;
  creating?: boolean;
  method: string;
  path: string;
  idempotencyKey: string;
  /** Normalised client payload (hashed; conflicting reuse is rejected). */
  payload: unknown;
  /** Static role/ownership check run BEFORE replay so denied actors learn nothing. */
  authorize(actor: Actor, request: RequestRecord | null): boolean;
  decide(request: RequestRecord | null): WorkflowResult;
  successStatus?: number;
  features?: Features;
  correlationId?: string;
}

function outboxFor(
  notifications: NotificationIntent[],
  request: RequestRecord,
  nextVersion: number,
  features: Features,
): OutboxIntent[] {
  const out: OutboxIntent[] = [];
  if (features.seatalkAlerts) {
    for (const n of notifications) {
      out.push({
        idempotencyKey: `alert:${n.dedupeKey}`,
        channel: "SEATALK_ALERT",
        eventType: n.event,
        payload: { requestId: request.id, dedupeKey: n.dedupeKey },
      });
    }
  }
  if (features.googleSheets) {
    out.push({
      idempotencyKey: `sheets:${request.id}:v${nextVersion}`,
      channel: "GOOGLE_SHEETS",
      eventType: "REQUEST_CHANGED",
      payload: { requestId: request.id },
    });
  }
  return out;
}

export async function runCommand(store: Store, spec: CommandSpec): Promise<StoredResponse> {
  const features = spec.features ?? DEFAULT_FEATURES;
  const hash = payloadHash(spec.payload, `${spec.method} ${spec.path}`);
  const scope: IdemScope = {
    actorId: spec.actor.id,
    method: spec.method,
    path: spec.path,
    key: spec.idempotencyKey,
    payloadHash: hash,
  };
  try {
    return await withVersionRetry(() =>
      store.transaction(spec.requestId, async (tx) => {
        // Invisible and missing requests are indistinguishable (no existence oracle).
        if (!spec.creating && (!tx.request || !canView(spec.actor, tx.request))) return errorResponse("NOT_FOUND");
        // Authorization precedes replay (03-workflow-transitions "Ownership and guard conditions").
        if (!spec.authorize(spec.actor, tx.request)) return errorResponse("FORBIDDEN");
        const prior = await tx.replay(scope);
        if (prior === "CONFLICT") return errorResponse("IDEMPOTENCY_CONFLICT");
        if (prior) return prior;

        const result = spec.decide(tx.request);
        if (!result.ok) return errorResponse(result.code);
        const next = result.request as RequestRecord;
        const response: StoredResponse = {
          status: spec.successStatus ?? 200,
          body: { request: toApiRequest(next, spec.actor) },
        };
        await tx.commit({
          request: next,
          expectedVersion: tx.request ? tx.request.rowVersion : null,
          event: result.event,
          notifications: result.notifications,
          outbox: outboxFor(result.notifications, next, (tx.request?.rowVersion ?? 0) + 1, features),
          idem: { ...scope, response },
        });
        return response;
      }),
    );
  } catch (e) {
    if (e instanceof VersionConflictError) return errorResponse("VERSION_CONFLICT");
    throw e;
  }
}
