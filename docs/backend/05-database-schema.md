# Supabase PostgreSQL schema, RLS and realtime

## Snapshot and migration sources

This describes the schema represented by the original repository’s tracked
migrations at commit
`e54f3508a38ebd91926edbfd266d9452fdcff5f6`. No live schema or production data
was queried. The repository has two migration tracks: Supabase SQL migrations
under `supabase/migrations/` and Laravel support-table migrations under
`backend/database/migrations/`. Reconcile them into one authoritative v2
migration history; do not apply either track blindly to production.

## Core tables

| Table | Purpose and important fields | Source |
|---|---|---|
| `profiles` | `id` references `auth.users`; role (`ops_pic`, `fte_ops`, `fte_mm`, `doc_officer`), name, email/ops ID, active state; later adds password-reset state, SeaTalk employee code and last-seen presence. | `supabase/migrations/001_initial_schema.sql`, `003_auth_flows.sql`, `015_backroom_password_reset_state.sql`, `020_seatalk_employee_identity.sql`, `022_presence_and_routing_state.sql` |
| `clusters` | Cluster name, hub name, region, dock number, backlog and timestamp; active state is introduced by later migrations. Base unique cluster/hub/dock tuple. | `supabase/migrations/001_initial_schema.sql`, `002_cluster_import_compatibility.sql`, `014_activate_all_clusters.sql` |
| `requests` | Request timestamp, optional `cluster_id`, denormalized cluster/region/dock/backlogs, truck size/type, creator, plate/provide/trip/docked/driver fields, status and rejection/cancellation metadata. Later additions include approval status/version/source/correlation and workflow timestamps. | `supabase/migrations/001_initial_schema.sql`, `021_approval_center_schema.sql`, `20261005000000_add_workflow_milestone_timestamps.sql`, `20261013032010_linehaul_rejection_routing.sql` |
| `request_events` | Append-style workflow history: request, event type, actor, from/to status, JSON metadata, correlation ID, creation time. FK cascade on request delete in initial schema. | `supabase/migrations/001_initial_schema.sql` |
| `notifications` | User- or role-targeted messages with event/title/body and read timestamp; later receives outbox link. At least one recipient is required. | `supabase/migrations/001_initial_schema.sql`, `018_notification_read_receipts.sql`, `20261013060000_workflow_outbox.sql` |
| `notification_reads` | Per-user read receipt for role-targeted notifications; composite key `(notification_id,user_id)`. | `supabase/migrations/018_notification_read_receipts.sql` |
| `intraday_dispatch` | Unique `(dispatch_date,hour)`, hour 0–23, nonnegative numeric order quantity, `synced_at`. | `supabase/migrations/010_intraday_dispatch.sql` |
| `user_imports` | Import staging/identity mapping for users, with source ID, role, email/ops ID, active flag and optional auth user. RLS enabled; latest reconciliation revokes browser privileges. | `supabase/migrations/003_auth_flows.sql`, `20261014133548_reconcile_production_schema.sql` |
| `user_events` | User-account audit events, actor, metadata and timestamp; event types include create/update/disable/password reset. | `supabase/migrations/007_user_audit_events.sql`, `019_identity_and_audit_hardening.sql` |
| `seatalk_approval_items` | One local item per request; external provider item/response IDs, status, failure reason and correlation. | `supabase/migrations/021_approval_center_schema.sql` |
| `seatalk_approval_assignments` | Per-request FTE assignment sequence, status, sent/expiry/response timestamps, provider IDs, token hash and correlation. Unique partial index permits at most one pending/active assignment per request. Runtime optionally uses `routing_cycle` and `approval_token_used_at`; these are added by the Laravel support migration, not by the tracked Supabase SQL chain. | `supabase/migrations/021_approval_center_schema.sql`, `backend/database/migrations/2026_10_13_000005_harden_seatalk_approval_assignments.php` |
| `approval_routing_cursors` | Scope-to-last-assigned-profile cursor for round-robin FTE Ops routing. | `supabase/migrations/022_presence_and_routing_state.sql` |
| `seatalk_callback_events` | Provider callback dedupe, request/item/employee/action/status and timestamps. Runtime also requires assignment ID, payload hash and failure reason; those columns are added by the Laravel support migration but are absent from the tracked Supabase SQL creation migration. | `supabase/migrations/023_seatalk_callback_events.sql`, `backend/database/migrations/2026_10_13_000005_harden_seatalk_approval_assignments.php` |
| `workflow_outbox` | Durable external side-effect intent: idempotency key, event, aggregate, JSON payload, status, attempts, available time, last error, completion/dead-letter timestamps. | `supabase/migrations/20261013060000_workflow_outbox.sql` |

Additional backend support tables include `idempotency_keys`,
`user_event_retries`, queue/cache/job tables, and Laravel migrations metadata.
They are created by files in `backend/database/migrations/`; matching
Supabase-side hardening revokes `PUBLIC`, `anon` and `authenticated` access
from server-only support tables.

### Important type/enumeration facts

- `user_role`: four operational roles listed above.
- `truck_size`: `4W`, `6W`, `10W`, `6WF`, `4WAUV`, `4WCV`.
- `truck_type`: `WETLEASE`, `DRYLEASE`.
- `request_status` began with legacy states and was extended with
  `REQUESTED`, `REROUTED`, `DOCKING`; forward migrations normalize some
  legacy values. Approval state is separately stored as a constrained text
  field (`PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`).
- Do not collapse request status and approval status into one field during
  v2 migration.

### APR-3 rejection persistence requirement

The v2 request representation must support a final `REJECTED` request with
no correction route. A null return role alone is insufficient to distinguish
an intentional final rejection from missing or ambiguous legacy routing.
Persist an explicit rejection disposition (for example, `FINAL_NO_ROUTE`,
`RETURN_TO_OPS_PIC`, `RETURN_TO_FTE_OPS`, or `LEGACY_UNRESOLVED`) on the
request or in authoritative append-only rejection-event metadata, with the
database/API contract enforcing consistency between the disposition and
return role. The chosen representation must:

- set status and approval status to `REJECTED` for final APR-3 rejections;
- encode `FINAL_NO_ROUTE` and no return role for an FTE Ops-created request
  rejected by FTE Ops;
- preserve the routed dispositions for the unchanged Ops PIC and FTE MM
  rejection paths;
- represent historical rows with missing/uncertain routing as
  `LEGACY_UNRESOLVED`, not as final or actionable by default; and
- be used by queue and mutation authorization queries so final rejections
  remain visible in authorized history but cannot be corrected, resubmitted,
  or reactivated.

This is a target-schema requirement, not a statement that the existing
database already has such a field or constraint. Verify actual schema,
migrations, APIs, and queue predicates before implementation; do not create
or apply a migration as part of this documentation change.

## RLS and privilege model

- RLS is enabled on browser-facing core tables. Latest policies require an
  active profile for cluster/request/event/notification reads.
- `requests`: creator or active FTE Ops/FTE MM/Doc Officer may read; Ops PIC
  remains own-request-only. `request_events` follows the related request’s
  read rule.
- `profiles`: users can read own active profile; FTE Ops/FTE MM can read
  active profiles more broadly. Active users can read clusters.
- `notifications`: user-targeted row or row for caller’s role. Role notification
  read receipts are per user in `notification_reads`.
- `intraday_dispatch`: latest policy grants active FTE Ops and FTE MM, not
  Ops PIC or Doc Officer. This differs from backend API role authorization.
- Approval assignment/item and server support data is RLS-enabled, with no
  intended direct browser write path. Service-role/direct database access is
  server-only.
- `public.current_role()` was moved into `private.current_role()` in the
  2026-10-14 hardening migrations. Use the latest policy definitions, not
  initial policy text, as the current source.

Policy sources: `supabase/migrations/001_initial_schema.sql`,
`supabase/migrations/010_intraday_dispatch.sql`,
`supabase/migrations/016_migration_hardening.sql`,
`supabase/migrations/20261009000002_harden_active_profile_read_policies.sql`,
`supabase/migrations/20261013040000_harden_backend_support_tables.sql`,
`supabase/migrations/20261014133744_move_current_role_private.sql`,
`supabase/migrations/20261014133811_remove_redundant_account_policies.sql`,
`supabase/migrations/20261014133907_optimize_rls_and_drop_duplicate_index.sql`.

## Indexing and realtime

- Request status/creator/time, events by request/time, notification unread
  scope, approval pending/correlation, assignment status/expiry/user/sequence,
  and outbox status/available-time indexes are present across migrations.
- Supabase Realtime publication includes `notifications` (initial schema),
  `requests` and `intraday_dispatch`
  (`supabase/migrations/20261004000000_enable_request_realtime.sql`).
- `frontend/src/hooks/useRequestRealtime.ts` subscribes to changes in
  `requests` and `intraday_dispatch`, batches query invalidation, and refreshes
  after reconnection. RLS remains the row visibility boundary. The audited
  frontend queue notification hook polls/refetches the API rather than
  deriving actionable queues directly from database change payloads.

## Integrity and migration concerns

- **Verified migration-track drift:** `supabase/migrations/023_seatalk_callback_events.sql`
  does not define `assignment_id`, while
  `supabase/migrations/20261014133548_reconcile_production_schema.sql`
  creates an index on `seatalk_callback_events(assignment_id)`. No Supabase
  SQL migration in the audited tree adds that column. A clean replay of the
  tracked SQL chain therefore reaches an index statement for a missing
  column. In addition, `SeaTalkApprovalCallbackController` reads and writes
  callback `assignment_id`, `payload_hash`, and `failure_reason`, and writes
  assignment `approval_token_used_at`; those fields are added only by
  `backend/database/migrations/2026_10_13_000005_harden_seatalk_approval_assignments.php`.
  Production may contain untracked/manual schema changes; this audit did not
  inspect it. Reconcile both migration histories before cutover.
- Requests carry optional `cluster_id` but current service input does not
  require/use it. Text copies can diverge from `clusters`.
- `request_events` is operationally append-only in service behavior, but the
  DB schema itself does not prevent privileged updates/deletes.
- Status history and current status can diverge if a migration or privileged
  write bypasses the service; validate event chronology during data migration.
- The multiple schema tracks and forward-only “production reconciliation”
  migrations make migration ordering and current schema version a cutover
  prerequisite. Compare actual authorized schema metadata during a separate
  approved environment audit; this document intentionally did not connect to
  a live database.
