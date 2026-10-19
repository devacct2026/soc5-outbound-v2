# SOC5 Outbound v2: implementation progress log

Working branch: `main` (local only; nothing pushed, merged or deployed).
Original GitLab repository: treated as read-only and never contacted.
All verification below ran against **disposable local resources only**
(a throw-away PostgreSQL cluster created by `scripts/db-test.mjs`, in-memory
stores, stubbed `fetch`). No Supabase project, SeaTalk tenant or Google account
was contacted.

## Pre-flight (13:15 PHT)

- Inspected git status, dependencies, docs 01-10, existing frontend, tests.
- Pre-existing (uncommitted) work found and **preserved**: APR-3 domain
  (`src/domain/requests/workflow.ts`), service/port, in-memory store, one
  migration and 11 tests. All 11 still pass unchanged.
- All 46 decisions + the APR-3 exception were available in
  `docs/backend/09-business-decisions.md`; no decision was missing.
- Environment constraints: `npm install` of new packages was denied by the
  session policy, so v2 uses **zero new dependencies** (Supabase via
  PostgREST/RPC over `fetch`, SQL verified through `psql`).
- **Safety finding:** `.env.local` (git-ignored) defines legacy `SUPABASE_*`
  names that may point at the original project. Values were never read. v2 now
  reads only `SOC5_*` variables and a test proves the legacy names are ignored.

## Phase status

| # | Phase | Status | Evidence |
|---|---|---|---|
| 1 | Database foundation, migrations, constraints, RLS | **Done (locally verified)** | `npm run test:db`: 3 migrations replay clean; 5 SQL test files |
| 2 | Auth + role authorization | **Done in code; live Supabase Auth untested** | `supabase.test.ts` (stubbed), RLS tests |
| 3 | Request APIs + validation | **Done** | `api.test.ts`, `lifecycle.test.ts` |
| 4 | Five-stage workflow + rejection routing (APR-1..6) | **Done** | `lifecycle.test.ts`, `workflow.test.ts`, `api.test.ts` |
| 5 | Queue, docking, dispatch, driver assignment | **Done** | queue SQL + HTTP pagination tests |
| 6 | SeaTalk adapter + callback security | **Interfaces + callback logic done; provider BLOCKED/disabled** | `seatalk.test.ts` (mock only) |
| 7 | Notifications, worker, retries, dead letter | **Done (worker + ports); SeaTalk delivery blocked** | `outbox-worker.test.ts`, SQL claim tests |
| 8 | Realtime, KPI, reports | **Backend done; dashboard not wired** | KPI domain + SQL tests, CSV export |
| 9 | Google Sheets | **Client + mapper done; live Google untested; column set to confirm** | `supabase.test.ts` (stubbed) |
| 10 | Historical status reconciliation | **Preview engine done; no migration applied** | `kpi-legacy.test.ts`, `scripts/reconcile-preview.mjs` |
| 11 | Security hardening + automated tests | **Done for scope; see findings** | all suites, 0 prod vulnerabilities |
| 12 | CI, deployment prep, readiness review | **Done (Travis, devcontainer); no deploy** | `.travis.yml` (not executed here) |

## Decisions made while implementing (no undocumented business rules added)

- **SEA-1 vs. "Web approve":** the transition matrix allows Web approval, SEA-1
  forbids an internal bypass, and SeaTalk is unverified. Resolution: the web
  `approve` path calls an `ApprovalGate` that refuses (HTTP 503
  `APPROVAL_PROVIDER_DISABLED`) until SeaTalk is verified; requests stay
  `PENDING`. Rejection is not gated (it approves nothing). Callbacks are
  disabled by feature flag.
- **Queue:** `DOCKED` is not an actionable-queue item (the audited source listed
  it for Ops PIC; post-dock edits remain a permitted action, APR-5).
- **Admin override (HUB-4):** only an envelope around an existing, validated
  transition; needs admin flag, justification, and a strong-identity verifier.
  The verifier is unconfigured (denies), so overrides are effectively off.
- **Bulk approve:** per-item results `{data, failed}`; contract didn't say
  all-or-nothing.
- **List endpoint:** cursor pagination with fixed `created_at desc, id desc`
  order (the earlier custom-sort allowlist was dropped; OPS-1 requires stable
  sorting).
- **Revocation delay (OPS-3):** the API loads the profile on every request with
  no cache, so disabling a user takes effect on the next protected request
  (0 s application delay). Database RLS re-evaluates the profile on every
  query/realtime delivery. Already-issued JWTs stay cryptographically valid
  until expiry but confer no data access once the profile is disabled. Real
  Supabase measurement is still required.

## Verification run log

See "Final report" at the bottom (updated at the end of the session).
