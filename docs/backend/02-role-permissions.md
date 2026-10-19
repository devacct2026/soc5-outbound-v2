# Roles, authentication and data scope

## Evidence labels

**VERIFIED** describes audited implementation at original commit
`e54f3508a38ebd91926edbfd266d9452fdcff5f6`; **UNVERIFIED** describes
business intent or guarantees not established by the source.

## Roles and permissions

The table below describes audited source behavior. Approved v2 rejection
permissions that differ from that source baseline are specified separately
below.

| Role | Verified request visibility and queue | Verified write permissions |
|---|---|---|
| `ops_pic` | Non-admin sees own-created requests. Queue includes own `DOCKING` requests with a driver, `DOCKED`, and rejected requests returned to Ops PIC. | Create; cancel own request at the allowed pre-work/rejection stage; enter linehaul trip number to finish docking for own request; edit own `DOCKED` request. |
| `fte_ops` | Can read requests across creators; actionable queue is `PENDING`, `REROUTED`, and `REJECTED` returned to FTE Ops. | Create; edit `PENDING`/`REROUTED`; approve or reject Ops stage; cancel when current next-action role is FTE Ops; bulk approve; create/manage Backroom users subject to controller authorization. |
| `fte_mm` | Can read requests across creators; queue is `REQUESTED`. | Assign truck or reject with remarks; cancel when next-action role is FTE MM; create/manage Backroom users subject to controller authorization. |
| `doc_officer` | Can read requests across creators; queue is `DOCKING` without driver ID. | Assign/reassign driver ID. Driver assignment does not move status out of `DOCKING`. |
| Admin override | Admin emails are configured server-side. Admin can use `X-View-Role` to present one of the four operational roles; original role is retained. | Admin status does not itself grant arbitrary request transition privileges; action authorization still evaluates role/status and ownership, with explicit admin visibility exception for Ops PIC. Outbox-status endpoint has an admin-only check. |

The table above records audited source behavior, not the approved v2 target.
In v2, a final APR-3 rejection of an FTE Ops-created request is excluded
from all actionable queues regardless of role; see the APR-3 overlay below.

Sources: `backend/app/Features/Requests/RequestAuthorizer.php`,
`backend/app/Features/Requests/RequestRepository.php`,
`backend/app/Features/Requests/RequestStatus.php`,
`backend/app/Http/Middleware/AuthenticateSupabase.php`,
`backend/app/Features/Outbox/WorkflowOutboxStatusController.php`,
`backend/app/Features/Users/UserController.php`,
`backend/tests/Feature/RequestAuthorizationMatrixTest.php`.

## Approved v2 rejection and correction permissions (APR-3)

| Request creator | FTE Ops rejection handling | Who may correct and resubmit |
|---|---|---|
| `ops_pic` | Return to the request's original Ops PIC creator; return role `ops_pic`. | Only that original Ops PIC creator, subject to active-profile and request-state checks. |
| `fte_ops` | Final `REJECTED`; no correction route, return role or resubmission. | No correction actor. The rejected request remains historical and non-actionable. |

FTE MM rejection continues to return the request to FTE Ops for correction
and renewed approval under the existing FTE Ops return-role policy. For the
Ops PIC-created branch, a role match alone is insufficient: the authenticated
user must match the original creator identity, derived from trusted request
provenance rather than request payload or UI state. For an FTE Ops-created
request rejected by FTE Ops, do not grant any correction or resubmission
permission. Notify the original creator of the final rejection and preserve
the rejection record.

## Authentication

**VERIFIED**

- Supabase bearer access tokens are validated by calling Supabase Auth’s
  `/auth/v1/user`; the application then loads an active `profiles` row. A
  short cache is keyed by a SHA-256 hash of the token. Missing/inactive profile
  is denied. See `backend/app/Http/Middleware/AuthenticateSupabase.php` and
  `backend/app/Support/AuthenticatedProfileCache.php`.
- SeaTalk login uses a server session. The config endpoint creates a random
  OAuth state valid for ten minutes; callback checks and consumes the state
  with constant-time comparison, resolves employee email, and admits only an
  active provisioned profile. Session ID is regenerated after successful
  login. See `backend/app/Features/Auth/SeatalkController.php`.
- Backroom accounts are provisioned through the Supabase Admin API; initial
  password change is enforced by middleware. Account roles and active state
  come from the server-side profile rather than client claims.
- API groups apply throttling; session routes use CSRF middleware. SeaTalk
  provider callbacks have separate signature-verification middleware.
  See `backend/routes/api.php`, `backend/bootstrap/app.php` and
  `backend/app/Http/Middleware/`.

## Hub restrictions

**VERIFIED OBSERVATION:** No hub-based authorization filter was found in the
request read/write authorization, request queue query, cluster lookup, KPI
controller or current Supabase read policies. `clusters` stores
`hub_name`, but `profiles` has no hub assignment and `requests` has a
denormalized cluster/region/dock plus optional `cluster_id`. FTE Ops, FTE MM
and Doc Officer request reads are global; active authenticated users can
search the active cluster directory.

**UNVERIFIED:** Whether employees should be limited to a hub, region, cluster
or some other scope. This audit does not invent that rule. Decide it before
production cutover. If hub segregation is required, current cross-hub reads
are a security/privacy gap, not a behavior to silently preserve.

## Supabase RLS summary

- `profiles`, `clusters`, `requests`, `request_events`, `notifications`,
  `intraday_dispatch`, `notification_reads` and selected audit tables have
  RLS policies. Request/event policies scope Ops PICs to their own requests
  and allow active FTE/Doc Officer roles broader reads. Cluster reads are for
  active profiles.
- Browser-facing write policies for protected workflow records are
  intentionally absent; backend writes use server credentials/direct
  PostgreSQL access after authentication and authorization. Support tables
  such as `workflow_outbox` have RLS enabled and privileges revoked from
  `PUBLIC`, `anon` and `authenticated`.
- At the audited latest migration, direct Supabase `intraday_dispatch` reads
  are allowed only to active `fte_ops` and `fte_mm`; this differs from the
  Laravel KPI/intraday API authorization, which accepts all four operational
  roles. Confirm intended clients and align the v2 policy.
- Exact policy sources: `supabase/migrations/001_initial_schema.sql`,
  `supabase/migrations/010_intraday_dispatch.sql`,
  `supabase/migrations/20261009000002_harden_active_profile_read_policies.sql`,
  `supabase/migrations/20261014133907_optimize_rls_and_drop_duplicate_index.sql`,
  `supabase/migrations/20261013040000_harden_backend_support_tables.sql`.

## Security and resilience observations

1. **Hub boundary unresolved:** Treat as a high-priority authorization decision
   before cutover if tenants/users are expected to be hub-separated.
2. **Short auth/profile cache windows:** Token validation and active-profile
   lookups are cached (token default 30 seconds, profile default 5 seconds in
   configuration). Disabling or role changes may not take effect
   instantaneously. Confirm these windows meet revocation requirements.
3. **SeaTalk callback freshness:** Approval signatures bind a `Date` header,
   but `SeaTalkCallbackSignature::verifyApproval` does not enforce an
   acceptable date skew. Assignment expiry, decision state, and event
   deduplication also constrain replay; still define provider callback
   freshness/replay requirements explicitly.
4. **Login failure observability:** `SeatalkController::callback` catches
   `Throwable` and redirects with a generic error without recording diagnostic
   context. This avoids exposing details but makes operational investigation
   difficult. Add safe, redacted structured logging in the target design.
5. **Schema and policy responsibility:** Server-side Supabase service-role or
   direct database access bypasses ordinary browser RLS. Keep it server-only,
   enforce role and transition checks in a transactional domain boundary, and
   never expose secrets to client components.

These are source observations, not a penetration test. No production
credentials, data or endpoints were tested.
