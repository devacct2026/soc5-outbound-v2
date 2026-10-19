// Application service for APR-3 transitions. Persistence is a port: a real
// (Supabase) adapter must make `commit` atomic with a row lock taken in `load`.
import {
  rejectByFteMm,
  rejectByFteOps,
  type Actor,
  type NotificationIntent,
  type RequestEvent,
  type WorkflowErrorCode,
  type WorkflowRequest,
} from "../../domain/requests/workflow.ts";

export type RejectOutcome =
  | { ok: true; request: WorkflowRequest }
  | { ok: false; code: WorkflowErrorCode | "NOT_FOUND" };

export interface RequestTx {
  request: WorkflowRequest | null;
  /** Idempotent replay: previously committed result for this key. */
  replay: (key: string) => Promise<RejectOutcome | null>;
  commit: (
    next: WorkflowRequest,
    event: RequestEvent,
    notifications: NotificationIntent[],
    idempotency?: { key: string; outcome: RejectOutcome },
  ) => Promise<void>;
}

export interface RequestStore {
  /** Run `fn` in one transaction holding a row lock on the request. */
  transaction<T>(requestId: string, fn: (tx: RequestTx) => Promise<T>): Promise<T>;
}

export async function rejectRequest(
  store: RequestStore,
  input: {
    requestId: string;
    actor: Actor;
    remarks: string;
    correlationId: string;
    idempotencyKey?: string;
    now?: Date;
    resolveExtraRecipients?: (r: WorkflowRequest) => Promise<string[]>;
  },
): Promise<RejectOutcome> {
  return store.transaction(input.requestId, async (tx) => {
    const current = tx.request;
    if (!current) return { ok: false, code: "NOT_FOUND" };

    // Authorization precedes replay so a forbidden actor cannot read a replay.
    const roleOk =
      input.actor.active &&
      (input.actor.role === "fte_ops" || input.actor.role === "fte_mm");
    if (!roleOk) return { ok: false, code: "FORBIDDEN" };

    if (input.idempotencyKey) {
      const prior = await tx.replay(input.idempotencyKey);
      if (prior) return prior;
    }

    const ctx = {
      now: input.now ?? new Date(),
      correlationId: input.correlationId,
      extraRecipientIds: input.resolveExtraRecipients
        ? await input.resolveExtraRecipients(current)
        : [],
    };
    const result =
      input.actor.role === "fte_ops"
        ? rejectByFteOps(current, input.actor, input.remarks, ctx)
        : rejectByFteMm(current, input.actor, input.remarks, ctx);

    if (!result.ok) return { ok: false, code: result.code };
    const outcome: RejectOutcome = { ok: true, request: result.request };
    await tx.commit(
      result.request,
      result.event,
      result.notifications,
      input.idempotencyKey ? { key: input.idempotencyKey, outcome } : undefined,
    );
    return outcome;
  });
}
