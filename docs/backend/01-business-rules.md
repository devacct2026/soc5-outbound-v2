# Business rules: SOC5 Outbound

## Audit scope and evidence

This is a source audit of `outbound-project/soc-5-outbound` at commit
`e54f3508a38ebd91926edbfd266d9452fdcff5f6` (2026-10-14). “VERIFIED” means
the behavior is implemented in the audited source and/or covered by a named
test. It does not mean a business owner has confirmed that the behavior is
still desired. “UNVERIFIED” identifies missing or ambiguous business intent;
do not implement it as a rule without confirmation.

No production database, production credentials, or live integration data were
accessed.

## Request lifecycle

### Creation

**VERIFIED**

- The API permits `ops_pic` and `fte_ops` to create a request. New requests
  start at `PENDING`; the creator and an initial `REQUEST_CREATED` event are
  recorded. An `fte_ops` role notification is produced. See
  `backend/app/Features/Requests/RequestService.php`.
- Required fields: `cluster` (string, max 120), `region` (string, max 120),
  `dock_no` (string, max 50), `backlogs` (integer >= 0), `truck_size`
  (`4W`, `4WAUV`, `4WCV`, `6W`, `10W`, `6WF`) and `truck_type`
  (`WETLEASE`, `DRYLEASE`). `backlogs_timestamp` is nullable date.
  See `backend/app/Features/Requests/RequestController.php`.
- The UI normally searches the cluster directory and copies region, dock,
  backlog and timestamp from the selected result. The server validates those
  values as fields, but does not require `cluster_id` or prove that the region,
  dock or backlogs match an active cluster. See
  `frontend/src/components/OutboundRequestForms.tsx` and the request rules in
  `backend/app/Features/Requests/RequestController.php`.
- If Approval Center routing is enabled, creation schedules the next
  round-robin FTE Ops assignment after commit. Otherwise it provisions the
  SeaTalk item if a provisioner is configured. These are configuration-gated,
  not unconditional request requirements.

### Editing and resubmission

**VERIFIED**

The rules below describe the audited source implementation. Approved v2
policy APR-3 distinguishes FTE Ops rejection by request creator: an
Ops PIC-created request returns to its original Ops PIC creator, while an
FTE Ops-created request is finally rejected without a correction route or
resubmission. See
[`03-workflow-transitions.md`](./03-workflow-transitions.md) for the target
authorization, transition, notification and audit requirements.

- FTE Ops can edit `PENDING` and `REROUTED` requests. A rejected request can
  be edited only by the role in `rejection_return_role`; the Ops PIC must also
  be its creator. An Ops PIC creator can edit a `DOCKED` request. Other stages
  are not editable through the detail-update endpoint.
- Editable fields are cluster, region, dock, backlog, backlog timestamp,
  truck size and truck type. Editing a rejected request returns it to
  `PENDING`, resets approval state to `PENDING`, clears its return role,
  increments the approval version and records a new correlation ID.
- Edits emit a request event and notifications. A post-docking edit keeps the
  status `DOCKED` and notifies operational roles.
- Evidence: `backend/app/Features/Requests/RequestAuthorizer.php`,
  `backend/app/Features/Requests/RequestService.php`,
  `backend/tests/Feature/RequestWorkflowTest.php`.

### Cancellation and validation

**VERIFIED**

- An Ops PIC may cancel their own `PENDING`/`REROUTED` request, and a rejected
  request returned to `ops_pic`. FTE Ops or FTE MM may cancel only when their
  role is the request’s `next_action_role`. A cancel action records
  `CANCELLED`, approval status `CANCELLED`, source `WEB`, a new version and
  correlation ID, closes active SeaTalk assignments, emits an event, and
  notifies the creator and operational roles.
- FTE MM cancellation remarks are required. Other roles may omit them.
  Remarks are limited to 2,000 characters.
- Rejection remarks are required for both Ops FTE and Midmile rejection
  (maximum 2,000 characters at the API boundary). Midmile truck assignment
  requires plate number, truck size and truck type; the backend sets
  `provide_time` to the current time even if a client provides another value.
- Doc Officer driver IDs must be 1–10 decimal digits. A driver can be
  reassigned only after one is already assigned. Doc Officer docking action
  uses the same `mark-docked` action name but assigns a driver and does not
  complete docking.
- The action endpoint rejects unexpected payload fields. Request creation and
  edits use server-side validation; UI constraints are not the authority.
- Evidence: `backend/app/Features/Requests/RequestController.php`,
  `backend/app/Features/Requests/RequestAuthorizer.php`,
  `backend/app/Features/Requests/RequestService.php`,
  `backend/tests/Feature/RequestAuthorizationMatrixTest.php`,
  `backend/tests/Feature/RequestWorkflowTest.php`.

## Midmile, docking and dispatch

**VERIFIED**

- FTE MM works `REQUESTED` items. Assigning a truck records plate, truck size,
  truck type and provide time, then moves the request to `DOCKING` and
  notifies the Doc Officer. FTE MM can reject with remarks; this produces
  `REJECTED` with return role `fte_ops`, so FTE Ops edits and re-approves.
- The Doc Officer queue is `DOCKING` requests with no driver ID. Assigning a
  driver records `driver_assigned_at` and keeps the status `DOCKING`; driver
  reassignment is a separate explicit action.
- The creator Ops PIC queue includes `DOCKING` requests that have a driver
  ID. The Ops PIC enters the linehaul trip number; this moves the request to
  `DOCKED` and records the trip/docking timestamps. The API requires a driver
  before accepting the trip number.
- FTE MM’s display maps `DOCKING` to `ASSIGNED`; Doc Officer and FTE MM see
  `REROUTED` as `PENDING`. These are display values; stored state remains
  unchanged.
- Queue page size is bounded to 100, with a cursor contract available at the
  API. The audited UI loads up to 100 queue items and does not expose cursor
  pagination in the queue notification hook.
- Evidence: `backend/app/Features/Requests/RequestStatus.php`,
  `backend/app/Features/Requests/RequestRepository.php`,
  `backend/app/Features/Requests/RequestService.php`,
  `frontend/src/pages/MidmileRequests.tsx`,
  `frontend/src/pages/DockingConfirmation.tsx`.

## Reporting and KPI definitions

**VERIFIED**

- `GET /api/v1/kpi/summary` scopes rows by `request_timestamp`, uses the
  business timezone (default `Asia/Manila`), and defaults from the current
  month start through the current day end. `total` counts all statuses;
  `confirmed` counts `DOCKED`; `cancelled` counts `CANCELLED`;
  `averageApprovalMinutes` averages `approved_at - request_timestamp` over
  rows with a non-null `approved_at`.
- `GET /api/v1/kpi/daily` defaults to the last 30 calendar dates and returns
  daily total and `DOCKED` counts. The daily date grouping uses business
  timezone in PostgreSQL.
- Request analytics reports truck-size counts, hourly requests for a
  13-hour shift beginning at 18:00 local time, average waiting minutes
  (`provide_time - request_timestamp`) and average dwell minutes
  (`linehaul_trip_at - request_timestamp`). Ops PIC analytics are creator
  scoped; other operational roles are not hub-scoped.
- `intraday_dispatch` is a separate source from request KPI calculations.
  The API returns 24 hour rows in an order beginning at 06:00; missing values
  are returned as zero.
- The original React `Kpi` page is explicitly a placeholder, despite these
  backend reporting endpoints. See `frontend/src/pages/Kpi.tsx`,
  `backend/app/Features/Kpi/KpiController.php`,
  `backend/app/Features/Requests/RequestRepository.php` and
  `backend/app/Features/Dispatch/DispatchController.php`.

**UNVERIFIED / MIGRATION DECISIONS**

- No source establishes a hub-level authorization rule. Profiles do not carry
  a hub assignment, requests do not require a hub foreign key, and several
  FTE/Doc Officer reads are global. Confirm the intended hub boundary before
  migration; do not infer it from `clusters.hub_name`.
- The KPI API’s metric names are implemented, but no audited source confirms
  whether the business definition of “confirmed”, approval duration, dwell or
  shift boundary is still accepted. The current formulas are the preservation
  baseline pending owner sign-off.
- The `REJECTED_BY_MM` historical status was mapped to `CANCELLED` in a
  forward migration. That mapping is implemented, but the audited source does
  not establish that these two outcomes are semantically interchangeable.
  Preserve historical meaning or obtain explicit approval for the mapping.

## Source map

- Request write rules: `backend/app/Features/Requests/RequestController.php`,
  `backend/app/Features/Requests/RequestService.php`
- Authorization and statuses: `backend/app/Features/Requests/RequestAuthorizer.php`,
  `backend/app/Features/Requests/RequestStatus.php`
- Queue, analytics and actor scoping: `backend/app/Features/Requests/RequestRepository.php`
- UI forms and actions: `frontend/src/components/OutboundRequestForms.tsx`,
  `frontend/src/components/request/MidmileActionDialog.tsx`,
  `frontend/src/components/request/DockDialog.tsx`
- Tests: `backend/tests/Feature/RequestWorkflowTest.php`,
  `backend/tests/Feature/RequestAuthorizationMatrixTest.php`,
  `backend/tests/Feature/RequestWorkflowMigrationTest.php`,
  `backend/tests/Feature/PostgresReportingTest.php`
