# 2026-06-16 — Postgres-only: removing D1 from first principles

## What changed

The dashboard now runs on **Postgres only**. The dual D1/SQLite + Postgres
backend introduced earlier the same day (see
[`2026-06-16-dual-database-d1-postgres.md`](./2026-06-16-dual-database-d1-postgres.md))
was collapsed to a single dialect — D1 is gone, and Postgres (over Cloudflare
Hyperdrive in production, a direct `DATABASE_URL` in local dev) is the one and
only store.

This is a deliberate reversal of the dual-dialect work, taken before it shipped
to anyone. The motivation was simplification: maintaining two SQL dialects from
one codebase carried ongoing cost (a raw-SQL dialect seam, two migration
histories materialized by a build pre-hook, a real-Postgres CI leg shadowing a
pglite surrogate, and a `schema.d1.ts → schema.pg.ts` codegen step) for a
project that is pre-launch with zero users. One well-supported store is far
simpler to operate, test, and self-host — and Postgres is the dialect that
scales, so keeping D1 "for the free tier" wasn't worth the divergence when
[Neon](https://neon.tech)'s free tier covers self-hosters just as well.

**Positioning:** self-hosters bring their own Postgres. We recommend **Neon**
(free tier, ample for self-hosting) as the default and **PlanetScale Postgres**
as the scale-up. Local dev uses a Docker Compose Postgres (or any
`DATABASE_URL`).

**Scope boundary (unchanged):** this switch kept the existing column
**semantics** — epoch-seconds stored as `bigint({ mode: "number" })`, text, etc.
It did **not** migrate to `timestamptz` / native enums / `jsonb`, because that
ripples into time-bucketing, retention, and status logic. Adopting pg-native
types is a separate, optional follow-up.

## Why D1 removal was tractable

The dual-dialect work had already proven the Postgres path end-to-end (Void
0.9.2 resolves a `drizzle-orm/node-postgres` `db` for `void.json {"database":
"pg"}`, with PG runtimes for Better Auth + migrations). Removing D1 was
therefore mostly **deletion**: drop the SQLite branch of each dialect-seam
helper, delete the codegen/materialization scaffolding, and make `void.json`'s
`"database": "pg"` the permanent choice rather than a toggle.

## Details

### Phase 1 — single Postgres schema + one migration history

| Before (dual)                                                                                        | After (pg-only)                                                                   |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `db/schema.d1.ts` (source) → `db/schema.pg.ts` (codegen) → `db/schema.ts` (active barrel)            | single hand-authored `db/schema.ts` (pg-core)                                     |
| `db/migrations.d1/` + `db/migrations.pg/`, materialized into `db/migrations/` by `apply-dialect.mjs` | one committed `db/migrations/` (squashed init `20260616202249_familiar_lyja.sql`) |
| `void.json "database"` toggled by the dialect                                                        | `void.json "database": "pg"` (fixed)                                              |

### Phase 2 — de-forked the dialect seam to pg-only

The seam that abstracted over D1 vs PG collapsed to thin Postgres helpers:

- **`src/lib/db-batch.ts`** — `runBatch` always runs a `db.transaction`
  (`BatchExecutor = typeof db | Tx`). `changedRows` reads `rowCount ??
affectedRows`; `isUniqueViolation` checks SQLSTATE `23505`.
- **`src/lib/db-run.ts`** — `runRows` = `(await db.execute(query)).rows ?? []`.
- **`src/lib/db/sql-ops.ts`** — reduced to `numericSql(fragment)` (decodes
  node-postgres `int8`/`numeric` strings via `.mapWith(Number)`). The dialect
  switch (`src/lib/db/dialect.ts`) and the `likeOperator` shim were deleted;
  `ilike` is inlined in `runs-filters-where.ts` + `analytics/filters.ts`.
- **`src/lib/analytics/bucketing-sql.ts`** — Postgres time-bucketing only
  (`to_char(to_timestamp(col) AT TIME ZONE 'UTC', 'YYYY-MM')`, `col / 86400`,
  `col / 604800`).
- **`src/lib/ingest.ts`** — `PG_MAX_BOUND_PARAMS = 65_535`; `chunkByParams`
  chunks rows under that ceiling (was D1's 99).

### Phase 3 — tooling & config cleanup

- `env.ts` — removed `WRIGHTFUL_DB_DIALECT`; kept `DATABASE_URL`.
- Deleted `scripts/apply-dialect.mjs` and the dialect-materialization pre-hooks;
  `package.json` lost `dialect:apply` / per-dialect generate scripts. `db:generate`
  is now plain `void db generate`.
- `scripts/gen-wrangler.mjs` — injects only `hyperdrive[HYPERDRIVE]` (from
  `CF_HYPERDRIVE_ID`) + `r2_buckets[STORAGE]` (from `CF_R2_BUCKET`); no D1.
- `scripts/migrate-remote.mjs` — Postgres-only (`void db migrate` over a temp
  `.env.local` from `$DATABASE_URL`).
- `vite.config.ts` — removed `activeDbDialect()` + the `__WRIGHTFUL_DB_DIALECT__`
  define.
- `.gitignore` — `db/migrations/` is now committed (was generated/ignored).
- `.env.example` — Postgres-only DB section; `CF_HYPERDRIVE_ID` (no `CF_D1_*` /
  `WRIGHTFUL_DB_DIALECT`).
- `.github/workflows/ci.yml` — dropped the separate "Typecheck (Postgres
  dialect)" step and simplified the schema-drift guard to
  `db/schema.ts db/migrations`. The real-`postgres:16` integration job
  (`test-postgres`, runs `pg-integration.test.ts` against a service container
  via `PG_TEST_URL`) is **kept** — it's now the only DB engine, so result-shape
  parity matters more, not less.

### Phase 4 — tests

- Deleted the dialect-only suites (`dialect-containment.test.ts`,
  `schema-parity.test.ts`) and rewrote D1-coupled tests (param ceiling,
  `strftime`→`to_char`, `like`→`ilike`, SQLite quoting, the `db.batch` mock →
  a `transaction` mock).
- `src/__tests__/pg-integration.test.ts` is the DB integration test: pglite by
  default, real node-postgres when `PG_TEST_URL` is set. It guards the
  **int8-as-string trap** — node-postgres returns `count`/`sum`/`bigint` and
  `numeric` as strings where pglite returns numbers, so the fast pglite lane
  can't catch a missing `numericSql` / `cast(… as integer)`.

### Phase 5 — docs

Reconciled the live docs from dual-dialect to Postgres-only: `README.md`,
`CLAUDE.md` (root) + `apps/dashboard/CLAUDE.md`, `docs/ARCHITECTURE.md`, and
`SELF-HOSTING.md` (the biggest — `wrangler d1 create` → `wrangler hyperdrive
create`, `CF_D1_*` → `CF_HYPERDRIVE_ID`, single migration flow, Neon/PlanetScale
positioning). `docs/PRD.md` keeps its decision history intact with an additive
"D1 removed, Postgres-only" note + annotations on the affected decision rows
(history is preserved, not rewritten).

### Phase 6 — local-dev DX for Postgres

D1's zero-config local store is gone, so local dev needs a reachable Postgres:

- Added **`apps/dashboard/docker-compose.pg.yml`** — a `postgres:16` service
  (matching the CI image) with a healthcheck and a named volume.
- `scripts/setup-local.mjs` now: ensures a `DATABASE_URL` in `.env.local`
  (defaulting to the compose Postgres when absent/commented, leaving a hosted
  URL untouched); boots the container with `docker compose … up -d --wait` when
  the URL is local (skips Docker for a hosted URL); and passes `DATABASE_URL`
  through to `void db reset`. If a local DB is wanted but Docker is unavailable,
  it exits with guidance to start Docker or point `DATABASE_URL` at a hosted
  Postgres (e.g. a Neon branch).

## Verification

- `node --check scripts/setup-local.mjs` — parses.
- `pnpm check` (oxfmt + oxlint + type-aware typecheck) — **0 errors** (111
  pre-existing lint warnings in e2e helpers, unrelated to this work).
- `pnpm --filter @wrightful/dashboard test` — **1164 passed, 108 files** (the
  pg-only baseline; ~3 fewer suites than dual after the dialect-test deletions).
  `pg-integration.test.ts` runs on pglite here; the real-`postgres:16` engine
  runs it in CI (`test-postgres`).
- `gen-wrangler.mjs` — validated both branches: no `CF_*` → generic fallback (no
  data bindings); `CF_HYPERDRIVE_ID` + `CF_R2_BUCKET` → `hyperdrive` + `r2`
  blocks injected.

The only thing not exercised end-to-end on this machine is the live
`docker compose … up -d --wait` boot in `setup:local` (no Docker daemon here);
the script parses and the local/external `DATABASE_URL` branch logic is
straightforward.
