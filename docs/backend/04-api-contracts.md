# Existing API contracts

## Compatibility boundary

At audited commit
`e54f3508a38ebd91926edbfd266d9452fdcff5f6`, Laravel registers the same
handlers under canonical `/api/v1` and legacy `/api` paths. Preserve the
versioned contract for v2; keep the unversioned routes only if a client
inventory shows they are still used. The request/action API currently uses
JSON and server-side validation. Source: `backend/routes/api.php` and
`backend/tests/Feature/ApiRulesTest.php`.

### Authentication/error behavior

- Most API routes require a valid Supabase bearer token or authenticated
  SeaTalk session plus an active profile. Session endpoints also apply CSRF
  and IP/API throttles; provider callback routes use signature middleware.
- Typical failures use HTTP 401 (missing/invalid session), 403 (role/scope),
  404 (missing record), 409 (stale/invalid workflow state or reused
  idempotency key with different payload), 422 (validation), and 503
  (authentication/provider schema unavailable). Laravel validation error
  envelope should be captured from actual clients before exact v2 wire
  compatibility is frozen.
- `Idempotency-Key` is optional at middleware level. If sent, it is scoped by
  actor, method and path, hashes normalized payload, replays stored successful
  response for 24 hours, rejects a different payload, and removes failed
  response reservations. Frontend mutations send idempotency keys.

## Request and operation routes

| Method and path (canonical) | Input / filters | Output and behavior |
|---|---|---|
| `GET /api/v1/requests` | `status`, `search`, `date_from`, `date_to`, `sort`, `direction`, `page`, `per_page` | Laravel paginator `{data,current_page,last_page,per_page,...,total}`. Search is plate number; sort fields are allowlisted; request date filters use business timezone. |
| `GET /api/v1/requests/queue` | `limit` 1–100; optional opaque `cursor` | `{data,has_more,next_cursor,limit}`; role-actionable queue, created-time/ID descending. |
| `GET /api/v1/requests/{id}` | UUID path ID | Visible request with actor display fields, `display_status`, `next_action_role`; Ops PIC ownership applies except admin. |
| `GET /api/v1/requests/{id}/events` | UUID path ID | Request event history, newest first; same visibility check as request. |
| `POST /api/v1/requests` | `cluster`, `region`, `dock_no`, `backlogs`, optional `backlogs_timestamp`, `truck_size`, `truck_type` | `201` and created request. Ops PIC/FTE Ops only. |
| `PUT /api/v1/requests/{id}` | Same validated request-detail fields | Updated request, subject to workflow edit permissions. Only correctable rejected requests may be resubmitted to `PENDING` by their authorized return actor. FTE Ops rejection of an FTE Ops-created request is final and not editable or resubmittable. |
| `POST /api/v1/requests/{id}/{action}` | `approve`, `reject-ops`, `cancel`, `reject-mm`, `assign-truck`, `mark-docked`, `reassign-driver` | Updated request. Action-specific fields below; unknown and extra fields rejected. |
| `POST /api/v1/requests/bulk-approve` | `{ids:[uuid,...]}`; 3–100 distinct IDs | `{data:[updated request,...]}`; FTE Ops only. Requests fewer than three IDs are rejected. |
| `GET /api/v1/requests/metrics` | Optional `search`, `date_from`, `date_to` | `{total,awaiting_action,by_status}`. Awaiting counts include `PENDING`, `REQUESTED`, `REROUTED`, actionable `REJECTED` records with an approved return route, and active docking states; exclude final no-route APR-3 rejections and historical-only statuses. |
| `GET /api/v1/requests/analytics` | `date_from`, `date_to` | Truck-size counts, 13 shift-hour bins, shift start, average dwell and waiting minutes. |
| `GET /api/v1/requests/summary` | Optional `search`, `date_from`, `date_to` | `{metrics,analytics}` combined. |
| `GET /api/v1/kpi/summary` | `date_from`, `date_to` (`YYYY-MM-DD`) | `{total,confirmed,cancelled,averageApprovalMinutes}`. |
| `GET /api/v1/kpi/daily` | `date_from`, `date_to` (`YYYY-MM-DD`) | `{data:[{date,total,confirmed},...]}`. |
| `GET /api/v1/dispatch/intraday` | Required `date` (`YYYY-MM-DD`) | `{data:[{date,hour,orderQty,syncedAt}, ...24 hours]}`; all four operational roles at API layer. |
| `GET /api/v1/clusters` | Required search 3–80 chars | `{data:[...]}` up to 12 active-or-null-active clusters. |

Request action bodies:

- `approve`: `{}`.
- `reject-ops`, `reject-mm`: `{rejection_remarks:string}` required, max 2,000.
- `cancel`: `{cancellation_remarks?:string}`; required for FTE MM, max 2,000.
- `assign-truck`: `{plate_number,truck_size,truck_type,provide_time?}`; backend
  sets `provide_time` to now. Truck enum matches request creation.
- `mark-docked`: Doc Officer sends `{driver_id}` (1–10 digits); creator Ops PIC
  sends `{linehaul_trip_no}`. These are different semantics under same path.
- `reassign-driver`: `{driver_id}` (1–10 digits); only Doc Officer with an
  existing driver assignment.

### APR-3 rejection routing contract

- FTE Ops may reject `PENDING` or `REROUTED` requests with required
  `rejection_remarks`. For an Ops PIC-created request, route correction to
  its original Ops PIC creator using trusted creator provenance. For an
  FTE Ops-created request, rejection is final: do not set a correction
  recipient/return role and do not allow subsequent editing or resubmission.
  Clients cannot supply or override a creator, return role, or recipient.
- FTE MM rejection of a `REQUESTED` request continues to return it to FTE Ops
  for correction and renewed approval.
- Rejection stores `REJECTED` request and approval states, preserves the
  remarks, and creates an immutable actor-attributed audit event. Notify the
  original creator. For an FTE Ops-created request rejected by FTE Ops,
  `REJECTED` is final and non-actionable; `PUT /api/v1/requests/{id}` must
  reject correction attempts.
- For an Ops PIC-created request rejected by FTE Ops, correction from
  `REJECTED` is authorized only when the authenticated active user matches
  the original creator and stored `ops_pic` return role. Matching the role
  alone is insufficient. FTE MM rejection continues to return the request
  to FTE Ops under its existing role authorization.
- Successful correction of a correctable rejected request returns it to
  `PENDING`, resets approval state to `PENDING`, clears active rejection
  routing, starts a new approval version/correlation, and appends a
  resubmission event with field-level before/after values. Retain the prior
  rejection event. Notify the explicitly routed FTE Ops reviewer(s) at event
  time. Resubmission is not approval; normal authorization and SeaTalk
  Approval Center requirements still apply.

## Authentication, users, notifications and integrations

| Method/path | Contract notes |
|---|---|
| `GET /api/v1/auth/status` | Public availability probe, returns `{configured:true}` only if Supabase URL and anon key configured. |
| `GET /api/v1/auth/me` | Authenticated actor profile, including server role and admin metadata. |
| `GET /api/v1/auth/seatalk/config` | Session/CSRF protected; returns SeaTalk app/redirect/response type/state/SDK config. OAuth callback is `GET /auth/seatalk/callback` in web routes. |
| `POST /api/v1/auth/seatalk/logout` | Session logout, `{ok:true}`. |
| `POST /api/v1/auth/backroom/login` | Throttled Backroom login; separate from Supabase bearer middleware. |
| `POST /api/v1/access-requests` | Throttled access-request submission. |
| `GET /api/v1/users`; `POST /api/v1/users`; `PUT /api/v1/users/{id}`; `PATCH /api/v1/users/{id}/disable`; `POST /api/v1/users/{id}/reset-password` | Profile/account administration; creation/update/disable/reset have controller role checks and audit writes. |
| `GET /api/v1/notifications` | `{data:[...max 50 newest...],unread:number}`; visibility is user-specific or target-role; role-targeted read receipts are per user. |
| `PATCH /api/v1/notifications/{id}/read`; `PATCH /api/v1/notifications/read-all` | `{ok:true}`; caller must be eligible recipient. |
| `POST /api/v1/presence/heartbeat` | Updates active FTE presence used by Approval Center routing. |
| `POST /api/v1/integrations/seatalk/approval/approve`; `POST .../reject` | Provider callbacks signed by middleware; body includes `item_id`, `token`, `employee.employee_code`, optional `event_id`/`timestamp`, and rejection `reason`; success ack `{code:0}`. |
| `POST /api/v1/integrations/seatalk/events` | Signed event challenge verification callback. |
| `GET /api/v1/operations/outbox/status` | Admin-only operational counts; does not return outbox payloads. |

Source route registration: `backend/routes/api.php`,
`backend/routes/web.php`. Controllers: `backend/app/Features/Requests/RequestController.php`,
`backend/app/Features/Kpi/KpiController.php`,
`backend/app/Features/Dispatch/DispatchController.php`,
`backend/app/Features/Notifications/NotificationController.php`,
`backend/app/Features/Approvals/PresenceController.php`,
`backend/app/Features/Approvals/SeaTalkApprovalCallbackController.php`.

## Contract risks to resolve before v2 freeze

- The same `mark-docked` route has role-specific payloads and transition
  meaning. Prefer explicit v2 actions such as driver assignment and final
  docking while preserving a compatibility adapter if old clients remain.
- Request `status` may be stored status or role-specific `display_status`.
  Keep these separate and document them in generated OpenAPI/TypeScript types.
- Status migration compatibility includes old enum values; API consumers and
  data migration must be inventoried before removing them.
- Backend has no explicit cluster membership ID requirement; search selection
  is a UI convention, not a contract invariant.
- `docs/architecture/api_rules.md` is a style guide rather than a full
  machine-readable schema. No OpenAPI specification was found in the audited
  tracked paths.

## Test evidence (inventory, not execution)

Relevant tests include `backend/tests/Feature/ApiRulesTest.php`,
`backend/tests/Feature/RequestWorkflowTest.php`,
`backend/tests/Feature/RequestAuthorizationMatrixTest.php`,
`backend/tests/Feature/IdempotencyTest.php`,
`backend/tests/Feature/DispatchAuthorizationTest.php`,
`backend/tests/Feature/AuthStatusTest.php`,
`backend/tests/Feature/AuthenticateSupabaseTest.php`,
`backend/tests/Feature/NotificationReadIsolationTest.php`,
`backend/tests/Feature/SeaTalkApprovalCallbackTest.php`,
`backend/tests/Feature/GoogleSheetsRequestSyncTest.php`, and
`backend/tests/Feature/PostgresReportingTest.php`. This documentation audit
did not execute tests; test existence is not evidence that the current suite
passes.
