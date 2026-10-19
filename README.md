This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Frontend validation

Install the Playwright Chromium browser once with `npx playwright install chromium`, then run:

```bash
npm run lint
npx tsc --noEmit
npm run test:e2e
npm run build
```

The Playwright suite starts the local Next.js development server and exercises route navigation,
dashboard filters, themes, keyboard interactions, and responsive layouts at desktop, tablet, and
mobile widths. The dashboard pages still render local mock data; the backend below is not yet wired
into the UI (see `docs/implementation-progress.md`).

## Backend (API, database, worker)

- `/api/v1/*` Route Handlers are thin wrappers over `src/server/api.ts`; domain rules live in
  `src/domain/` (pure, no I/O) and persistence in `src/server/store.ts` (memory + Supabase adapters).
- Schema, RLS and transactional functions: `supabase/migrations/`. Replay them on a throw-away
  PostgreSQL and run the constraint/RLS/audit/worker tests with `npm run test:db`
  (needs `initdb`/`pg_ctl`/`psql`; set `PG_BIN` if they are not on `PATH`).
- Unit/integration tests: `npm run test:unit`. Background worker: `npm run worker -- --once`.
- Configuration: copy `.env.example` to `.env.local`. v2 reads only `SOC5_*` variables and
  deliberately ignores the legacy `SUPABASE_*` names. Use a local or disposable Supabase project.
- SeaTalk approval, SeaTalk alerts and Google Sheets are **disabled by default** and must stay
  disabled until `docs/backend/10-implementation-readiness.md` gates are met.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
