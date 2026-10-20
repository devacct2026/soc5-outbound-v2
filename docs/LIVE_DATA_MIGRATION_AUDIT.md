# SOC5 Outbound V2 — Live Data Migration Audit

**Audit date:** 2026-10-19  
**Purpose:** Identify frontend demo, mock, static, and placeholder operational
data in V2 and map it to the original GitLab implementation and V2 backend.
This is an audit only; no application behavior or schema has been changed.

## 1. Repository snapshots and method

Both advertised repository heads were fetched before comparison:

| Repository | Fetched HEAD | Date / subject |
|---|---|---|
| Source GitLab `outbound-project/soc-5-outbound` | `5ccb0e0df504c3ea80f4fd11d99aad0bfd5ef3b0` | 2026-10-19 — Apply shadcn dashboard-01 shell and remove Medesk template |
| Target GitHub `devacct2026/soc5-outbound-v2` | `97199e84b3a8751f96712adbe9832adbc815f8a3` | 2026-10-19 — remove unnecessary libc lockfile entries |

The GitLab source was mirrored with all advertised refs and history (290
commits across branches). History was reviewed across the full ref set and by
relevant frontend, backend, migration, and Edge Function paths. Relevant
source branch tips include `main` (`5ccb0e0`), `staging` (`82d8fa3`),
`seatalk-integration` (`6a34650`), `kpi-routing` (`4b73e4a`),
`shell-dashboard` (`10baac1`), and
`hardening/production-launch-gates-20261015` (`6d9959b`). The latest source
shell commit changes presentation; the operational behavior cited below is
traced to the earlier workflow commits listed in the matrix.

V2 is at `main` and has no V2-only source branch checked out. Relevant V2
milestones include:

| V2 commit | Significance |
|---|---|
| `121950ba6e111e53cbe2749bab40ae2c1f6f09bd` | Dashboard API overlay: authenticated requests, pipeline, KPIs |
| `01819bc0e484179cd10ef1585c9d1460da6a7931` | Supabase source-parity schema foundation |
| `c12de08288d0ed72ee4225cd533c91945df7124d` | Role-based queue actions |
| `b8e9b8a755c725451d90c2f924169872e89fda8d` | SeaTalk approval provider and routing |
| `5c3a087f8f2aed80edf3b326cc7c1dcbbf623259` | Cluster sync, backlog propagation, notification feed |
| `1bfa42db430a8cd7f35d51d9532bde3a60162685` | Request workspace, notifications, KPIs, reports, users, auth, and realtime |
| `c9792726e8e9ae081a6d02799f60a1c991d56900` | V2 sync endpoints and dashboard enhancement |
| `2504a6aa8b43e67f3949f889b78b06269deb6853` | Integrate original Supabase sync behavior |

**Evidence limits:** Repository/code inspection only. No production project,
credentials, operational records, SeaTalk tenant, Google Workspace caller, or
live Supabase deployment was accessed. V2's backend documentation states that
live-project execution has not been verified. “Implemented” below means
present in the checked-in code, not confirmed against a production service.

## 2. Executive findings

1. **The dashboard is not consistently live.** The default dashboard data
   model in `src/lib/dashboard-data.ts` contains fabricated KPI cards,
   charts, requests, activities, pipeline counts, and eight dock statuses.
   `src/components/dashboard/dashboard.tsx` uses these values when signed out
   and also while authenticated API data is still null or after the primary
   live request load fails. The dashboard does show a connection/error
   indicator, but still renders sample-shaped operational values.
2. **Several V2 workflows are already API-backed.** Request CRUD and workflow
   actions, queue/approval actions, intraday dispatch, reports/exports,
   account administration, notifications, cluster search/import, signed
   syncs, and realtime refresh/recovery have existing V2 implementation
   surfaces. The audit recommends completing their presentation/data wiring,
   not replacing those services or reimplementing their business rules.
3. **The module shell remains an active placeholder.** `ModulePage` supplies
   hardcoded metrics and example operational items for Requests, Approvals,
   Queue, Docking, Intraday KPI, Notifications, Users, Reports, and Settings.
   It is rendered alongside live panels on the corresponding pages, so users
   can see contradictory live and fabricated content at once.
4. **Dock inventory and driver directory are not evidenced as backend
   entities.** V2 supports request-level truck/driver assignment and trip
   number actions; the migrations have no dock-status or driver-directory
   table. The original request schema also models `dock_no` and `driver_id` on
   requests rather than an independent inventory. Do not invent such a
   directory or statuses. Remove/replace the mock dock grid only with
   source-supported data or a separately approved backend contract.
5. **Some error paths can become empty results or retain demo values.**
   Dashboard intraday failure is caught as `null`; cluster-search failure
   clears results without a user-visible notice; unread-count failure is
   suppressed for the badge. Dashboard fallback values are static rather than
   a loading/empty/error state.
6. **Business decisions in V2 supersede direct source behavior where
   explicitly approved.** The approved decision register (46 decisions,
   including APR-3 and KPI/SeaTalk/notification policies) and V2 parity matrix
   govern implementation. The source is the technical reference, not
   authority to silently reverse those decisions.

## 3. Source-to-V2 mapping matrix

Paths in this table are repository-relative. Source SHAs identify commits
containing or materially updating the cited source workflow; source HEAD at
`5ccb0e0df504c3ea80f4fd11d99aad0bfd5ef3b0` was also checked.

| Feature | V2 frontend and current data source | Original implementation and source commit | Existing V2 API / Supabase | Gap and required change |
|---|---|---|---|---|
| **Dashboard KPIs, pipeline, request list, activity, charts** | `src/components/dashboard/dashboard.tsx`; `src/components/dashboard/live-dashboard.tsx`; static values in `src/lib/dashboard-data.ts`. Authenticated overlay calls `/requests?limit=100`, `/requests/metrics`, `/dispatch/intraday`; until `live` exists the page uses static `requests`, `kpis`, `pipeline`, and `activities`. Dock grid always uses static `docks`. Expansion adds a fixed example activity. | `frontend/src/pages/Overview.tsx` queries `/requests`, date-bounded `/requests/summary`, and `/dispatch/intraday`; computes summary/chart/pipeline from API results. Source dashboard query behavior updated in `d37005a217c4005d082bf27a42ebab0a12bca577`. `frontend/src/pages/Kpi.tsx` is explicitly “under construction” at source commit `a0205b284573e29f8051548a068b8510776725be`; do not treat that page as an implemented KPI source. | V2: `GET /requests`, `GET /requests/metrics`, `GET /dispatch/intraday`; `requests`, `request_events`, `intraday_dispatch`; reporting SQL functions described below. | Remove the demo values from operational presentation. Provide loading, empty, and error states instead of fallback sample values. Dashboard metrics use unbounded `/requests/metrics`; source Overview uses date-filtered summary. Validate each card's definition and date scope against V2-approved KPI decisions before wiring. `buildKpis` labels `REQUESTED` count “Approved Today” without filtering to today; dashboard intraday date uses UTC `toISOString()` whereas reporting defaults use Asia/Manila. The intraday request catch in `live-dashboard.tsx` hides its failure and renders missing/zero-shaped data. |
| **Intraday Dispatch** | `src/components/ops/reports-panel.tsx` (`IntradayPanel`) loads by date from API. Dashboard also fetches intraday data. | Source Supabase Edge Function `supabase/functions/sync-intraday/index.ts` and frontend dashboard query. Edge sync implementation was updated at `3048f822e74f6609caab1afa43ed66084e0ba48b`; HMAC sync behavior is also present in `c7f4475012c4e9772d834c5236eb9ec45bf91497`. | `GET /dispatch/intraday?date=...`; `POST /integrations/intraday/sync`; `intraday_dispatch`; scheduled Google Apps Script source integration uses timestamped HMAC-SHA256, freshness/body/row limits, status filtering and date/hour aggregation. | Core path is live-backed. Surface loading and empty states distinctly, preserve the visible error, and report dashboard sync errors instead of swallowing them. Confirm date construction and shift boundaries use the approved Asia/Manila schedule. Live endpoint/provider execution has not been verified. |
| **Outbound requests, approvals, history, bulk action** | `src/components/ops/requests-workspace.tsx`; `src/components/dashboard/action-queue.tsx`; `src/domain/requests/*`; `src/lib/request-ui.ts`. These panels call APIs for list/create/edit/resubmit/cancel/events/bulk approve and workflow actions; UI permissions are hints, server is authoritative. `ModulePage` still renders hardcoded metric/item copy on these pages. | Source `frontend/src/pages/OutboundRequests.tsx`, `frontend/src/hooks/useOutboundRequests.ts`, `backend/app/Features/Requests/{RequestController,RequestService,RequestAuthorizer,RequestRepository}.php`; workflow automation commit `239e921e7b78bf8f5aefc4f25ccad5b7aa3b893e`; request frontend refinements `510cf0d2fee576b2bb2658f5a4e6d7ab917571da`. | `GET/POST /requests`, `PUT /requests/{id}`, `GET /requests/{id}/events`, `GET /requests/queue`, `GET /requests/metrics`, `POST /requests/bulk-approve`, `POST /requests/{id}/{action}`; `requests`, `request_events`, `audit_events`, `idempotency_keys`, `workflow_outbox`; `commit_transition`, `queue_requests`. | Main workflow is API-backed. Remove sample module content; retain the V2 workflow state machine, role checks, idempotency, event/audit log, pagination and validation. Resolve behavior only by the V2-approved decision register, not by assuming all source legacy statuses should be normalized. |
| **Queue, approval routing, docking actions and driver assignment** | `src/components/dashboard/action-queue.tsx`; routes `/queue`, `/approvals`, `/docking` use the same live queue/action panel. Static dock tiles and module summaries remain in the dashboard/module shell. Driver input is a manually entered Driver ID. | Source `frontend/src/pages/MidmileRequests.tsx`, `frontend/src/pages/DockingConfirmation.tsx`, `backend/app/Features/Approvals/ApprovalService.php`, `backend/app/Features/Requests/RequestService.php`; workflow `239e921e7b78bf8f5aefc4f25ccad5b7aa3b893e`; SeaTalk approval implementation `34f233af3e4e6d52edcf52919531ca1b1443b3f2`. | `GET /requests/queue`; `POST /requests/{id}/approve`, `/reject-ops`, `/reject-mm`, `/assign-truck`, `/assign-driver`, `/reassign-driver`, `/dock`; presence `/presence/heartbeat`; `requests`, `request_events`, `seatalk_approval_assignments`, `approval_routing_cursors`, `workflow_outbox`, `audit_events`; `assign_next_approver`, `expire_assignments`, `orphan_approval_requests`, `commit_transition`. | Request-level operations are present; there is no V2 dock-inventory or driver-directory API/table. Do not present fake dock availability, queue ETA, utilization or driver records as live. Preserve APR-1 through APR-7, especially creator-only final docking and mandatory SeaTalk approval; verify backend provider configuration before claiming approval is operational. |
| **Hubs / cluster directory and backlog** | `src/components/ops/request-form.tsx` searches `/clusters?search=...`; `src/app/api/v1/clusters/route.ts`; static dashboard copy references hubs. No standalone directory page or live hub dashboard is present. | Source `frontend/src/pages/OutboundRequests.tsx`, `backend/routes/api.php` cluster route, `supabase/functions/sync-clusters/index.ts`, `supabase/migrations/002_cluster_import_compatibility.sql` and `20260929000000_propagate_cluster_backlogs.sql`; sync-related source commit `3048f822e74f6609caab1afa43ed66084e0ba48b` (original sync contract additionally visible in earlier history). | `GET /clusters`; `POST /integrations/clusters/sync`; `clusters`, `requests`, `request_events`, `audit_events`; `import_clusters` and backlog propagation trigger/function. Sync is server-side signed and persists through service-role backend. | Cluster search/import exists, but query errors are caught and converted into empty options without a notice, and an empty result has no explicit no-match state. There is no separate hub directory surface. The V2 gap analysis says hub restriction is undefined; do not add hub-level authorization or invent a hub rule without approval. |
| **User accounts, roles, permissions and authentication** | `src/components/ops/users-panel.tsx`; `src/components/ops/sign-in.tsx`; `src/components/ops/common.tsx`; `src/server/auth/*`; `src/domain/permissions.ts`. User list and admin mutations are API-backed; `ModulePage` user metrics/examples are static. | Source `frontend/src/pages/UserManagement.tsx` (updated in `2cfa16dd5b64fa6d9527cca71acd77652b3a3e32`), `frontend/src/lib/api.ts`, source Supabase migrations `003_auth_flows.sql`, `019_identity_and_audit_hardening.sql`, and source backend Auth/Users features. | `/auth/login`, `/auth/me`, `/auth/status`, OTP, Google/SeaTalk auth flows; `GET/POST /users`, `PUT /users/{id}`, disable/reset routes, `/admin/accounts/{id}/approve`; `profiles`, `audit_events`; `admin_create_backroom_user`, `admin_update_user`, `admin_disable_account`, `admin_mark_password_reset`, `submit_access_request`, `handle_new_auth_user`. | Core account/role management is live-backed. Remove only mock directory/metrics copy; retain server authorization, current-profile checks, forced password-change gate, approval/audit reason, and V2-approved roles. Validate real provider/GoTrue flows and role grants in an approved sandbox. Service-role key is server-only (`SOC5_SUPABASE_SERVICE_ROLE_KEY`); never move it to browser config. |
| **Notifications and SeaTalk integrations** | `src/components/ops/notifications-panel.tsx`; `src/server/seatalk/*`; `src/app/api/v1/integrations/seatalk/*`; notification badge in dashboard. Feed/read operations call API, but module summary/items and signed-out badge values are static. `useUnreadCount` silently suppresses read errors. | Source `backend/app/Features/Notifications/NotificationController.php`, `backend/app/Features/Approvals/*`, `backend/app/Integrations/SeaTalk/*`, migrations `018_notification_read_receipts.sql`, `021_approval_center_schema.sql`, `022_presence_and_routing_state.sql`, `023_seatalk_callback_events.sql`. SeaTalk Approval Center initial implementation `34f233af3e4e6d52edcf52919531ca1b1443b3f2`; later integration update `510cf0d2fee576b2bb2658f5a4e6d7ab917571da`. | `GET /notifications`, `PATCH /notifications/{id}/read`, `PATCH /notifications/read-all`; SeaTalk approval callback/event/config routes; outbox status/actions; `notifications`, `notification_reads`, `seatalk_callback_events`, `seatalk_approval_assignments`, `workflow_outbox`, `audit_events`; `notification_feed`, `notification_unread_count`, `notification_mark_read`, `claim_outbox`, `admin_outbox_action`. | In-app feed is live-backed; remove static notification examples and provide a visible badge failure state or an explicit non-operational indicator rather than hiding service failure. SeaTalk capability is feature/config/provider-dependent: verify the official contract, callback verification, retries, dedupe, auditing and deployment gates per `SEA-*`/`NOT-*` decisions before calling it live. Do not duplicate source Edge Functions alongside V2 sync handlers. |
| **Reports and analytics** | `src/components/ops/reports-panel.tsx` (`ReportsPanel`) calls API summary/daily/hourly/export; permission gate checks reporting permission. Static report metrics/items remain rendered below it by `ModulePage`. Dashboard charts have static fallback and reporting-period controls. | Source `frontend/src/pages/Overview.tsx`, `backend/app/Features/Kpi/KpiController.php`, `backend/app/Features/Dispatch/DispatchController.php`; dashboard query update `d37005a217c4005d082bf27a42ebab0a12bca577`. Original standalone `Kpi.tsx` is a placeholder, not evidence for fabricated metrics. | `GET /kpi/summary`, `/kpi/daily`, `/kpi/hourly`, `/kpi/export`; `GET /requests/metrics`; `requests`, `request_events`, `reporting_schedules`, `intraday_dispatch`; `kpi_summary`, `kpi_daily`, `kpi_hourly`; export via API, server-side. | Report API/export are present and authorization-gated; delete static “428”, “86%”, “42 min”, sample report names and unsupported “SLA Risk” figures. Confirm definitions, date scopes, shift schedule and trend semantics against KPI-1–KPI-7. V2 approved role-independent reporting permission and preserves Asia/Manila reporting schedule semantics. |
| **Realtime updates and reconnect behavior** | `src/lib/use-live.ts`, `src/lib/realtime.ts`; request, notification, dashboard, user and intraday components subscribe/refetch as applicable. | Source `frontend/src/hooks/useRequestRealtime.ts`; realtime UI implementation `ece42f633302fd1f79d28c8363eeeaaa23cfcdc2`; source migration `supabase/migrations/20261004000000_enable_request_realtime.sql`. | Supabase Realtime `postgres_changes` on `requests`, `notifications`, `intraday_dispatch`, with HTTP refresh and 30-second poll fallback; publication configured by V2 base migration. RLS read policies remain authoritative. | Realtime/refetch design exists; verify live subscription under authenticated roles, reconnect recovery and poll fallback in a real approved environment. It is a refresh signal, not a guarantee of notification delivery. Keep browser anon key public by design and rely on RLS; never expose service credentials. |
| **Settings and route-level placeholder summaries** | `src/components/dashboard/module-page.tsx` supplies a Settings panel with “Data source: Mock” and prototype claims; it also supplies example metrics, static lists and “preview” copy for the operational pages listed above. | No source workflow implementation exists for these V2-only mock labels; compare the source workflows cited in the rows above. The latest source shell commit is `5ccb0e0df504c3ea80f4fd11d99aad0bfd5ef3b0`. | No settings/operational status API is defined for these example values. Existing configuration is server-side environment/backend configuration and frontend theme preference. | Remove mock operational assertions and prototype sample records from operational routes. Keep actual local display preferences as local UI state, clearly separate from operational settings. Do not present hardcoded “All systems operational” or service status as a live health check. |

## 4. Business logic and data protections to preserve

### Source behavior and approved V2 policy

- Original source role enum is `ops_pic`, `fte_ops`, `fte_mm`, `doc_officer`.
  Source request history includes legacy states such as `APPROVED`,
  `REJECTED_BY_MM`, `ASSIGNED`, `FOR_DOCKING`, `CONFIRMED`, and `DOCKED`.
- Source implements request creation, approval/rejection, truck assignment,
  driver assignment, trip-number docking, cancellation, events, queue
  filtering, notification delivery, and reporting. Technical evidence is in
  `backend/app/Features/Requests/`, `backend/app/Features/Approvals/`,
  `backend/app/Features/Kpi/`, source API routes and Supabase migrations.
- V2's [`docs/backend/09-business-decisions.md`](backend/09-business-decisions.md)
  supersedes earlier V2 gap recommendations where it records an approved
  decision. Specifically preserve APR-1–APR-7, status decisions ST-1–ST-8,
  KPI-1–KPI-7, SEA-1–SEA-7 and NOT-1–NOT-6. APR-3 is a documented approved
  exception for final rejection of an FTE Ops-created request. Do not “restore”
  a source behavior that conflicts with those decisions.
- The V2 frontend should remain a client of the existing `/api/v1` services.
  Workflow authorization, state transitions, RLS, audit records, idempotency,
  and sync signature validation belong in the backend/database, not in a
  browser-side rewrite.

### Supabase and integrations

- Source baseline schema is `supabase/migrations/001_initial_schema.sql`:
  `profiles`, `clusters`, `requests`, `request_events`, `notifications`,
  role/status enums and indexes. Source RLS enables protected reads for
  authenticated users and role-scopes requests/events; writes intentionally
  have no browser policy and pass through Laravel's authorization/service
  role. `010_intraday_dispatch.sql` adds an authenticated read policy for
  intraday rows. Source realtime publication includes notifications,
  requests and intraday dispatch (the latter two in
  `20261004000000_enable_request_realtime.sql`).
- Source sync Edge Functions `sync-clusters` and `sync-intraday` accept the
  `google-apps-script` source only, validate timestamped HMAC-SHA256 signatures
  with a 300-second skew bound, cap payloads at 1 MB/1,000 rows, and write
  using server-only service-role credentials. Intraday rows aggregate by
  date/hour and can filter by source status. V2 carries these integrations in
  `POST /api/v1/integrations/clusters/sync` and
  `POST /api/v1/integrations/intraday/sync`; do not deploy a second competing
  write path.
- V2's authoritative schema is its own ordered migration chain:
  `supabase/migrations/20261018000000_base_schema.sql` and subsequent
  migrations. It includes `profiles`, `clusters`, `requests`,
  `request_events`, `notifications`, `notification_reads`, `workflow_outbox`,
  `idempotency_keys`, SeaTalk callback/assignment/routing tables,
  `intraday_dispatch`, `reporting_schedules`, `app_settings`, and
  `audit_events`. All these tables have RLS enabled. Browser writes are
  restricted; backend service-role credentials are server-only. Browser
  realtime uses the public anon key plus user bearer token under RLS.
- Important V2 database functions include `commit_transition`,
  `queue_requests`, `kpi_summary`, `kpi_daily`, `kpi_hourly`, `import_clusters`,
  backlog propagation, `assign_next_approver`, assignment expiry/orphan
  handling, notification feed/read functions, and user-admin functions.
- Source SeaTalk OAuth and Approval Center code is present, but source/V2
  documentation both identify provider verification and production
  configuration as acceptance gates. A checked-in adapter is not proof of
  an enabled/validated production integration. Preserve disabled/pending
  failure behavior rather than bypassing provider or reporting success.

## 5. Gaps and required changes (audit recommendations only)

| Priority | Finding | Required direction |
|---|---|---|
| **P0** | Static operational metrics, sample requests/activity, charts, pipeline and dock states remain in `src/lib/dashboard-data.ts`; the dashboard uses these whenever `live` is null. | Replace demo fallback with explicit loading/empty/error states. Keep only decorative/non-operational fixtures, clearly isolated from live operational data. |
| **P0** | `ModulePage` repeats hardcoded values and sample narratives under routes that also mount live components. | Remove those operational card/list sections or bind each only to an existing authorized API result. Avoid duplicate requests or conflicting figures. |
| **P0** | Dashboard data semantics do not yet match source or documented KPI decisions: all-time status counts are labeled “Today”; latest 100 records feed request flow; dashboard date is UTC; no source-style date-filtered dashboard summary is used. | Define each displayed metric only from approved KPI decisions, then use an appropriate existing endpoint or add a narrowly scoped backend contract if necessary. Do not infer SLA, utilization, trend or daily counts from incomplete rows. |
| **P1** | Dock grid and “available/occupied/maintenance” inventory have no verified backend source; request-level `dock_no` does not establish dock inventory/current occupancy. Driver input is free-form numeric ID, with no directory API/table. | Remove unsupported mock claims. Confirm with product whether source request-level behavior is sufficient. Any new directory/status API or schema requires approved semantics, authorization, auditing and migration design before implementation. |
| **P1** | Hub/cluster search exists, but failures are indistinguishable from no matches; no separate directory exists. The V2 migration gap document notes undefined hub restrictions. | Surface failures and no-match state separately. Do not introduce hub-level access rules absent a documented V2 approval. |
| **P1** | Live dashboard catches intraday errors as null; cluster lookup catch clears options; unread badge catches errors silently. | Display explicit failure/refresh state, or deliberately label optional best-effort indicators. Never substitute fabricated operational values for an API failure. |
| **P1** | Dashboard shell status “All systems operational” and hardcoded approval badge count “8” are not service health or live approval counts. | Bind these to a defined health/API contract or remove the operational assertion/count. |
| **P1** | Core backend-backed features are not confirmed against an actual V2 Supabase project or real identity/SeaTalk/Google sync providers in the inspected environment. | Complete controlled sandbox integration validation. Verify ordered migrations, RLS/grants, role behavior, provider config, signed sync, and audit trail without production credentials in frontend. |
| **P2** | Route-level users/notifications/report empty/loading states and operational status feedback are not uniformly explicit; static module shell obscures the distinction. | Align every data-dependent panel to consistent loading, empty, error, stale/retry states and retain V2 UI layout. |
| **P2** | Source dashboard uses date-filtered summary and source workflows include status/report semantics; V2 uses a separate approved reporting permission and updated workflow definitions. | Record source-to-approved-V2 mapping in focused tests before changing calculations or statuses. Keep legacy normalization guarded and auditable. |

## 6. Recommended implementation phases

These are sequencing recommendations; no implementation was performed.

1. **Baseline and acceptance evidence:** Confirm deployed V2 Supabase project,
   migration version, auth providers, sync caller configuration, SeaTalk
   sandbox readiness, and permission assignments. Run the existing DB/API
   parity and RLS tests in a disposable environment. Do not read or reuse
   source production secrets/data.
2. **Remove false operational data:** Replace `dashboard-data.ts` values and
   `ModulePage` operational examples with loading/empty/error states or
   existing API-backed data. Remove static approval/notification counts and
   unverified system-health status. Preserve layout and navigation UX.
3. **Dashboard metric parity:** Map dashboard cards/charts to approved KPI
   definitions and date/shift windows. Reuse `/requests/metrics`,
   `/dispatch/intraday`, `/kpi/*` where their permissions/contracts fit.
   Decide whether a date-filtered operational summary endpoint is needed;
   do not relabel all-time values as today or calculate unapproved SLA/dock
   utilization metrics.
4. **Operational directory boundary:** Complete cluster lookup UX and assess
   whether any real dock/driver directory is actually required. For
   request-level docking/assignment, reuse existing request APIs. Add
   tables/endpoints only after business contract approval; preserve
   server-side role checks, RLS and audit logging.
5. **Integration and realtime validation:** Verify auth, SeaTalk login and
   approval callbacks, notification outbox retry/deduplication, cluster and
   intraday signed syncs, and realtime reconnect recovery under test users
   and roles. Keep all privileged keys server-side and RLS enabled.
6. **Release acceptance:** Run the checklist below, reconcile displayed data
   against API/database fixtures, and obtain business acceptance for
   dashboard definitions, any new directory semantics, and provider
   configuration before rollout.

## 7. Validation checklist

### Data and UI

- [ ] No operational page shows hardcoded example requests, counts,
  percentages, names, activity events, dispatch volumes, dock statuses or
  notification contents.
- [ ] On first load, show loading rather than sample metrics; on an empty
  response, show a true empty state; on failure, show an actionable error and
  do not render success-shaped mock data.
- [ ] Dashboard KPIs match approved definition, date range, timezone and
  source query; chart values reconcile to returned API rows.
- [ ] Intraday date, Manila shift ordering, totals, peak hour and sync
  timestamp match the signed sync data and reporting schedule.
- [ ] Request and queue list, filters, cursor paging, create/edit/resubmit,
  rejection, cancellation, bulk action, truck/driver assignment and docking
  preserve V2 transition/role behavior and audit events.
- [ ] Cluster search distinguishes loading, no results and failed lookup;
  imported cluster/backlog values and request propagation reconcile.
- [ ] User list and admin actions enforce current authorization; account
  approval, forced password change, disable/reset and audit reasons are
  verified.
- [ ] Notifications distinguish persisted feed, provider delivery/ack, and
  user read receipt; counts and marks reconcile across all visible notices.
- [ ] Reports and exports enforce reporting permission and use approved
  summary, daily, hourly, timezone and historical schedule definitions.

### Security, integrations and recovery

- [ ] Apply only the ordered V2 migration chain to a disposable project; verify
  RLS policies, grants, functions, and realtime publication.
- [ ] Validate `ops_pic`, `fte_ops`, `fte_mm`, `doc_officer`, administrator,
  reporting permission, pending and disabled accounts, and unauthorized
  reads/writes with real Supabase JWTs.
- [ ] Confirm service-role, SeaTalk callback/signing, cluster sync and
  intraday sync secrets are server-only; none appears in client bundles,
  browser storage, errors, or logs.
- [ ] Verify sync source allowlist, HMAC canonicalization, timestamp freshness,
  size/row limits, data validation, duplicate handling, safe retry and
  audited cluster backlog propagation.
- [ ] Verify SeaTalk callback authenticity, replay/idempotency, assigned
  approver identity, provider outage behavior, retry/dead-letter handling,
  reconciliation and no internal approval bypass.
- [ ] Verify realtime subscriptions are RLS-filtered, reconnect triggers a
  refresh, dropped/unconfigured sockets poll only as intended, and events
  are not treated as proof of notification delivery.
- [ ] Run focused unit/API/SQL/Playwright tests and approved sandbox
  end-to-end flows; capture response/database assertions and reconcile
  displayed counts. Do not claim live verification from mocked tests alone.

## 8. Reference index

### Source GitLab

- Latest source: `https://gitlab.com/outbound-project/soc-5-outbound/-/commit/5ccb0e0df504c3ea80f4fd11d99aad0bfd5ef3b0`
- Dashboard query history: `frontend/src/pages/Overview.tsx`,
  `frontend/src/pages/Kpi.tsx`; commit
  `d37005a217c4005d082bf27a42ebab0a12bca577`.
- Request workflow: `backend/app/Features/Requests/`,
  `frontend/src/pages/OutboundRequests.tsx`,
  `frontend/src/hooks/useOutboundRequests.ts`; commit
  `239e921e7b78bf8f5aefc4f25ccad5b7aa3b893e`.
- Docking and queue: `frontend/src/pages/MidmileRequests.tsx`,
  `frontend/src/pages/DockingConfirmation.tsx`; commit
  `239e921e7b78bf8f5aefc4f25ccad5b7aa3b893e`.
- Realtime: `frontend/src/hooks/useRequestRealtime.ts`; commit
  `ece42f633302fd1f79d28c8363eeeaaa23cfcdc2`.
- User administration: `frontend/src/pages/UserManagement.tsx`; commit
  `2cfa16dd5b64fa6d9527cca71acd77652b3a3e32`.
- SeaTalk approval center: `backend/app/Features/Approvals/`,
  `backend/app/Integrations/SeaTalk/`; commits
  `34f233af3e4e6d52edcf52919531ca1b1443b3f2` and
  `510cf0d2fee576b2bb2658f5a4e6d7ab917571da`.
- Supabase sync: `supabase/functions/sync-clusters/`,
  `supabase/functions/sync-intraday/`; commit
  `3048f822e74f6609caab1afa43ed66084e0ba48b`.
- Original schema/RLS/history: `supabase/migrations/001_initial_schema.sql`,
  `010_intraday_dispatch.sql`, `018_notification_read_receipts.sql`,
  `019_identity_and_audit_hardening.sql`, `021_approval_center_schema.sql`,
  `022_presence_and_routing_state.sql`, `023_seatalk_callback_events.sql`,
  `20261004000000_enable_request_realtime.sql`.

### V2 GitHub

- Latest target: `https://github.com/devacct2026/soc5-outbound-v2/commit/97199e84b3a8751f96712adbe9832adbc815f8a3`
- Existing backend/API and approved decisions: `src/server/api.ts`,
  `src/server/supabase/backend.ts`, `src/server/auth/`,
  `src/domain/requests/`, `src/domain/permissions.ts`,
  `docs/backend/01-business-rules.md` through
  `docs/backend/10-implementation-readiness.md`,
  `docs/backend/09-business-decisions.md`, and `docs/parity-matrix.md`.
- V2 schema and SQL tests: `supabase/migrations/`,
  `supabase/tests/`.
