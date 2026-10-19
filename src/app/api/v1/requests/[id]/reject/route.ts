import { rejectRequest } from "@/server/requests/service";
import { getBackend } from "@/server/backend";

const STATUS = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  INVALID_STATE: 409,
  NOT_CORRECTABLE: 409,
  REMARKS_REQUIRED: 422,
} as const;

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/v1/requests/[id]/reject">,
) {
  const backend = getBackend();
  if (!backend) {
    return Response.json({ error: "BACKEND_NOT_CONFIGURED" }, { status: 503 });
  }
  const actor = await backend.authenticate(request);
  if (!actor) return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as
    | { rejection_remarks?: unknown }
    | null;
  const remarks =
    typeof body?.rejection_remarks === "string" ? body.rejection_remarks : "";

  // Only remarks are read from the client: no creator, return role or recipient.
  const out = await rejectRequest(backend.store, {
    requestId: id,
    actor,
    remarks,
    correlationId: crypto.randomUUID(),
    idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
  });
  if (!out.ok) return Response.json({ error: out.code }, { status: STATUS[out.code] });
  return Response.json({ request: out.request });
}
