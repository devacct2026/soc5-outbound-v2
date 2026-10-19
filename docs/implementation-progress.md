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

## Final report (session end)

### Verification results (all local/disposable; nothing live)

| Check | Result |
|---|---|
| ESLint | PASS (0 problems) |
| TypeScript (`tsc --noEmit`) | PASS |
| Unit/integration (`npm run test:unit`) | PASS 96/96 |
| DB migration replay + RLS/constraint/audit/worker/privilege tests (`npm run test:db`) | PASS (3 migrations, 6 SQL files) |
| Production build | PASS (25 API routes, all dynamic) |
| Playwright dashboard spec (UI preserved) | PASS 4/4 |
| Playwright API fail-closed spec | PASS 9/9 when unconfigured; **not re-run** after `.env.local` gained SOC5_* values (to avoid contacting that project); assertions now accept 401 |
| `npm audit --omit=dev` | PASS (0 vulnerabilities, run before final fixes) |
| `.travis.yml` | Written, **not executed** |
| Live Supabase / SeaTalk sandbox / Google | **Not tested** (no approved credentials) |

### Commits
`feat(db)`, `feat(domain)`, `feat(api)`, `feat: outbox worker...`, `feat: Sheets sync...`, review-fix commit, e2e tolerance commit (see `git log`). Nothing pushed.

### Independent review
One read-only review found 13 issues (no critical). Fixed with regression tests: SeaTalk callback retry-poisoning, notification dedupe suppression, expired idempotency keys, existence oracle, unvalidated filters (500s), silent report truncation, body-size DoS, skew misconfiguration, override-role hashing, outbox lock ownership, SQL state-pair/terminal-row guards, self-lockout, profile column exposure. Accepted/open: intraday HMAC replay within 300 s (needs HTTPS network position); in-process rate limiter is per instance (edge/WAF limit required).

### Blockers (not fabricated, documented)
1. SeaTalk official endpoints/signature/payloads unverified, so approval, alerts and callbacks are disabled and approvals stay pending. The signature scheme in code is an ASSUMED placeholder.
2. Google Sheets: original 19-column layout unavailable; v2 column set must be confirmed; live Google untested.
3. Production values (retry limits, retention, presence/expiry, schedule) need owner approval.
4. Strong-identity verifier for admin overrides unconfigured, so overrides are off.
5. SeaTalk OAuth registration flow is blocked on item 1; policy function exists.
6. Dashboard still uses mock data; realtime hook and API wiring not done (needs supabase-js or polling; `npm install` was denied).
7. `.env.local` contains legacy and now SOC5_* variables: confirm they target a disposable project.

### MVP readiness
Weighted by phase (P0 = 2x, P1 = 1.5x, P2 = 1x), counting a phase as full credit only when locally verified:
P0 (phases 1-4: DB, auth, requests, workflow) 4 x 2 = 8 of 8, but auth is verified only against stubs so scored 7.5.
P1 (5, 7, 8-backend) 3 x 1.5 = 4.5; dashboard wiring missing, scored 3.75.
P2 (6, 9, 10, 11, 12) 5 x 1: SeaTalk 0.4, Sheets 0.6, reconciliation 1, hardening 1, CI/deploy prep 0.8 = 3.8.
Total = 15.05 / 17.5 = **about 86% backend MVP (code and local tests)**; about 60% end-to-end because UI wiring and live integrations are unverified.

### Verdict: **NO-GO for production**
Reasons: no live Supabase run, SeaTalk unverified, UI not wired, production configuration unapproved (`10-implementation-readiness.md` gates open). GO for continued development and a disposable-environment rehearsal.

### Work needed after 7:00 PM
1. Run migrations and `commit_transition`/RPCs against a disposable Supabase project; measure real revocation delay.
2. Verify SeaTalk contract in sandbox, replace the placeholder signature, enable gate and alerts.
3. Wire dashboard/queue/KPI to `/api/v1` plus realtime or polling.
4. Confirm Sheets columns, test with a disposable sheet.
5. Run historical reconciliation preview on an exported non-production copy.
6. Get approval of production values; add edge rate limiting and alert owners/runbooks; run Travis.

## Architecture update: NestJS API + BullMQ/Redis (added at the user's request)

Target: Next.js (UI) -> NestJS API -> Supabase (Postgres/Auth/RLS); BullMQ + Redis for workers; external integrations.

Done (locally verified):
- `src/nest/` NestJS app (`npm run start:api`, port `SOC5_API_PORT`, default 4000). Nest owns transport/DI only; all business rules are the existing `src/domain` and `src/server` code, reached through the framework-neutral route table `src/server/routes-table.ts`. The Next route handlers under `src/app/api` remain as an equivalent same-origin fallback; the Nest API is the intended primary.
- `npm run test:nest` compiles with `tsconfig.nest.json` (decorators) and runs 3 tests over real HTTP: workflow, idempotent replay, route precedence, 405/404, 413, secure headers, fail-closed 503. PASS 3/3.
- `src/server/worker/bullmq.ts`: BullMQ repeatable "tick" + concurrency-1 worker; enabled with `SOC5_QUEUE=bullmq` and `SOC5_REDIS_URL`. Redis is only the scheduler: the PostgreSQL transactional outbox stays authoritative (retries, backoff, dead letter, audit), so a Redis loss cannot lose or duplicate work. Processor wiring is unit-tested without Redis.

Not verified: no Redis was available here, so `startBullWorker` has never run against a live Redis (stalled-job and scheduler behaviour untested). The frontend still uses mock data and does not yet call the Nest API (set `SOC5_WEB_ORIGIN` for CORS when it does). Two install scripts (`unrs-resolver`, `msgpackr-extract`) were blocked by npm policy; `msgpackr-extract` is an optional native speed-up for BullMQ and does not affect correctness.

Updated test totals: unit 97/97, Nest 3/3, DB 6 SQL files, Playwright dashboard 4/4, 0 prod vulnerabilities.

## Dashboard wired to the API (pre-presentation)

- Signed out: the approved dashboard renders exactly as before (existing 4 Playwright tests unchanged and green).
- Signed in ("Connect live data" in the heading): email/password goes to `POST /api/v1/auth/login`, a server-side proxy for the Supabase password grant (anon key only, no refresh token returned, per-address throttled). The access token lives in `sessionStorage` and is sent as a Bearer token; every API call still re-checks the profile/role server-side.
- Live data: request table (latest 100 visible to the role), approval-pipeline counts and KPI cards from `/requests`, `/requests/metrics`, `/dispatch/intraday`; refreshed every 30 s (polling; Supabase Realtime client not added). Cards without an approved definition (SLA Risk) show a dash rather than an invented number; legacy raw statuses show as "Legacy".
- Set `NEXT_PUBLIC_SOC5_API_URL` to point the browser at the NestJS API instead of the same-origin Next routes.
- Tests: `live-data.test.ts` (mapping), `login.test.ts`, and Playwright `dashboard-live.spec.ts` (sign-in swaps mock for API data, sign-out restores it; network mocked). Totals: unit 102/102, Nest 3/3, Playwright 10/10 for api+live specs plus dashboard 4/4, DB 6 SQL files.
- Not verified: a real sign-in against the disposable Supabase project with a real approved profile (needs an account created and approved by an admin first); other pages (Queue, Approvals, Docking, Reports...) still use their mock module content, and there are no write actions (create/approve/dock) in the UI yet.
