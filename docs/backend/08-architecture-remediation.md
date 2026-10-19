# Backend architecture remediation and migration readiness

## Status and scope

This document consolidates the seven preceding audit documents and proposes
resolutions for their P0/P1 gaps. The original reference is the read-only
GitLab source at commit `e54f3508a38ebd91926edbfd266d9452fdcff5f6`. Its
verified behavior is a preservation baseline, not proof of business-owner
approval.

Labels used below:

- **VERIFIED** — implemented in the audited source or source migrations.
- **PROPOSAL** — recommended target design; not yet implemented or approved.
- **BUSINESS CONFIRMATION REQUIRED** — source evidence is insufficient to
  choose a behavior. Do not make it a live rule until the owner decides.
- **BLOCKER** — must be resolved or explicitly accepted before migration
  readiness can pass.

This is a design document only. It does not implement a migration, backend
code, or a dashboard change. No production credentials, production data, or
live provider were accessed.

## 1. P0/P1 inventory and proposed resolution

| Priority | Gap in `07-migration-gap-analysis.md` | Proposed resolution | Remaining decision / exit evidence |
|---|---|---|---|
| P0 | Hub authorization missing/undefined. | Add explicit user-to-hub memberships and authoritative request-to-hub attribution; apply the proposed matrix below consistently in server authorization, RLS and reporting. | **BUSINESS CONFIRMATION REQUIRED:** Are operational users restricted by hub? Which roles may be assigned to multiple hubs? Is there an exception for central FTE? Confirm admin/global access and intraday data scope. Test cross-hub denial. |
| P0 | Approved workflow/KPI rules require implementation and verification. | Implement the approved five-stage workflow, creator Ops PIC final trip-number handoff, and approved KPI rules; retain testable definitions. | **TECHNICAL EXIT EVIDENCE:** Add workflow/KPI contract tests and verify authorization, timestamps, timezone, reporting access and final docking against the approved register. Business decisions are recorded in `09-business-decisions.md`. |
| P0 | Historical status mapping is lossy/ambiguous. | Preserve raw source status and all source rows/events; map only unambiguous states; isolate ambiguous historical records from actionable queues. See lossless mapping table below. | **BUSINESS CONFIRMATION REQUIRED:** disposition for `REJECTED_BY_MM`, legacy `ASSIGNED`, and any contradictory event/status history. Obtain owner approval for mapping version before cutover. |
| P0 | SeaTalk callback schema in Supabase SQL does not match runtime or Laravel migration track. | Make the callback receipt and approval assignment schema in this document the single intended target shape. Add fields/constraints from both tracks to one clean Supabase migration history; replay in a disposable project before use. | Validate the exact existing deployed shape only via a separately approved, read-only schema comparison. This audit did not inspect production. |
| P1 | Outbox retries are persisted but not autonomously redispatched. | Use a durable due-row worker that claims rows with `SKIP LOCKED`, lease expiry, capped exponential backoff with jitter, bounded attempts, dead-letter queue and monitoring. | Choose operational SLOs, attempt limits, backoff bounds and alert thresholds. Demonstrate retry after worker/process crash and safe replay. |
| P1 | Two migration histories drift. | Establish one ordered Supabase migration source for v2. Use reviewed import/adoption steps for historical schemas rather than running Laravel migrations in parallel. Add schema-drift checks to CI. | Reconcile intended current schema without production data access in this task; exercise clean replay, upgrade and rollback/forward-repair in isolated databases. |
| P1 | Intraday API and direct RLS role sets differ. | Have both API and RLS call the same declared authorization rule. Default proposal is role-level access scoped to the user’s authorized hub set, if intraday data can be attributed to hubs. | **BUSINESS CONFIRMATION REQUIRED:** Should Ops PIC and Doc Officer see intraday data? Current API allows all four roles; latest direct-table RLS only allows FTE Ops/MM. |
| P1 | Request-to-cluster integrity is not enforced. | Make cluster identity authoritative: request references an active cluster/dock record and copies display snapshots only if needed. Validate the actor’s hub membership and the selected cluster at write time. | **BUSINESS CONFIRMATION REQUIRED:** Is free-text/unlisted cluster request creation a supported fallback? Existing UI uses a directory, but backend does not enforce selection. |
| P1 | API spec absent; `mark-docked` action is overloaded; legacy route alias exists. | Publish a versioned OpenAPI contract. In a new version use explicit driver-assignment and final-docking actions. Keep an adapter for old action semantics only while known clients require it. | Inventory clients and decide deprecation window. Confirm status serialization (stored status vs display status) and exact validation error response shape. |
| P1 | SeaTalk provider contract and callback freshness are not completely evidenced. | Keep provider integration behind a typed adapter; confirm request/response contracts and sandbox behavior. Continue validating HMAC signature, employee identity, assignment, token, expiry and event dedupe. Add provider-date skew validation if the provider contract supports a reliable date header. | **BUSINESS/PROVIDER CONFIRMATION REQUIRED:** API paths/payloads, retry and duplicate semantics, accepted clock skew, event ID guarantees, and source of truth during provider/local disagreement. |

### Additional P2 items tracked

OAuth callback diagnostics, auth/profile cache revocation windows, 100-item
queue pagination, and execution of the original automated suites remain
tracked lower-priority readiness items from the audit. They are not silently
closed by this proposal. The target should add redacted diagnostics, define a
revocation SLA, paginate queues, and pass relevant tests before production
cutover.

## 2. Proposed hub-based access control matrix

### Data model and policy proposal

**PROPOSAL — requires owner approval.** Introduce a canonical `hubs` relation,
`profile_hubs(profile_id, hub_id, active, effective_from, effective_to)`,
and an authoritative `clusters.hub_id`. Requests should reference a cluster
with a non-null `cluster_id`; their security scope is derived from the
cluster’s `hub_id`, not from client-supplied region, hub name or denormalized
text. If operationally necessary, store a request-time `hub_id` snapshot and
enforce that it agrees with the selected cluster at creation.

Use the same authorization predicate in:

1. server request handlers/domain operations;
2. database row-level security for user-scoped reads;
3. realtime publication reads;
4. KPI, queue and report queries;
5. notification target resolution.

The server must derive actor ID, current role, active state and hub
memberships from trusted auth/profile data. A client-supplied hub, role,
display status or `X-View-Role` must not grant access. Any test-as-role
feature is a separately authorized admin function, not ordinary identity.

### Proposed minimum-privilege matrix

| Actor | Read requests | Create | Edit / workflow actions | Cluster / hub scope |
|---|---|---|---|---|
| Ops PIC | Own-created requests in hubs assigned to that profile; no cross-hub read. | Yes, subject to membership in selected cluster’s hub. | Existing verified rules: cancel eligible own request; edit own `DOCKED`; finish `DOCKING` only for own request. | One or more explicitly assigned hubs; **whether Ops PIC may span hubs requires confirmation**. |
| FTE Ops | Requests in assigned hubs, including requests created by other Ops PICs in those hubs. | Existing verified create permission retained, within assigned hub. | Existing verified FTE Ops edit, approve, reject, cancel-at-current-stage and bulk-approve rules, limited to assigned hub(s). | One or more assigned hubs. **Central FTE/global coverage requires confirmation**, not assumed. |
| FTE MM | Requests in assigned hubs. | No; `RequestService::create` allows only `ops_pic` and `fte_ops`. | Existing verified assign truck/reject/cancel-at-current-stage, limited to assigned hub(s). | One or more assigned hubs. |
| Doc Officer | Requests in assigned hubs. | No. | Existing verified driver assignment/reassignment only, limited to assigned hub(s). | One or more assigned hubs. |
| Intraday/KPI reader | Aggregate only within hubs the actor is authorized to see; request-level reporting follows request scope. | No direct writes. | Read only. | Must be filtered by hub where source data contains hub identity. |
| Platform administrator | No implicit operational role. Support access requires explicit, time-bound, audited grant. | No implicit request permission. | No implicit bypass of workflow transitions. Break-glass may be proposed separately. | Global scope only through explicit elevated grant, reason, expiry and audit trail; confirm owner/security approval. |

The role check is enforced in `RequestService::create`; the route controller
validates fields and delegates to that service. The UI is not an authority.

**Cross-cutting rule proposal:** An action is allowed only if the caller is
active, authenticated, has the allowed current role, the request is in the
expected workflow state, any actor/creator constraint is satisfied, and the
request’s authoritative hub belongs to the caller’s allowed hub set. All
conditions are checked server-side within the same transaction as the write.

**Required security tests:** one positive and one negative case per role for
each request action; own vs other creator; assigned vs unassigned hub;
inactive profile; changed role; missing/disabled cluster; changed cluster
hub; admin without elevated grant; read/list/queue/events/realtime/KPI
consistency; and direct database queries under each authenticated JWT.

## 3. Approval and request transitions

### Approved v2 state transitions

This target matrix incorporates the approved APR-3 exception. The source
audit below and in documents 01–03 describes the existing backend and is not
evidence that this target behavior is already implemented.

| From | Actor/action | To | V2 effects and constraints |
|---|---|---|---|
| No request | Ops PIC or FTE Ops creates | `PENDING` | Creator/event recorded; notification to FTE Ops; optional SeaTalk routing/provisioning. |
| `PENDING` or `REROUTED` | FTE Ops approves (Web or valid assigned SeaTalk response) | `REQUESTED` | Approval fields/source/version/correlation set; approval event and FTE MM notification; assignments closed/synchronized. |
| `PENDING` or `REROUTED`, created by Ops PIC | FTE Ops rejects with remarks | `REJECTED` | `rejection_return_role=ops_pic`; notify original Ops PIC creator for correction. |
| `REJECTED` from FTE Ops rejection of an Ops PIC-created request; return role `ops_pic` | Original Ops PIC creator edits/resubmits | `PENDING` | Server verifies creator identity and return role; approval status reset, active return route cleared, version/correlation incremented, append event and notify routed FTE Ops reviewer(s). |
| `PENDING` or `REROUTED`, created by FTE Ops | FTE Ops rejects with remarks | `REJECTED` | Final rejection; no return role or correction/resubmission route. Notify original creator and retain as non-actionable history. |
| `REQUESTED` | FTE MM assigns truck | `DOCKING` | Plate, truck size/type, server-set provide time; event; Doc Officer notified. |
| `REQUESTED` | FTE MM rejects with remarks | `REJECTED` | `rejection_return_role=fte_ops`; FTE Ops notified. |
| `REJECTED` from FTE MM rejection; return role `fte_ops` | Authorized FTE Ops return actor edits details | `PENDING` | Same correction/re-submission behavior; approval must occur again. |
| `DOCKING`, driver missing | Doc Officer assigns valid driver ID | `DOCKING` | Driver ID and assignment timestamp recorded; event. |
| `DOCKING`, driver exists | Doc Officer explicitly reassigns driver | `DOCKING` | Prior/new driver recorded in event. |
| `DOCKING`, driver exists | Request creator Ops PIC enters trip number | `DOCKED` | Trip/docking timestamps, event; active assignments closed and provider sync requested. |
| Eligible current stage | Ops PIC creator or responsible FTE cancels | `CANCELLED` | FTE MM remarks required; approval state/version/correlation, event, notifications and assignment closure. |
| `DOCKED` | Request creator Ops PIC edits allowed details | `DOCKED` | Edit event and operational notifications; state remains docked. |

Sources include original `backend/app/Features/Requests/RequestService.php`,
`RequestAuthorizer.php`, `RequestStatus.php`,
`backend/app/Features/Approvals/ApprovalService.php`, and
`backend/app/Features/Approvals/ApprovalRouter.php`.

`DOCKING` displayed as `ASSIGNED` to FTE MM and `REROUTED` displayed as
`PENDING` for FTE MM/Doc Officer are view mappings, not stored transitions.
Do not persist a display label in place of the canonical state.

### Approved policy and remaining implementation boundaries

- **BUSINESS CONFIRMATION REQUIRED:** The source sets requests initially to
  `PENDING`, but an implementation path for changing the request itself to
  `REROUTED` was not found in the audited service. Confirm what user/system
  event owns that transition and whether it is still active.
- **APPROVED V2 POLICY (APR-3):** FTE Ops rejection of an Ops PIC-created
  request returns to its original Ops PIC creator for correction;
  FTE Ops rejection of an FTE Ops-created request is final, with no return
  role or correction/resubmission route. FTE MM rejection continues to return
  to FTE Ops under its role authorization. Append immutable,
  actor-attributed rejection history; notify the original creator, including
  for a final rejection.
- **BUSINESS CONFIRMATION REQUIRED:** Doc Officer assigns a driver but does
  not set terminal `DOCKED`; the creator Ops PIC must enter the trip number.
  Confirm the final owner and whether an alternate Ops PIC may act.
- **BUSINESS CONFIRMATION REQUIRED:** Ops PIC post-dock edits are allowed by
  source. Confirm editable fields, notification audience and whether
  historical event correction is allowed.
- **BUSINESS CONFIRMATION REQUIRED:** Source includes `ASSIGNED` as a legacy
  enum/UI type but does not use it as the normal service transition target.
  Decide whether it is historical-only, an alias for `DOCKING`, or an active
  state. Until decided, retain it as a historical value and never infer an
  actionable next actor.
- **BUSINESS CONFIRMATION REQUIRED:** KPI definitions are implemented (Asia/
  Manila default, 18:00 shift start, request timestamp basis, `DOCKED`
  confirmed count, averages described in `01-business-rules.md`) but are not
  business-approved by repository evidence.
- **BUSINESS CONFIRMATION REQUIRED:** Cancellation permission at a rejected
  stage is derived from `rejection_return_role`; confirm cancellation should
  remain available to the actor responsible for fixing the request.

## 4. Lossless historical request-status migration

### Principle

Do not overwrite or discard the original status. The current migration
`supabase/migrations/20261009000000_normalize_legacy_request_statuses.sql`
updates `APPROVED` to `REQUESTED`, `REJECTED_BY_MM` to `CANCELLED`,
`FOR_DOCKING` to `DOCKING`, and `CONFIRMED` to `DOCKED`. That mapping is a
verified existing implementation, but the `REJECTED_BY_MM` equivalence is
not established by business evidence and must not be repeated destructively.

**PROPOSAL:** During migration preserve an immutable original-status
provenance record for every request. At minimum:

- `legacy_status` text exactly as read from the source;
- `canonical_status` nullable, using the new workflow vocabulary;
- `mapping_version` and mapping disposition;
- source request ID and source system;
- source row hash or migration-batch identifier for reconciliation;
- original timestamps, rejection/cancellation remarks, actor IDs and
  original request events without lossy reinterpretation.

Keep a separate mapping-audit record keyed by source system/request ID and
mapping version. The raw source data must remain exportable and the migration
must be idempotent. Do not store secrets or duplicate unnecessary personal
data in the row hash.

### Proposed mapping table

| Exact source status | Proposed canonical/read status | Actionability | Notes |
|---|---|---|---|
| `PENDING` | `PENDING` | Only if source record has valid current approval context. | Preserve source string. |
| `REQUESTED` | `REQUESTED` | Per current role/hub policy after owner-approved cutover. | Already current vocabulary. |
| `REROUTED` | `REROUTED` | Do not invent router/event semantics; only actionable if current ownership can be reconstructed. | Confirm how it is entered and routed. |
| `APPROVED` | `REQUESTED` as a compatibility mapping. | Historical rows should not be re-approved or re-notified merely by migration. | Existing migration behavior; keep `legacy_status=APPROVED` and mapping version. |
| `CANCELLED` | `CANCELLED` | Terminal/read-only unless a separately approved workflow exists. | Preserve cancellation remarks and event history. |
| `REJECTED` | `REJECTED` | Actionable only when explicit disposition and current policy allow a correction route. `FINAL_NO_ROUTE` is never actionable. | Missing/invalid disposition is `LEGACY_UNRESOLVED` and read-only; never infer finality or a return actor from a null role alone. |
| `REJECTED_BY_MM` | `REJECTED` as a historical outcome only; `rejection_return_role=NULL` unless independently evidenced. | **Non-actionable / manual review**, not a live FTE Ops queue item. | Proposed to preserve rejection meaning; the original mapping to `CANCELLED` is not lossless. Business owner must approve canonical presentation and disposition. |
| `ASSIGNED` | Retain as `ASSIGNED` legacy status, or set `canonical_status=NULL` / `LEGACY_UNRESOLVED`. | Non-actionable until its semantics are confirmed. | Do not silently equate to `DOCKING` just because UI labels `DOCKING` as `ASSIGNED` for FTE MM. |
| `FOR_DOCKING` | `DOCKING` as a compatibility mapping. | Do not create driver/trip obligations absent source evidence; review missing milestones. | Existing migration behavior; preserve exact source value. |
| `DOCKING` | `DOCKING` | Current workflow only when owner/driver state is valid. | Preserve original. |
| `DOCKED` | `DOCKED` | Terminal with verified post-dock edit behavior. | Preserve original. |
| `CONFIRMED` | `DOCKED` as a compatibility mapping. | Historical/read-only; migration must not emit transition side effects. | Existing migration behavior; verify whether “confirmed” and “docked” are equivalent with owner. |
| Any unknown value | `canonical_status=NULL` / `LEGACY_UNRESOLVED`. | Non-actionable; visible only in controlled audit/reporting view. | Never coerce to `PENDING` or `CANCELLED`. |

The proposed `REJECTED_BY_MM` and `ASSIGNED` handling is not a business
decision. Until approval, preserve the raw value and do not expose the row as
an actionable current workflow item. If a fixed canonical enum cannot
represent `LEGACY_UNRESOLVED`, use a separate migration disposition or legacy
read model rather than weakening the live request-state constraint.

### Reconciliation and cutover controls

1. Extract only an authorized non-production snapshot for rehearsal; this
   document does not authorize production data access.
2. Count source rows by exact raw status, null/unknown values, and related
   event types; compare source and target counts by mapping version.
3. Verify every request ID maps once, preserves timestamps/remarks/actors,
   and has no migration-generated notifications or provider callbacks.
4. Compare status chronology with request events. Flag conflicts; do not
   repair from assumptions.
5. Reconcile totals and per-status counts before and after cutover. Retain a
   reversible source export and rollback/forward-correction plan.
6. Keep legacy-status provenance until data-retention and legal owners approve
   its eventual disposition.

## 5. Corrected proposed SeaTalk callback database schema

The source mismatch is specific: Supabase SQL creates a minimal
`seatalk_callback_events` table in
`supabase/migrations/023_seatalk_callback_events.sql`; the later Supabase
reconciliation migration indexes `assignment_id` without adding it.
`SeaTalkApprovalCallbackController` uses `assignment_id`, `payload_hash` and
`failure_reason`; the Laravel support migration also adds
`approval_token_used_at` and `routing_cycle`. The columns below are a
**PROPOSED target schema**, not a SQL migration.

### `seatalk_callback_events`

| Column | Proposed type / constraint | Purpose |
|---|---|---|
| `event_id` | text primary key, non-empty, bounded length | Provider event ID; fallback fingerprint is allowed only when provider omits an ID. Namespace by provider if more than one provider can deliver events. |
| `provider_item_id` | text not null | External Approval Center item identifier; never cast arbitrary provider text into a UUID. |
| `approval_item_id` | uuid nullable FK to local `seatalk_approval_items(id)` with `ON DELETE SET NULL` | Stable internal item reference; retained separately from external ID. |
| `request_id` | uuid nullable FK to `requests(id)` with `ON DELETE SET NULL` | Request snapshot for audit/query. Do not cascade-delete a callback receipt. |
| `assignment_id` | uuid nullable FK to `seatalk_approval_assignments(id)` with `ON DELETE SET NULL` | Exact assignment bound to the provider decision; supports replay proof. |
| `employee_code` | text not null | Provider actor identity used to resolve the active profile. Treat as personal identifier; restrict access/retention. |
| `action` | text/enum check: `approve`, `reject` | Provider decision. |
| `payload_hash` | char(64) nullable, hex SHA-256 | Fingerprint of normalized action/item/employee/token/reason content; store only the hash, never the raw token/body. Null only for historical legacy receipts pending manual reconciliation. |
| `status` | constrained text: `received`, `processed`, `ignored` (optionally `failed_retryable` only if committed retry receipts are part of design) | Processing result. Follow existing lowercase values for compatibility if importing legacy records. |
| `failure_reason` | text nullable, length-limited and redacted | Safe reason for ignored/permanent failures; no raw secrets, tokens, full payload or provider credentials. |
| `correlation_id` | uuid nullable | Correlates callback, request event, assignment and outbox intent. |
| `received_at` | timestamptz not null | Receipt time. |
| `processed_at` | timestamptz nullable | Terminal processing time. |
| `signature_verified_at` | timestamptz nullable | Optional security audit timestamp; do not store signature/secret. |

**Indexes/constraints proposal:** primary key on `event_id`; lookup indexes on
`(provider_item_id, received_at DESC)`, `(request_id, status, received_at
DESC)`, and `(assignment_id, received_at DESC)`; action/status checks; foreign
keys to local rows; unique `(provider_name,event_id)` instead of global event
ID if provider namespace is required. Retention/partitioning must be
confirmed with audit/security owners before deleting receipts.

Callback handling remains: verify signature over raw body before trusting
fields; validate accepted provider timestamp skew (currently no skew
enforcement was found for the SeaTalk approval `Date` header); normalize and
fingerprint content; bind the matching active assignment and employee; lock
workflow rows; apply the request transition and append audit/outbox in one
transaction; record a processed receipt. Invalid-but-authentic actor,
assignment, expiry or state may be recorded as ignored with a safe reason.
Same event ID + same fingerprint is idempotent; same event ID + different
fingerprint is a conflict and a security event.

### Related assignment fields required by runtime

On `seatalk_approval_assignments`, include:

- `routing_cycle integer NOT NULL DEFAULT 1 CHECK (routing_cycle > 0)`;
- `approval_token_hash` (existing field; hash only, never clear token);
- `approval_token_used_at timestamptz NULL` (one-use/replay metadata);
- unique partial constraint/index allowing at most one `PENDING`/`ACTIVE`
  assignment per request;
- positive sequence, allowed status constraint, request/user/item FKs, and
  indexes for `(request_id,routing_cycle,status)`, `(status,expires_at)`,
  and `(fte_user_id,status)`.

Keep tokens out of outbox payloads, callback audit metadata and logs. Provider
item and assignment outcome transitions must be concurrency-safe. Use one
authoritative v2 schema migration history; do not apply a second migration
track that creates the same table differently.

## 6. Automatic outbox retries and delivery monitoring

### Proposed delivery lifecycle

Use a durable outbox table written in the same database transaction as the
business state and request event. A worker/scheduled dispatcher periodically
claims due rows in bounded batches with `FOR UPDATE SKIP LOCKED`, changes
status to `PROCESSING`, increments attempt count, and sets `lease_until`.
Claiming must be atomic; multiple workers must not deliver the same live
lease. If a worker dies, a later scan may reclaim an expired lease.

Suggested state machine:

`PENDING` → `PROCESSING` → `COMPLETED`

Retryable failure:

`PROCESSING` → `PENDING` with future `available_at`

Attempt limit/permanent contract failure:

`PROCESSING` → `DEAD_LETTER`

Require compare-and-set updates on status/lease/attempt to avoid a stale
worker overwriting a newer result. Retain current audit evidence (`attempts`,
`last_error`, available/completed/dead-letter timestamps) and add
`last_attempt_at`, `lease_until`, `last_error_code`, and optionally
`dead_letter_reason`. Never put credentials or unredacted provider bodies in
error columns.

### Backoff proposal

For retry attempt `n >= 1`, calculate:

`delay = min(max_delay, base_delay * 2^(n-1)) + bounded_jitter`

Use capped exponent arithmetic, jitter within a configured range, and
provider `Retry-After` when valid and bounded by the configured maximum.
Timeouts, rate limits, connection failures and selected 5xx responses are
retryable. Invalid payloads, authorization failures, unsupported event
versions and known permanent 4xx contract failures are dead-lettered.
Configuration for base delay, cap, jitter, attempt limit and worker cadence
is a **PROPOSAL**, not a verified business SLA; set values from provider rate
limits and operations needs.

### Idempotency and ordering

- Stable unique outbox key identifies the semantic delivery (e.g. aggregate
  ID + domain event ID + destination), not a random key per retry.
- Each handler is idempotent at the receiving boundary. Notification inserts
  use a unique outbox/delivery key; provider calls include provider-supported
  idempotency/correlation data where available.
- Do not mark a message completed until a durable receiver acknowledgment or
  verifiable idempotent state exists.
- Preserve per-request ordering for transitions that update one provider
  approval item. Use aggregate sequence/version and prevent a later update
  from overtaking earlier pending intent; coalescing may be used only for
  full-snapshot effects such as Sheets where intermediate snapshots are
  intentionally superseded.
- Outbox payloads are versioned and carry identifiers/minimum data; handlers
  re-read canonical data for full snapshots.

### Dead-letter handling and operator recovery

Dead-letter rows remain queryable and are never silently deleted. Admin
operations can inspect safe metadata and retry a row with a new attempt
record, or mark it permanently abandoned with actor, timestamp and reason.
Manual replay preserves original outbox identity/correlation and creates an
audited replay attempt; it must not reset history or bypass idempotency.
Alert on queue age, retry/dead-letter growth and persistent provider failure.

### Delivery monitoring

Expose a restricted operations view/metrics for each destination:

- due and pending counts; oldest due age;
- processing count and expired lease count;
- attempts distribution, retry rate and dead-letter count;
- success/failure rate and end-to-end delivery latency;
- per-handler health and last successful delivery time;
- Sheet snapshot last successful run/watermark and reconciliation drift;
- notification outbox age and notification insert failures.

Do not return raw payloads or sensitive error bodies from status APIs. Alert
thresholds and delivery SLOs require operations approval; do not invent
numeric targets. Monitor a periodic no-op/health probe only if the provider
contract supports it safely.

## 7. Reliable notification and Google Sheets recovery

### Notifications

**VERIFIED:** The original notifications are database records with user or
role recipients, and role-targeted read state is stored per user. This is not
evidence of an email/push delivery channel.

**PROPOSAL:**

1. Within the request transaction, create the notification intent/outbox row.
   The worker creates the in-app `notifications` row with a unique delivery
   key/outbox ID. A crash after insertion but before acknowledging completion
   must result in a no-op duplicate insert and eventual `COMPLETED`.
2. Realtime is a low-latency wake-up, not the delivery source of truth.
   Clients recover by querying unread notifications after reconnect and
   periodically; RLS/API recipient checks apply on every read.
3. Keep user and role recipients distinct; resolve role membership at read
   time as the audited implementation does unless the owner asks for
   recipient-at-event-time snapshots. The latter changes who can see past
   role notifications and requires business/security confirmation.
4. Monitor notification outbox age, failure and unique-key collisions. Provide
   safe retry and dead-letter replay. Never consider a notification delivered
   merely because an event was inserted into Realtime publication.
5. Preserve per-user read receipts and do not let one role recipient mark
   another user’s receipt read.

### Google Sheets synchronization

**VERIFIED:** The original sync is a full snapshot into 19 columns, writes the
replacement range before clearing stale cells, enforces a configured row
limit, and has a five-minute scheduled full-sync path. The separate original
frontend link opening a spreadsheet does not prove write synchronization.

**PROPOSAL:**

1. Retain one coalesced `SHEETS_SNAPSHOT_REQUESTED` intent per destination
   and version/watermark range. The handler re-reads canonical requests/events
   and uses a stable snapshot boundary so rows committed after the snapshot
   are included in a later run.
2. Serialize writes per spreadsheet/tab using a lease or advisory lock.
   Assign a `sync_run_id`, source watermark, row count and content checksum.
   Repeated delivery of the same run is idempotent.
3. Write all rows to the destination range and verify the provider response.
   Only after success, clear stale rows. If write succeeds but clear fails,
   mark the run incomplete/retryable; a repeated write-then-clear is safe.
4. Persist run state (`PENDING`, `PROCESSING`, `COMPLETED`, `FAILED` or
   `DEAD_LETTER`), attempt times, row count, checksum, last safe error and
   completion time. Do not record credentials or full sheet contents in
   sync-run diagnostics.
5. Keep periodic full snapshot reconciliation independent from event-triggered
   outbox dispatch. On every full sync, compare expected row count/checksum
   where feasible and record a successful watermark; detect stuck outbox even
   if the spreadsheet is refreshed independently.
6. Retry timeout, rate limit and transient provider failures with the shared
   bounded backoff policy. Permanent auth/schema/row-limit failures alert and
   dead-letter; they must not be silently reported as success.
7. Keep Google credentials in server-only secret storage and restrict
   spreadsheet access. Rotate/test in a non-production sheet; do not hardcode
   credentials or expose a service account in Next.js client bundles.

## 8. Transaction, idempotency and audit requirements

### Request transition transaction

**PROPOSAL preserving verified behavior:**

1. Authenticate; load active actor/profile and current role from trusted data.
2. Begin a PostgreSQL transaction and lock rows in a consistent order:
   idempotency record (when present), request, actor/profile, then assignment
   and related records. Avoid lock-order inversion between web and callbacks.
3. Re-check active profile, current role, hub membership (after owner
   decision), creator ownership, expected request status, allowed action and
   optional expected `approval_version`.
4. Validate action fields strictly; reject unknown fields; derive
   timestamps/status/actor from the server.
5. Update canonical request fields and increment version/correlation where
   the audited behavior does. Append immutable `request_events` with actor,
   source (`WEB`/`SEATALK`/system), from/to, request version, correlation and
   minimal sanitized metadata.
6. Insert notification and integration outbox intents in the same transaction.
   Close or complete the corresponding approval assignment atomically.
7. Persist idempotent response/result if an API key was supplied; commit. Only
   then wake workers. If the wake-up is lost, scheduled outbox scanning still
   processes the committed row.

No provider, spreadsheet or network request is performed while holding the
request transaction open.

Bulk approve is a source-verified all-in-one transaction over 1–100 IDs.
Preserve atomic all-or-nothing semantics unless a separately approved API
contract replaces it with explicit partial results.

### API idempotency

- Require an idempotency key for mutating v2 API calls, with key scope
  `(actor_id, method, canonical route/resource, key)`.
- Store a canonical request-body hash. Same key/hash returns the original
  result; same key/different hash returns conflict. Bind the key to actor and
  resource to prevent cross-user replay.
- Reserve key, mutate business data, append event/outbox and store response in
  one transaction. Concurrent duplicate requests must serialize on a unique
  constraint; never allow a duplicate event with no matching state result.
- Existing 24-hour retention is a **VERIFIED** original behavior; v2 retention
  duration must be selected from client retry/recovery requirements. Keep
  callback dedupe receipts at least as long as the provider replay window and
  business audit retention require.

### SeaTalk callback idempotency

Verify signature on raw bytes before parsing/processing. Validate timestamp
freshness once provider contract is confirmed. In one transaction, insert or
lock the callback event receipt, compare event ID and payload hash, resolve
item/assignment/profile identity, verify token hash/expiry/current role,
execute the state transition, append request event/outbox, and mark receipt
processed. A retry with same event ID and payload returns the prior ack
without reapplying state; changed payload is a conflict and security audit
event. Transient failures should roll back the receipt claim or retain an
explicit retryable receipt that the worker can safely resume.

### Audit records and retention

- Request workflow events are append-only to ordinary application roles;
  corrections are compensating events, not edits/deletes.
- Record event ID, request ID/version, actor ID/role, action/source,
  from/to status, occurred-at, correlation ID, and validated business fields
  needed to explain the decision. Store prior values selectively; avoid
  unnecessary credentials, full callback body, raw approval token or
  provider secrets.
- Account/user changes and password resets have their own actor-attributed
  audit events; keep their transaction/compensation outcome explicit.
- Outbox delivery attempts and manual replay/abandonment are operational
  audit records, distinct from business transition events.
- **BUSINESS/COMPLIANCE CONFIRMATION REQUIRED:** retention, access, export,
  deletion/anonymization and legal hold policy for request events, callback
  receipts, employee identifiers and user audit history.

## 9. Updated remediation register

| Gap | Design resolution in this document | State after this document |
|---|---|---|
| Hub scope | Conditional hub-membership model and minimum-privilege matrix. | **OPEN BLOCKER:** membership topology, central FTE scope, admin behavior and intraday scope need approval. |
| Approval/KPI intent | Approved transitions, rejection routing, docking ownership and KPI definitions are recorded in `09-business-decisions.md`. | **TECHNICAL BLOCKER:** implement and test the approved behavior, including final FTE Ops-created rejection, no-return-role storage and queue exclusion. |
| Legacy statuses | Lossless source-status provenance and safe proposed mapping/queue isolation. | **OPEN BLOCKER:** approve the ambiguous `REJECTED_BY_MM`, `ASSIGNED`, `CONFIRMED` equivalences and reconcile historical rows. |
| SeaTalk schema drift | Complete callback event and assignment fields/constraints proposed. | **TECHNICAL BLOCKER:** implement a single SQL migration history and prove clean replay against runtime queries. |
| Outbox retry delivery | Claiming, leases, retry/backoff, DLQ and monitoring design. | **TECHNICAL BLOCKER:** implement and test; choose SLO/configuration values. |
| Notification recovery | Durable idempotent DB insert, realtime-as-wakeup and unread-query recovery. | **TECHNICAL BLOCKER:** implement/test worker and stuck-delivery alerting. |
| Sheets recovery | Serialized idempotent full snapshot, watermark/checksum, safe cleanup and periodic reconciliation. | **TECHNICAL BLOCKER:** implement/test in a sandbox sheet and reconcile independent periodic/outbox state. |
| Migration history | Single versioned Supabase history, CI drift check and replay rehearsal. | **TECHNICAL BLOCKER:** build and validate authoritative v2 schema; do not parallel-apply the old Laravel track. |
| Intraday permissions | One shared authorization rule for API/RLS. | **OPEN BLOCKER:** decide if all operational roles see intraday and whether source rows can be hub scoped. |
| Cluster integrity | Required authoritative FK and server validation proposed. | **OPEN BLOCKER:** decide whether free-text clusters remain supported. |
| API contracts | Versioned OpenAPI and explicit operation names proposed. | **TECHNICAL + CLIENT BLOCKER:** inventory clients; approve compatibility/deprecation and response shape. |
| SeaTalk contract | Typed adapter, signature/identity/assignment/idempotency controls and sandbox verification. | **PROVIDER BLOCKER:** endpoint contract, callback freshness, source-of-truth and retry guarantees need confirmation. |

## 10. Migration readiness checklist

Use this as an evidence checklist; a checked item requires an artifact or
test result, not just a design statement.

### Approved business policy verification

- [ ] Implement and verify the approved access policies from
      `09-business-decisions.md`; do not treat the former proposed hub
      membership model in this architecture note as approved. Hub assignment
      is not mandatory, operational-role visibility remains as approved, and
      free-text cluster values never grant authorization.
- [ ] Verify request creation, workflow, and role/state authorization against
      the approved decision register.
- [ ] Implement and test the approved workflow, including APR-3 Ops PIC
      creator correction and FTE Ops creator final rejection, FTE MM
      rejection, REROUTED behavior, cancellation, creator Ops PIC docking
      handoff, post-dock edits and legacy `ASSIGNED` semantics.
- [ ] Verify KPI calculations, timezone, date boundaries, shift window and
      meanings of confirmed/waiting/dwell against the approved definitions.

### Historical data and schema

- [ ] Lossless source-status retention and mapping version are approved;
      ambiguous statuses are non-actionable until resolved.
- [ ] Non-production migration rehearsal preserves per-status counts,
      request IDs, timestamps, actors, remarks and event history.
- [ ] Supabase callback receipt, assignment and approval item schema matches
      all runtime fields and is verified through clean migration replay.
- [ ] Exactly one v2 migration source controls DDL, indexes, RLS, grants,
      functions, triggers and seed/reference data.
- [ ] Clean create, forward upgrade, restore/replay and rollback or
      forward-repair procedures pass in isolated environments.
- [ ] Schema-drift and RLS policy checks run automatically in CI.

### Security, contracts and workflow correctness

- [ ] Role × action × state × hub authorization tests pass, including direct
      Supabase JWT/RLS and realtime cases.
- [ ] Active-profile/role revocation window is defined and meets the approved
      security SLA.
- [ ] OpenAPI documents all supported routes, error envelopes, idempotency
      behavior, callback contracts, status/display-status fields and
      pagination.
- [ ] Legacy clients/routes are inventoried; migration/deprecation path is
      approved; v2 uses explicit driver assignment and docking actions.
- [ ] SeaTalk provider sandbox verifies endpoint paths, signatures, callback
      time skew, employee identity, assignment expiry, duplicate event,
      changed event payload, token replay and provider/local reconciliation.

### Atomicity and operations

- [ ] Request update, immutable event, notification intent, provider outbox
      and idempotency response are committed atomically.
- [ ] Concurrent duplicate mutations and callback retries produce exactly
      one business transition and safe repeated acknowledgments.
- [ ] Outbox due-row scan, `SKIP LOCKED` claim, lease expiry recovery,
      exponential backoff/jitter, permanent failure and DLQ replay pass
      process-crash and provider-outage tests.
- [ ] Notification database insert retries are unique/idempotent; realtime
      reconnect and unread-query recovery work; per-user read isolation holds.
- [ ] Google Sheets sandbox run verifies snapshot boundary, serialized
      concurrent runs, retry after write/clear failure, stale-row cleanup,
      checksum/count reconciliation and manual recovery.
- [ ] Delivery dashboards/alerts and operator runbooks cover oldest due
      outbox, expired leases, failures, DLQ, notification lag and Sheets
      watermark/checksum drift. SLO thresholds have explicit owners.
- [ ] Relevant automated tests and a full non-production migration rehearsal
      pass; results and artifacts are retained.

## Remaining blockers and verdict

**Remaining business blockers:** none are recorded for the approved APR-3
route. The business policies are enumerated in
`09-business-decisions.md`; do not treat older “business confirmation
required” statements in this architecture audit as open approvals. Business
equivalence and disposition checks still remain necessary for any ambiguous
historical records as required by the approved status rules.

**Remaining technical/provider blockers:** implement the unified schema
including callback fields; prove clean schema replay; build and test
autonomous outbox retries/DLQ/monitoring; establish reliable notification and
Sheets recovery; publish and validate the API contract; and confirm SeaTalk
sandbox callback/endpoint semantics.

**Migration readiness verdict: FAIL — APR-3 policy is approved and its target
behavior is specified, but runtime implementation, schema, integration and
non-production validation evidence remain outstanding.** Do not start
production migration until every applicable checklist item is closed or
formally accepted by its accountable owner.
