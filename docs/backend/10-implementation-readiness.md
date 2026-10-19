# SOC5 Outbound v2 — implementation readiness

## Readiness summary

| Gate | Status | Notes |
|---|---|---|
| Business decision coverage | **Complete for planning: 46/46** | Policies are recorded in [09-business-decisions.md](./09-business-decisions.md). This is not formal company authorization or evidence of implementation. |
| APR-3 FTE Ops-created rejection | **Approved: final, no route** | Rejection is final; no correction recipient, return role, or resubmission path. |
| APR-3 design closure | **Specified** | Final outcome, role boundary, state, queue exclusion, notification, audit, and persistence semantics are specified in this document and backend design references. |
| Runtime technical verification | **Partially verified (local only)** | Backend, migrations and tests now exist and pass against disposable local resources (see [`../implementation-progress.md`](../implementation-progress.md)). Nothing was verified against a live Supabase project, SeaTalk sandbox or Google account, and no checklist box below is ticked without evidence recorded there. |
| Production configuration | **Open** | Production routing, retry/recovery, retention, security, and reporting values require validation and approval. |
| Implementation / deployment readiness | **Blocked** | Do not treat decision approval as implementation acceptance or production authorization. |

This checklist separates approved business rules from technical proof and
operational configuration. A checkbox may be marked complete only when its
acceptance evidence is recorded. No backend code, database migrations,
integrations, or dashboard changes are part of this documentation update.
Do not connect to the original production environment to complete these
checks.

## APR-3 final rejection acceptance

- [ ] On FTE Ops rejection of an FTE Ops-created request, set request status
  and approval status to `REJECTED`, preserve required remarks, and create no
  correction route or return role. Do not add a resubmission action for this
  rejected case.
- [ ] Keep the final rejection out of actionable correction/approval queues
  while retaining it in authorized history and reporting. Verify it cannot
  be edited, resubmitted, or reactivated through another endpoint or
  alternate client path.
- [ ] Notify the original FTE Ops creator and any other explicitly assigned
  affected recipients under the approved event-time targeting rule. Persist
  and deduplicate notification intent with the rejection; verify retries do
  not duplicate workflow actions or notifications.
- [ ] Append an immutable rejection audit event containing actor and creator
  identities, timestamp, from/to request and approval statuses, rejection
  remarks, approval version, and correlation ID. Do not modify or delete
  prior request history.
- [ ] Test that authorized FTE Ops users can reject eligible requests and
  that the final FTE Ops-created rejection has no correction recipient,
  return role, or resubmission route. Verify other APR-3 branches remain
  unchanged: Ops PIC-created requests return to their creator; FTE MM
  rejection returns to FTE Ops.
- [ ] Verify the persistence/API representation supports a rejected request
  with explicit `FINAL_NO_ROUTE` disposition and no return role; distinguish
  it from `LEGACY_UNRESOLVED` and from routed rejection dispositions. Ensure
  queue queries do not misclassify final rows as actionable. The target
  representation is specified in [05-database-schema.md](./05-database-schema.md);
  implementation and migration evidence remain outstanding.

## APR-3 technical verification status

The target policy and acceptance criteria are defined, but technical
verification is **blocked in this repository**, not passed. The tracked
workspace has no backend request services/API, Supabase or other database
migrations, or backend workflow tests. The README describes the operational
modules as local mock data that do not connect to a backend. Therefore no
runtime claim can be made about database persistence, transition enforcement,
role-based access, actionable-queue exclusion, notification delivery, or
immutable audit behavior.

Required implementation closure when the backend repository is available:

- [ ] Implement the explicit rejection disposition and enforce consistent
  status, approval status, and nullable return-role values in the database
  and domain transition boundary.
- [ ] Verify `PENDING`/`REROUTED` → final `REJECTED` for FTE Ops-created
  requests rejected by FTE Ops, including required rejection remarks and
  transactional audit/notification intent.
- [ ] Verify role-based access: authorized FTE Ops may reject; no actor can
  edit or resubmit the final rejection; the unchanged Ops PIC and FTE MM
  rejection/correction routes still work.
- [ ] Verify final rows are excluded from actionable role queues, bulk
  actions, and awaiting-action metrics, but remain available in authorized
  history/reporting.
- [ ] Verify the original creator and other approved affected recipients are
  notified according to event-time targeting; retry and duplicate-event
  tests show no duplicate workflow transition or notification.
- [ ] Verify append-only audit captures actor, creator, rejection remarks,
  timestamp, prior/new request and approval statuses, disposition, version,
  and correlation; prove historical events cannot be edited or deleted.
- [ ] Run database migration replay and focused authorization, workflow,
  queue, notification, audit, and regression tests in a disposable
  non-production environment. Retain test and migration evidence.

## Conflicts with the original audited workflow

These are differences between approved v2 policy and the previously audited
implementation/documentation baseline, not contradictions among the 46
approved decisions:

- The audited FTE Ops rejection path always set
  `rejection_return_role=ops_pic`. Approved APR-3 preserves the creator
  return route for Ops PIC-created requests but makes FTE Ops rejection of
  FTE Ops-created requests final, with no correction route or resubmission.
- The audited rejected-request edit rule required the role in
  `rejection_return_role` and additionally required Ops PIC to be the creator.
  V2 must preserve creator-only correction for Ops PIC-created requests while
  denying correction/resubmission for the final FTE Ops-created rejection.
- The existing API contract only said rejected edits resubmit to `PENDING`;
  it did not distinguish this final rejection, queue exclusion, notification,
  or audit behavior.
- Verify that storage and queue logic distinguish FTE Ops final rejection
  from FTE MM rejection, which still returns to FTE Ops. No client may
  supply or replace a correction route.

Documents 01 and 03 retain source-audit observations where they describe
legacy behavior. The approved target behavior and transition diagram are in
[`03-workflow-transitions.md`](./03-workflow-transitions.md); the role
authorization overlay is in [`02-role-permissions.md`](./02-role-permissions.md).

## Technical verification checklist

### Architecture and API

- [ ] Reconcile architecture notes and API contracts with the approved
  decision register before implementation. In particular, resolve stale
  “open decision” text for SeaTalk approval requirements, queue pagination,
  cluster entry, hub visibility, and KPI reporting scope. Record any
  implementation constraint without changing the approved policy.
- [ ] Publish and validate the `/api/v1` contract for new endpoints. Inventory
  actual clients before retaining any legacy unversioned alias; add one only
  for a verified integration need.
- [ ] Verify queue pagination end to end: only the approved page sizes are
  offered, the server rejects invalid or over-limit sizes, cursors are opaque
  and stable, sorting has a deterministic tie-breaker, and filters are
  applied server-side. Test duplicate/omitted records across page boundaries
  and enforce the maximum page size.
- [ ] Verify idempotency for state-changing APIs: matching retries within
  the retention window replay the original successful result; conflicting
  payload reuse is rejected; failures do not produce success-shaped results;
  provider callback deduplication remains separate.
- [ ] Verify authorization at service/API and data boundaries for operational
  actions, administrator overrides, Intraday Dispatch, advanced analytics,
  report exports, and cluster data. Ensure free-text cluster values never
  confer access.
- [ ] Verify user and permission revocation across protected API requests,
  sessions, caches, and realtime access. Measure and document the actual
  revocation delay.

### Workflow, audit, and historical data

- [ ] Test the five-stage request workflow, role/state guards, cancellation,
  both FTE Ops rejection outcomes (Ops PIC creator correction route and
  FTE Ops creator final rejection), FTE MM rejection route, permitted
  post-dock edits, administrator override
  safeguards, notification targeting, and immutable before/after audit
  history.
- [ ] Keep request `status` and `approval_status` distinct. Verify
  transactional consistency for request changes, event history, and
  notification/outbox intent.
- [ ] Build a non-production historical-data preview and reconciliation for
  every approved status rule. Preserve original values and evidence; prevent
  workflow side effects; keep incomplete or ambiguous rows non-actionable
  and route ambiguous rows to manual review. Reconcile source/target counts
  and representative records before any authorized migration.
- [ ] Add tests for latest-submission-to-final-approval timing, rejection and
  resubmission cycles, confirmed-request inclusion, waiting and dwell
  formulas, schedule boundaries, timezones, historical schedule definitions,
  custom reporting periods, and missing or invalid timestamps.

### Database, access controls, and integration

- [ ] Establish one authoritative Supabase migration history. Prove clean
  replay in a disposable environment; verify schema/runtime alignment,
  indexes, constraints, grants, and RLS. Do not apply a conflicting parallel
  Laravel migration track.
- [ ] Prove backend authorization and Supabase RLS agree for request reads,
  operational Intraday Dispatch, analytics, and exports. Verify assigned
  reporting permission is independent of operational role and that denied
  users cannot obtain data through direct queries or alternate routes.
- [ ] Verify directory-backed cluster selection and validated free-text
  cluster entry on the server. Test required fields, formats, registered
  cluster references, and that text input cannot grant authorization or
  bypass approved access boundaries.
- [ ] Verify SeaTalk Approval Center integration against official provider
  documentation and a sandbox: endpoints, authentication, payloads,
  response codes, callbacks, signature verification, duplicate handling,
  conflict handling, timeouts, and outage/retry behavior. Approval operations
  must not bypass SeaTalk; an outage must leave approvals pending.
- [ ] Test callback freshness and replay protections separately against the
  official provider contract. Verify provider-scoped event IDs and payload
  hashes; exact duplicates must not re-run workflow actions, and conflicting
  payloads must be detected.
- [ ] Verify OAuth identity, organization membership, and approved email
  domain. Automatically registered accounts must remain
  `PENDING_APPROVAL` without operational access until an administrator
  approves the account and explicitly assigns a role.
- [ ] Verify administrator overrides require explicit permission,
  justification, strong identity verification, SeaTalk compliance,
  workflow validation, immutable audit, and affected-user notification.
  Demonstrate that historical audit records cannot be modified or deleted.

### Delivery, reporting, and user experience

- [ ] Verify in-app and SeaTalk notification persistence, deduplication,
  provider acknowledgment where supported, user read receipts, and
  best-effort realtime signaling as separate delivery facts.
- [ ] Verify a durable background worker with due-row dispatch, safe
  concurrency/claiming, retries with exponential backoff, dead-letter
  handling, recovery monitoring, alerts, and operator runbooks. Prove
  notification replay/abandonment is administrator-only, reasoned, audited,
  and does not disable automatic retries.
- [ ] Verify retention implementation supports configured notification and
  callback expiry, archival/deletion, legal holds, restricted access, and
  audit logging under approved company policy.
- [ ] Verify KPI metric authorization and downloads on every backend and RLS
  path. Confirm dashboard metrics, hourly charts, filters, trends, and
  downloads use the approved definitions and permission checks.
- [ ] Confirm future KPI work preserves the approved Logistics Dashboard
  design. This task makes no dashboard changes.
- [ ] Run relevant automated tests, security/access tests, clean migration
  replay, historical-data reconciliation, integration sandbox tests, and a
  full non-production rehearsal. Retain the test results and reconciliation
  artifacts.

## Production configuration checklist

These items must be validated and approved for the intended production
environment; sandbox defaults are not production service targets. Keep secret
values in approved server-only secret management and out of documentation,
logs, and client bundles.

- [ ] Verify production SeaTalk tenant/application configuration and approved
  endpoint contract after successful sandbox verification. Confirm the
  production approval route has no internal bypass.
- [ ] Approve production presence-freshness and assignment-expiry values.
  The documented 60-second presence freshness and 180-second expiry are
  sandbox defaults until validated for production.
- [ ] Approve worker and notification retry limits, backoff bounds, recovery
  targets, dead-letter alert thresholds, and operational SLOs. Name alert
  owners and publish outage, replay, and recovery runbooks.
- [ ] Approve notification and callback retention durations within company
  policy, including legal-hold process, archival/deletion behavior, access
  restrictions, and audit requirements.
- [ ] Approve the callback freshness/replay policy using the official
  provider contract and a tested clock-skew boundary.
- [ ] Validate administrator-configured reporting shift, duration, timezone,
  default periods, and reporting-permission assignment. The documented
  18:00 start, 13 hourly intervals, and `Asia/Manila` timezone are sandbox
  defaults; historical reports must retain their schedule definitions.
- [ ] Approve the SeaTalk organization and email-domain eligibility policy
  for account registration, plus the named administrator process for account
  approval and role assignment.
- [ ] Validate administrator override identity-verification and SeaTalk
  compliance controls with security and operations owners.
- [ ] Measure and accept the actual user/permission revocation delay for
  protected requests and realtime access.

## Readiness gate

Implementation may proceed only within the approved scope after the
applicable technical checks have passing evidence, including the APR-3 final
rejection disposition and queue semantics, and production settings have
accountable owners and approval. Production activation additionally requires the provider,
security, operations, data, and recovery gates above. A planning decision is
not permission to connect to production or to deploy.
