# 2026-06-17 — Postgres dialect fixes in hand-written SQL + auth-read seam migration

## What changed

The D1 (SQLite) → Postgres-only migration left a class of **SQLite-isms in
hand-written `` sql`…` `` queries** that compile and pass the test suite but throw
at runtime against Postgres. Surfaced while getting `pnpm setup:local` working
end-to-end (the seed step exercises ingest). Found and fixed all of them, then
**retired the raw-SQL seam against the Better Auth tables entirely** by giving
those tables a typed, query-only Drizzle schema.

## The dialect bugs (all hand-written SQL; all 42xxx runtime errors)

| Site                                                   | SQLite-ism                                                           | Postgres error                                        | Fix                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| `ingest.ts` `completeRun`                              | 2-arg `max(a,b)` on `durationMs`/`completedAt`                       | `42883 function max(integer, unknown) does not exist` | `greatest(a,b)`                                            |
| `analytics/bucketing-sql.ts` `percentilePick`          | `max(1, …)` rank clamp                                               | (same class, latent)                                  | `greatest(1, …)`                                           |
| `owners-repo.ts` `latestFilePerTestId`                 | bare non-grouped column + `GROUP BY`                                 | `42803 column … must appear in GROUP BY`              | `distinct on (…) order by …, createdAt desc` via `runRows` |
| `monitors/http/uptime-analytics.ts`                    | unquoted `monitorExecutions` (camelCase table)                       | `42P01 relation "monitorexecutions" does not exist`   | quote `"monitorExecutions"`                                |
| `auth-users.ts` (`getUserIdentity`, `getUserAccounts`) | unquoted camelCase columns (`emailVerified`, `providerId`, `userId`) | `42703 column … does not exist`                       | quote (interim) → then retired (below)                     |

**Postgres dialect rules** (now also in memory): `greatest`/`least` not 2-arg
`max`/`min`; **quote camelCase identifiers** (unquoted folds to lowercase); no
bare non-grouped columns with `GROUP BY` (use `distinct on` / `row_number()`).

## Auth-read seam: raw SQL → typed query builder

`auth-users.ts` was the only file hand-writing raw SQL against the void-owned
Better Auth tables (`user`/`account`) — which is what kept re-introducing the
quoting + timestamp bugs. Root cause: those tables are deliberately absent from
`db/schema.ts` (Better Auth owns + migrates them), so there was no Drizzle table
object to query with. Retired the raw SQL three ways:

- **`getUserIdentity`** → `void/auth`'s `getUser()` (the blessed API for the
  current user; all callers thread the session user, guarded on `id`). No DB read.
- **`getUsersByIds` / `getUserAccounts`** → new query-only Drizzle objects
  `authUser` / `authAccount` in **`db/better-auth-tables.ts`**. That file is NOT
  imported by `db/schema.ts`, and `void db generate` reads only `./db/schema.ts`
  (`.void/drizzle.config.json`), so it never enters our migrations — it exists
  purely for typed, auto-quoting reads. Drizzle now handles identifier quoting
  **and** `timestamptz`→`Date` mapping automatically.

This also fixed a **latent user-visible bug**: `account.createdAt` is a real
`timestamptz` (node-postgres returns a `Date`), but `coerceAccountCreatedAt`
only handled the D1-era `number | string`, so it returned `null` for a `Date` —
meaning Settings → Profile's "GitHub connected at …" was always blank. Now
`createdAt: Date` and the coercion is `Date → epoch seconds`.

Net: **no hand-typed raw SQL against the auth tables remains**; both dialect-trap
classes are structurally impossible for auth reads.

## Related: `setup-local.mjs` port mismatch

Separately, `setup:local` failed at `void db reset` (clack `■`) because the
script booted the compose Postgres on `WRIGHTFUL_PG_PORT` (default 5432) while
resetting against `.env.local`'s `DATABASE_URL` (`:5433`) — container on the
wrong port → connection refused (the `■` was a connection failure, NOT an
interactive-TTY prompt, as first mis-diagnosed). Fixed `ensureLocalPostgres` to
**derive the compose port from `DATABASE_URL`** so the published port and the
URL can't drift.

## Why the tests missed all of this

`pg-integration.test.ts` (the dialect guard, runs on pglite = real Postgres) only
exercises the data **seam** (`runBatch`, `numericSql`, `bucketExpr`,
`cast(… as integer)`), not these hand-written queries — a coverage gap, not a
pglite-vs-pg gap. Audited the whole monorepo for remaining SQLite-isms (a
function-list sweep + a systematic scanner for unquoted camelCase identifiers in
raw SQL); both are now clean.

## Verification

- All fixed queries run against the live local Postgres (`wrightful-pg`,
  postgres:16 on :5433): the `greatest` merge, `distinct on`, quoted
  `monitorExecutions`, and the Drizzle-shape `authUser`/`authAccount` reads.
- Tests: Node lane 13 files / 129; workers lane 96 files / 1036; reporter
  unaffected. `vp check` 0 errors.
- `auth-users.workers.test.ts` updated for the `Date`-typed `createdAt` (removed
  the dead ISO-string cases).

## Follow-ups

- The durable fix for the class is **pglite-execution coverage of the
  hand-written queries** (`completeRun` merge, owners `latestFilePerTestId`, the
  uptime/analytics loaders) — so a dialect regression fails a test instead of at
  runtime. Not yet done.
- `getUserIdentity` still takes a now-vestigial `userId` param (guarded against
  the session user); fully dropping it means threading the change through the
  invite-resolution chain — deferred.
