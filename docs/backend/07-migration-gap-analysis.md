# Migration gap analysis and readiness

## Executive assessment

**Migration readiness: FAIL (not yet ready for behavior-preserving production
cutover).**

Source access was successful. The audit used a temporary read-only clone of
the original at commit `e54f3508a38ebd91926edbfd266d9452fdcff5f6`; no
production credentials or data were accessed. Seven requested documents are
based on source inspection, not a live data migration rehearsal. The FAIL is
driven by unresolved access scope/business decisions, contract/schema drift,
and a verified outbox retry/dispatch gap—not by inability to read the source.

## Ranked gaps

| Priority | Finding | Evidence / consequence | Required closure |
|---|---|---|---|
| P0 | Hub restriction is undefined and absent in audited request/cluster authorization. | Profiles have no hub assignment; request rows are not authoritatively tied to a cluster; FTE/Doc Officer reads are broad. If hub separation is expected, the current and target data scope cannot be approved. | Business owner decides hub/region/cluster scope; define ownership mapping; add server authorization and RLS tests before cutover. |
| P0 | Approved KPI/workflow rules need implementation evidence. | Business decisions now approve the formulas, final dock handoff, and APR-3 rejection routing; the audited source does not prove those approved v2 rules are implemented. | Implement and test the workflow swimlane and KPI definitions, including Ops PIC creator correction and FTE Ops creator final rejection, timezone/day-boundary, cancellation, rejection and resubmission. |
| P0 | Historical status semantics are lossy/ambiguous. | Legacy migration maps `REJECTED_BY_MM` to `CANCELLED` and changes several other legacy states. | Compare an authorized, privacy-safe data inventory and approve a reversible mapping/retention plan; do not query production as part of this audit. |
| P0 | Tracked Supabase SQL chain is incomplete for current SeaTalk callback schema. | SQL migration `20261014133548_reconcile_production_schema.sql` creates an index on callback `assignment_id`, but no prior tracked Supabase SQL migration adds that column. Runtime also needs callback `payload_hash`/`failure_reason`/`assignment_id` and assignment `approval_token_used_at`; these additions appear in the Laravel migration track only. A clean SQL replay can fail, while runtime code can fail on missing columns. | Add/align forward-only Supabase SQL migrations, validate clean replay in a disposable project, compare both tracks, and do not assume production/manual schema matches the repository. |
| P1 | Outbox retry state is not autonomously redispatched. | Retry job returns after writing a future pending row; no scheduled dispatcher was found; `tries=1`. Notification delivery can remain pending; SeaTalk reconciliation and scheduled full Sheets sync recover some side effects independently but leave outbox state unresolved. | Add and test a due-row dispatcher, stale-claim recovery, bounded retry, alerting and operator replay. Verify duplicate provider delivery is safe. |
| P1 | Repositories have two migration histories and evolving schema. | Laravel support migrations and Supabase forward migrations overlap/reconcile support data; status and approval columns are additive. | Build one v2 migration manifest from approved source schema; check constraints, indexes, RLS grants, trigger/function ownership and rollback strategy in a disposable database. |
| P1 | RLS and server API behavior differ for `intraday_dispatch`. | Latest Supabase RLS permits active FTE Ops/MM; API admits all four roles. | Choose supported access path and align API/RLS, then add role matrix tests. |
| P1 | Request-to-cluster integrity is not guaranteed. | `cluster_id` optional; request endpoint accepts validated text and does not assert active cluster/dock membership. | Decide whether free text is a supported business flow; if not, require FK and validate the selected cluster/dock in a transaction. |
| P1 | API contract is incomplete and has a role-overloaded action. | No OpenAPI spec found; same `mark-docked` action has Doc Officer driver assignment vs Ops PIC trip completion; canonical and legacy route aliases coexist. | Publish OpenAPI and generated TS types; inventory old clients; define explicit v2 actions and compatibility/deprecation policy. |
| P1 | SeaTalk provider endpoint/configuration contract is not fully evidenced. | Adapter requires configured create/update/detail paths and labels unconfirmed paths as contract errors. | Confirm provider sandbox contract, callback signature/freshness, event replay, identity mapping and idempotent create/update behavior without production credentials. |
| P2 | OAuth callback error observability is weak. | Broad catch redirects generic error without safe diagnostics. | Add redacted structured event IDs/metrics and alerting; preserve non-disclosure to client. |
| P2 | Cache revocation delay is nonzero. | Token/profile caches can delay role/active-state effect for configured TTLs. | Set and test revocation SLA; add cache invalidation on role/disable operations. |
| P2 | Queue UI only reads one bounded slice. | API cursor exists, but audited queue hooks request limit 100 without cursor continuation. | Confirm operational maximum backlog and implement pagination/virtualization if users must process larger queues. |
| P2 | Tests have not been executed in this read-only documentation task. | Test files cover auth, workflow, integrations, schema and reporting, but presence does not prove passing status. | Run relevant suites in isolated CI/disposable database; add workflow contract snapshots and new security/RLS tests. |

## Migration behavior that must be carried forward

1. Preserve creator ownership for Ops PIC request visibility and finish-docking
   action unless product explicitly changes it.
2. Preserve distinct stored request and approval statuses, transition
   authorization, rejection-return role, cancellation remarks, approval
   versions/correlation, and role-specific display status.
3. Commit state changes, event history and outbox intents atomically; preserve
   idempotent callbacks and mutation replay semantics.
4. Keep service role and provider credentials server-only. Never trust the
   client-supplied role, displayed status, selected cluster metadata or
   callback identity without server-side verification.
5. Keep request/event/notification reads behind RLS and server authorization.
   Explicitly decide whether route handlers use caller-scoped RLS or trusted
   server DB role; tests must prove equivalent role constraints.
6. Preserve configured backfill/event mapping and timezone rules only after
   business sign-off; do not silently reinterpret `REJECTED_BY_MM` as
   `CANCELLED`.

## Recommended Next.js backend shape

The current v2 workspace is Next.js App Router (`src/app/` pages). Keep the
dashboard untouched and add server surfaces as a separate, testable layer:

- `src/app/api/v1/**/route.ts`: HTTP parsing, auth bootstrap, request/response
  mapping, status codes and rate limits; thin handlers only.
- `src/server/auth/`: cookie-aware Supabase session client, active profile
  loading, role resolution and policy helpers. Client-provided role/view state
  must never authorize a write.
- `src/server/requests/`: Zod (or repository-standard) schemas, query services,
  transition command handlers and audit event metadata.
- `src/server/integrations/seatalk/` and `google-sheets/`: provider clients,
  signature verification, explicit timeout/error mapping and contract tests.
- PostgreSQL transaction/RPC boundary: lock request; verify actor, owner,
  expected status and version; update request; append immutable event; create
  outbox intent. Return the canonical updated row.
- Durable worker/Edge Function: claim due outbox rows, idempotently deliver,
  update attempt/error state, retry with backoff, dead-letter and alert.
  Serverless Route Handlers should not be the only scheduler.
- RLS policies remain defense in depth. Define private helper functions and
  grants intentionally; test each role, active/inactive profile, hub scope
  (after decision), cross-request access and service role.
- OpenAPI/typed client: preserve `/api/v1` response shapes where required;
  explicitly version breaking changes and avoid leaking database-only
  columns.

This is an architecture recommendation, not a backend implementation.

## Readiness exit criteria

Mark PASS only when all are true:

- [ ] Hub/region scope and admin impersonation policy are approved and tested.
- [ ] Implement and test the approved workflow swimlane, cancellation and
      rejection semantics (including APR-3 final rejection of FTE Ops-created
      requests), `ASSIGNED` usage, post-dock editing, and KPI formulas.
- [ ] Historical status mapping and data-quality checks are approved using an
      authorized non-production snapshot; production data was not included in
      this audit.
- [ ] One versioned schema/migration source exists; RLS/grants/indexes,
      triggers and rollback/cutover sequencing pass disposable-DB tests.
- [ ] OpenAPI and generated client types cover all supported routes and
      callback payloads; legacy client inventory is complete.
- [ ] Outbox retry dispatch, idempotency under concurrency, stale claims,
      dead-letter alerting and operator reconciliation are tested end to end.
- [ ] SeaTalk and Sheets sandbox integration tests pass without production
      credentials; callback replay/signature/identity behavior is verified.
- [ ] Auth revocation/cache windows and all four role boundaries pass
      automated tests; no hub-crossing access remains if hubs are isolated.
- [ ] Relevant backend, frontend and database tests pass in CI and a
      non-production migration rehearsal succeeds.

**Current result: FAIL.** Repository access was not a blocker; the findings
above are closure requirements before migration approval.

## Evidence index

The companion documents `01-business-rules.md` through `06-integrations.md`
record exact original source paths for each finding. Highest-signal additional
tests include `backend/tests/Feature/RequestAuthorizationMatrixTest.php`,
`backend/tests/Feature/RequestWorkflowTest.php`,
`backend/tests/Feature/PostgresSchemaHardeningTest.php`,
`backend/tests/Feature/WorkflowOutboxProcessingTest.php`,
`backend/tests/Feature/SeaTalkApprovalCallbackTest.php`,
`backend/tests/Feature/GoogleSheetsOutboxDeliveryTest.php`,
`backend/tests/Feature/DispatchAuthorizationTest.php` and
`supabase/functions/sync-intraday/index_test.ts`.
