# SOC5 Outbound v2 — approved business decisions

## Decision status and scope

This register records **46 of 46 decisions approved for v2 planning** in the
decision history supplied for this update. These are user-confirmed design
decisions for planning; they are **not** evidence of implementation, formal
company authorization, completed technical verification, or approved
production configuration.

The approved policies below govern v2 design where earlier recommendations
or unresolved-decision notes in documents 01–08 differ. Those documents may
still describe useful source behavior or technical risks; they do not
supersede these approved policies. Outstanding technical verification,
production configuration, and acceptance evidence are tracked separately in
[`10-implementation-readiness.md`](./10-implementation-readiness.md).

**APR-3 exception approved:** when FTE Ops rejects a request created by FTE
Ops, the rejection is final. Do not route it for correction or allow
resubmission.

## Approved decision register

### A. Approval workflow — 7 decisions

| ID | Approved v2 policy |
|---|---|
| APR-1 | Preserve the five-stage workflow: Ops PIC creates request ("PENDING") → FTE Ops approves ("REQUESTED") → FTE MM assigns truck ("DOCKING") → Doc Officer assigns Driver ID (remains "DOCKING") → creator Ops PIC enters Linehaul Trip Number ("DOCKED"). |
| APR-2 | Preserve "REROUTED" status compatibility and existing FTE Ops review. Do not introduce new rerouting actions. |
| APR-3 | Preserve rejection handling: FTE Ops rejection of an Ops PIC-created request returns it to its creator Ops PIC for correction and resubmission; FTE Ops rejection of an FTE Ops-created request is final, with no correction route or resubmission; FTE MM rejection returns it to FTE Ops. |
| APR-4 | Only the creator Ops PIC can finalize docking after Driver ID assignment, by entering the Linehaul Trip Number. |
| APR-5 | Creator Ops PIC may edit existing permitted fields after "DOCKED". Preserve "DOCKED" status, notify affected users, and record original and updated values in the audit trail. |
| APR-6 | Preserve role- and status-based cancellation permissions. FTE MM cancellation requires remarks. Audit every cancellation. |
| APR-7 | Preserve SeaTalk presence checks, round-robin approval routing, assignment expiry and reassignment. Use configurable timing with production values requiring validation. |

### B. Request statuses — 8 decisions

| ID | Approved v2 policy |
|---|---|
| ST-1 | Preserve historical "ASSIGNED" records. Exclude them from actionable queues until verified. |
| ST-2 | Preserve raw "REJECTED_BY_MM" as a historical rejection. Do not automatically convert it to "CANCELLED" or reactivate it. |
| ST-3 | Preserve raw "CONFIRMED". Display as "DOCKED" only after business equivalence verification. Unverified records remain non-actionable. |
| ST-4 | Convert "FOR_DOCKING" to "DOCKING" only after verifying workflow completeness and authorization. Preserve original status and evidence. Incomplete records remain non-actionable. |
| ST-5 | Convert verified "APPROVED" records to "REQUESTED", retaining original status and approval evidence. Do not trigger workflow side effects. |
| ST-6 | Use safeguarded automatic normalization for records with complete and consistent evidence. Preserve originals, require preview and reconciliation, prevent side effects, and flag ambiguous records as "LEGACY_UNRESOLVED" for manual review. |
| ST-7 | Treat "ASSIGNED" as historical-only. Use "DOCKING" for active requests, retaining "ASSIGNED" as a role-specific display label where appropriate. |
| ST-8 | Maintain separate request lifecycle "status" and "approval_status" fields. |

### C. KPI calculations — 7 decisions

| ID | Approved v2 policy |
|---|---|
| KPI-1 | Confirmed requests equal the count of canonical "DOCKED" requests, including only verified qualifying historical mappings. |
| KPI-2 | **Option B.** Approval time = final approval timestamp minus the latest submission timestamp. Exclude previous rejection/resubmission cycles. |
| KPI-3 | Preserve original formulas: Waiting time = "provide_time - request_timestamp". Dwell time = "linehaul_trip_at - request_timestamp". |
| KPI-4 | Administrators can configure shift start, duration and reporting timezone. Sandbox defaults: 18:00 start, 13 hourly intervals, "Asia/Manila". Historical reports retain their original schedule definitions. |
| KPI-5 | Administrators can configure default reporting periods. Preserve month-to-date KPI summaries and last 30 calendar dates for daily reports as available defaults. Users can select custom periods. |
| KPI-6 | Full KPI analytics and reporting require an explicitly assigned reporting permission, independent of operational role. Enforce through backend APIs and Supabase RLS. Apply the same restriction to exports. |
| KPI-7 | Implement a complete KPI dashboard with realtime metrics, hourly charts, filters, trends and authorized downloadable reports. |

### D. SeaTalk integration — 7 decisions

| ID | Approved v2 policy |
|---|---|
| SEA-1 | SeaTalk Approval Center is mandatory for approval operations. Internal approval bypass is prohibited. During provider outages, approvals remain pending and failed operations must be safely retried. |
| SEA-2 | Verify official SeaTalk API endpoints, authentication, payloads, response codes and callbacks. Complete sandbox tests before production approval operations. |
| SEA-3 | Follow official SeaTalk callback verification requirements. Review additional timestamp freshness and replay protections separately. Ensure duplicate callbacks cannot repeat workflow actions. |
| SEA-4 | Use provider-scoped event IDs and payload hashes for deduplication. Accept exact duplicates without reprocessing; detect conflicting payloads. Use content-based fallback only when provider IDs are absent. |
| SEA-5 | The SOC5 database is authoritative for workflow state. Incorporate verified SeaTalk decisions and reconcile conflicts without overwriting newer valid decisions. |
| SEA-6 | Preserve round-robin routing with configurable presence and assignment expiry. Sandbox defaults: 60-second presence freshness and 180-second assignment expiry. Administrators may configure production timings after validation. |
| SEA-7 | Allow automatic registration for verified SeaTalk organization members. Validate OAuth identity, organization membership and approved email domain. Create accounts in "PENDING_APPROVAL" without operational access. Administrator approval and explicit role assignment are required. |

### E. Notifications — 6 decisions

| ID | Approved v2 policy |
|---|---|
| NOT-1 | Support in-app notifications and SeaTalk alerts for approvals and important operational events. Implement retries, deduplication and auditing. |
| NOT-2 | Use hybrid notification targeting. General role notifications follow current role membership; sensitive approval notifications are restricted to explicitly assigned recipients at event time. |
| NOT-3 | Track notification persistence, SeaTalk provider acknowledgment where supported, and user read receipts separately. Realtime events are best-effort signals, not proof of delivery. |
| NOT-4 | Implement automatic retries with exponential backoff, dead-letter handling, recovery monitoring and operator alerts. Approve production retry limits, recovery targets and alert thresholds before deployment. |
| NOT-5 | Only administrators may manually retry or abandon dead-lettered notifications. Require a reason and immutable audit record. Preserve automatic retry processing. |
| NOT-6 | Use administrator-configurable notification and callback retention periods within approved company policies. Support automatic expiry, archival/deletion, legal holds, restricted access and audit logging. |

### F. Operational/API rules — 5 decisions

| ID | Approved v2 policy |
|---|---|
| OPS-1 | **Option C — final approved pagination decision; replaces the earlier Option A approval.** Implement configurable queue page sizes with server-enforced limits, cursor-based pagination, stable sorting and server-side filtering. Initial page-size options: 25, 50 and 100; maximum 100 records per request. |
| OPS-2 | Use "/api/v1" for new backend endpoints. Do not recreate legacy unversioned aliases unless a verified integration requires compatibility. |
| OPS-3 | Immediately revoke disabled users and removed permissions. Invalidate sessions and permission caches; enforce changes on subsequent protected requests and realtime access. Verify the implementation's actual revocation delay. |
| OPS-4 | Require idempotency keys for state-changing APIs, retaining successful responses for 24 hours. Return the original result for matching retries, reject conflicting payload reuse and use separate callback deduplication. |
| OPS-5 | Implement a dedicated background worker with automatic retries, exponential backoff, dead-letter handling, monitoring and operator alerts. Require approved production recovery targets before deployment. |

### G. Hub access and administration — 6 decisions

| ID | Approved v2 policy |
|---|---|
| HUB-1 | Preserve creator-scoped Ops PIC request visibility and broader FTE Ops, FTE MM and Doc Officer visibility. Workflow actions remain role-, state- and authorization-restricted. |
| HUB-2 | Preserve existing access without mandatory hub assignments. Ops PIC remains creator-scoped; operational roles retain broader request visibility. |
| HUB-3 | Preserve broad FTE Ops and FTE MM request visibility across hubs. Do not introduce a separate Central FTE role. |
| HUB-4 | Allow controlled administrator workflow overrides with explicit permission, mandatory justification, strong identity verification, SeaTalk compliance, immutable auditing, workflow validation and affected-user notifications. Never allow historical audit records to be modified or deleted. |
| HUB-5 | Allow Ops PIC, FTE Ops, FTE MM and Doc Officer to access operational Intraday Dispatch data. Advanced analytics and report exports require dedicated reporting permission. Align backend and Supabase RLS. |
| HUB-6 | **Option B.** Preserve registered directory selection and validated free-text cluster entry. Validate required fields, formats and registered-cluster references. Free-text values must never grant authorization. |

## Coverage matrix

| Decision area | Approved decisions recorded |
|---|---:|
| Approval workflow | 7 |
| Request statuses | 8 |
| KPI calculations | 7 |
| SeaTalk integration | 7 |
| Notifications | 6 |
| Operational/API rules | 5 |
| Hub access and administration | 6 |
| **Total** | **46 / 46** |

Each decision identifier appears once in the register above. The pagination
policy is the final Option C approval; the earlier Option A approval is
superseded. The APR-3 exception for FTE Ops-created requests is now approved
as a final rejection with no correction route; it is incorporated within
APR-3 and is not a forty-seventh decision.

## Technical and production status

Approval of these business policies does not verify that the implementation,
database, migrations, integrations, dashboard, or operations meet them.
Production configuration values and evidence remain open. Use the separate
implementation-readiness checklist for technical acceptance criteria,
production configuration, and deployment gates.
