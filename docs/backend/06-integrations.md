# External integrations and background processing

## SeaTalk login / OAuth

**VERIFIED**

1. Browser requests SeaTalk configuration; server stores a 64-character
   session state with a ten-minute expiry and returns app ID, redirect URI,
   response type, state and SDK URL.
2. `/auth/seatalk/callback` validates and consumes state, checks provider
   error/code, requests app access token, looks up employee identity by code,
   validates employee email, finds an active provisioned profile by email,
   regenerates session ID and establishes a session.
3. Logout removes SeaTalk session values, invalidates session and rotates
   CSRF token.

Source: `backend/app/Features/Auth/SeatalkController.php`,
`backend/routes/api.php`, `backend/routes/web.php`,
`backend/tests/Feature/SeatalkOAuthSessionTest.php`.

**Operational gap:** callback exceptions are caught broadly and result in a
generic redirect; no redacted diagnostic event is written by that controller.
Do not expose provider secrets or raw token responses in logs.

## SeaTalk Approval Center

- Approval item provisioning/synchronization is implemented through gateway,
  adapter, client and payload types under
  `backend/app/Integrations/SeaTalk/`.
- Adapter paths for create/update/detail are configuration-driven. The
  adapter throws an explicit contract error if an endpoint path is unset;
  this means the source does not establish a universally configured provider
  contract.
- When approval routing is enabled, requests in `PENDING`/`REROUTED` are
  assigned to an active, recently present FTE Ops user with SeaTalk employee
  identity. Assignment is round-robin, avoids expired/failed candidates in a
  routing cycle, and expires after configured assignment time (default
  implementation uses 180 seconds). Presence freshness defaults to 60
  seconds. These are configurable implementation defaults, not business
  service-level agreements.
- SeaTalk callback approval/rejection requires provider signature, item,
  employee code, assignment token and active matching assignment/profile.
  Callback events are deduplicated by provider event ID, with a raw request
  fingerprint fallback when provider event ID is absent. Rejection reason is
  required.
- Approval result updates canonical request workflow, records actor/source,
  completes/ closes assignments, adds request event and queues synchronization.
- `ReconcileSeaTalkApprovals` is scheduled with repair enabled every five
  minutes and can compare local and provider state.

Sources: `backend/app/Features/Approvals/ApprovalRouter.php`,
`backend/app/Features/Approvals/ApprovalService.php`,
`backend/app/Features/Approvals/SeaTalkApprovalCallbackController.php`,
`backend/app/Features/Approvals/SeaTalkCallbackSignature.php`,
`backend/app/Integrations/SeaTalk/SeaTalkApprovalCenterAdapter.php`,
`backend/app/Console/Commands/ReconcileSeaTalkApprovals.php`,
`backend/tests/Feature/ApprovalRoutingTest.php`,
`backend/tests/Feature/SeaTalkApprovalCallbackTest.php`,
`backend/tests/Unit/SeaTalkCallbackSignatureTest.php`.

The signed verification challenge callback uses
`backend/app/Features/Approvals/SeaTalkEventCallbackController.php` and
`backend/app/Http/Middleware/VerifySeaTalkEventCallback.php`. Keep verification
callbacks separate from approval decision callbacks in the Next.js route
design.

## Google Sheets request synchronization

- Request lifecycle writes request events and asks
  `WorkflowGoogleSheetsOutbox` to coalesce/queue synchronization when the
  feature is enabled. Scheduled fallback also invokes a full sheet refresh
  every five minutes without overlap.
- The sync reads all requests and events, creates a 19-column report, uses
  actor names/event timestamps for approval, assignment and doc-officer
  attribution, writes the replacement range, then clears stale rows only
  after successful write. A configured max row count (default 50,000) is
  enforced. Cells use RAW input.
- Google client credentials are obtained from configured JSON or a file path;
  this audit did not read credentials. Keep credentials server-only and do
  not mirror them into browser code.
- `SyncRequestsToGoogleSheetJob` is configured with three framework retries
  and 90-second timeout. Outbox delivery wraps sync failures for retry, but
  the generic outbox redispatch gap in `03-workflow-transitions.md` means
  automatic retry needs operational correction.

Sources: `backend/app/Integrations/GoogleSheets/GoogleSheetsRequestSync.php`,
`backend/app/Jobs/SyncRequestsToGoogleSheetJob.php`,
`backend/app/Features/Outbox/WorkflowGoogleSheetsOutbox.php`,
`backend/app/Features/Outbox/Handlers/GoogleSheetsSynchronizationOutboxHandler.php`,
`backend/bootstrap/app.php`,
`backend/tests/Feature/GoogleSheetsRequestSyncTest.php`,
`backend/tests/Feature/GoogleSheetsOutboxDeliveryTest.php`.

The original frontend’s spreadsheet action opens a sheet URL directly
(`frontend/src/lib/requests.ts`); that link does not itself prove write access
or server synchronization.

## Intraday dispatch sync

- Google Apps Script reads a Workspace-owned sheet and posts rows to the
  `sync-intraday` Supabase Edge Function. Setup and a sample time-driven
  script are documented in `docs/docs/intraday-sync-setup.md`.
- Function accepts POST from allowlisted `google-apps-script` source only;
  verifies timestamped HMAC-SHA256 with a 300-second skew limit; limits body
  to 1 MB and 1,000 rows; validates date/hour/nonnegative quantity; aggregates
  duplicate date/hour keys; and service-role upserts on
  `(dispatch_date,hour)`.
- Rows with non-`SOC_LHTransporting` status are skipped when a status is
  supplied. Malformed rows count as rejected. Response includes received,
  processed and rejected counts; provider/database details are not returned.
- Function and tests: `supabase/functions/sync-intraday/index.ts`,
  `supabase/functions/sync-intraday/index_test.ts`.

## Outbox, retries, scheduling and observability

- `workflow_outbox` handles notification creation, SeaTalk provisioning,
  SeaTalk synchronization and Sheets synchronization. A unique idempotency
  key prevents duplicate intent records for the same key. Processing claims a
  pending/due or stale-processing row, increments attempts, and marks
  completed, pending-with-backoff, or dead-letter. Backoff is exponential,
  bounded by configuration, with default maximum attempts five.
- Notifications carry outbox correlation and are deduplicated by a unique
  outbox ID where that column is installed. Notification delivery is a
  database insert; front-end reads are role/user scoped and per-user reads
  are recorded separately.
- Laravel scheduler runs Sheets sync every five minutes, prunes idempotency
  keys hourly, retries user audit events every five minutes, expires SeaTalk
  assignments every minute, and reconciles SeaTalk approvals every five
  minutes.
- **Verified gap:** no scheduled command/job scanner for due pending workflow
  outbox rows was found. `ProcessWorkflowOutbox` has one queue attempt and
  only persists retry state; a redispatcher is needed for actual autonomous
  outbox retries. Notification outbox rows can remain pending without
  delivery. SeaTalk reconciliation and the periodic full Sheets sync can
  recover some external side effects independently, but do not drain or
  complete their outbox rows. Existing tests assert the row becomes `PENDING`,
  not that a later attempt is automatically enqueued.
- Outbox status API/command exposes counts without payloads and is admin
  gated. Request telemetry/security headers are registered in
  `backend/bootstrap/app.php`.

Sources: `backend/app/Features/Outbox/WorkflowOutboxWriter.php`,
`backend/app/Features/Outbox/WorkflowOutboxRepository.php`,
`backend/app/Jobs/ProcessWorkflowOutbox.php`,
`backend/app/Features/Outbox/WorkflowOutboxStatusController.php`,
`backend/app/Console/Commands/WorkflowOutboxStatusCommand.php`,
`backend/app/Console/Commands/PruneIdempotencyKeys.php`,
`backend/app/Console/Commands/RetryUserEvents.php`,
`backend/app/Jobs/ExpireSeaTalkAssignments.php`,
`backend/bootstrap/app.php`,
`backend/tests/Feature/WorkflowOutboxProcessingTest.php`,
`backend/tests/Feature/WorkflowNotificationOutboxTest.php`.

## V2 architecture recommendation

Keep provider credentials and service-role access in server-only runtime
configuration. Use Next.js App Router Route Handlers as a thin HTTP boundary;
put role-aware commands, validation schemas, transition rules and query
services in server-only TypeScript modules. Use a cookie-aware Supabase Auth
server client to obtain the authenticated identity, then load the active
profile and authorize each operation on the server. Let RLS remain an
independent data boundary.

Workflow changes that update a request, append an event and create outbox
intent must be atomic. Implement the transactional boundary with a carefully
permissioned PostgreSQL function/RPC or a server-side PostgreSQL transaction;
do not split the state write, history event and notification into independent
HTTP writes. Use a durable scheduled/queue worker for outbox delivery rather
than relying on a Next.js request process to remain alive. Keep SeaTalk and
Google Sheets behind typed adapters with mocked contract tests and explicit
timeouts, retries, idempotency keys and dead-letter alerting.
