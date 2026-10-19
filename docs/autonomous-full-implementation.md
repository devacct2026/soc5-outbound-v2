# SOC5 Outbound v2 — Autonomous Full Implementation

Act as a Principal Full-Stack Engineer, Backend Architect, DevOps Engineer, QA Engineer, and Security Engineer.

## MISSION

Complete SOC5 Outbound v2 development as far as safely possible before 7:00 PM Philippine Time, October 19, 2026.

Work continuously and autonomously. Do not stop between phases or request "next" after every step.

## PROJECT

Stack:
- Next.js + TypeScript
- Tailwind CSS + shadcn/ui
- Supabase PostgreSQL + Auth + Realtime
- SeaTalk Approval Center
- GitHub Codespaces
- Travis CI

Repository: Independent SOC5 Outbound v2.

Original GitLab reference:
https://gitlab.com/outbound-project/soc-5-outbound

The original repository is READ-ONLY. Never modify it or connect to its production database.

## SOURCE OF TRUTH

Read all available documents:

- docs/backend/01-business-rules.md through 10-implementation-readiness.md
- SOC5 Outbound v2 Development Roadmap
- Existing frontend implementation and tests

Preserve all 46 approved business decisions and the approved APR-3 exception.

Never invent undocumented business rules.

## EXECUTION PLAN

Execute these phases sequentially:

1. Database foundation, migrations, constraints and RLS.
2. Supabase authentication and role-based authorization.
3. Request management APIs and validation.
4. Five-stage approval workflow and rejection routing.
5. Queue, docking, dispatch and driver assignment.
6. SeaTalk Approval Center adapter and callback security.
7. Notifications, background worker, retries and dead-letter handling.
8. Realtime dashboard, KPI calculations and reports.
9. Google Sheets integration where specified.
10. Historical status reconciliation.
11. Security hardening and automated testing.
12. CI configuration, deployment preparation and final readiness review.

Implement production-quality code, not placeholders, wherever the requirements and available environment permit.

## AUTONOMOUS EXECUTION RULES

- Continue automatically after each completed task.
- Do not wait for approval between ordinary implementation steps.
- Inspect existing files before modifying them.
- Reuse working components.
- Preserve the approved Logistics Dashboard UI.
- Implement reusable, maintainable and type-safe code.
- Keep frontend and backend behavior consistent.
- Fix errors discovered during testing.
- Rerun affected tests after fixes.
- Keep a running progress log in docs/implementation-progress.md.
- Commit completed, validated milestones to the current development branch.
- Never push, merge, deploy or modify production without explicit approval.
- Never fabricate test results or claim unavailable integrations passed.

## SECURITY REQUIREMENTS

- Enforce server-side authorization and Supabase RLS.
- Never expose service-role keys to browsers.
- Preserve immutable audit history.
- Require idempotency keys for mutations.
- Protect SeaTalk callbacks against duplicates.
- Keep SeaTalk approval operations disabled until official provider contracts and sandbox testing are verified.
- Do not bypass required approvals or security checks.
- Use only local or disposable development environments.
- Do not access production data or credentials.

## BLOCKER HANDLING

If a task requires unavailable credentials, external access or unresolved business approval:

1. Document the blocker.
2. Implement safe interfaces, contracts and tests using mocks where appropriate.
3. Do not fabricate successful integration.
4. Continue to another independent task.
5. Report the blocked feature separately.

Do not sacrifice correctness or security to meet the deadline.

## VALIDATION

Continuously run applicable checks:

- ESLint
- TypeScript
- Unit tests
- Integration tests
- Playwright
- Production build
- Dependency audit
- Database migration tests
- RLS authorization tests

Do not mark a feature complete until its applicable tests pass.

## DEADLINE PRIORITIES

P0: Database, authentication, permissions, requests and approval workflow.

P1: Queue, docking, dispatch, notifications and KPI integration.

P2: SeaTalk sandbox integration, reporting exports, Google Sheets and deployment preparation.

Prioritize completing a working, validated MVP over partially implementing every module.

## FINAL DELIVERABLE

Before stopping, produce:

1. Completed phases and features.
2. Exact modified files.
3. Commits created.
4. Test results with PASS/FAIL status.
5. Remaining defects and blockers.
6. Security findings.
7. MVP readiness percentage with calculation.
8. Production readiness verdict: GO / NO-GO.
9. Outstanding work required after 7:00 PM.

Continue executing until all feasible work is completed, an essential blocker prevents further progress, or the execution session reaches its limits.

START IMPLEMENTATION NOW.