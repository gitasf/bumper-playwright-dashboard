# 2026-06-16 — Dual database backend: D1/SQLite + Postgres

## What changed

Wrightful can now target **two database backends from one codebase**, selected at
build/deploy time:

- **D1 / SQLite** — the zero-config self-host default (unchanged behaviour).
- **Postgres** — the hosted backend, BYO Postgres over Cloudflare Hyperdrive,
  chosen for scale.

This is a config-time, per-deployment choice (the same model as Prisma's
`provider`, Gitea, Grafana, n8n — never per-request). The D1 path is byte-identical
to before for the default build; Postgres is opt-in.

## Why this was tractable

Two findings, both verified against the installed `void@0.9.2`, made this a focused
refactor rather than a platform migration:

1. **Void already resolves a Postgres `db`.** The Void plugin's virtual `void/db`
   module branches on `void.json {"database":"pg"}`: it emits a
   `drizzle-orm/node-postgres` instance backed by the `HYPERDRIVE` binding
   (prod) / `DATABASE_URL` (local), attaches the schema, and generates a
   `NodePgDatabase`-typed `.void/db.d.ts`. Better Auth has a PG runtime
   (`better-auth-pg.mjs`), migrations use `migration-handler-pg`, and
   `nodejs_compat` is auto-added. (The _static_ npm stub still types `db` as D1 —
   that's just the published fallback; the plugin replaces it.)
2. **Our schema is unusually portable.** `db/schema.d1.ts` uses only `text()` and
   `integer()` — no `mode:` timestamps, no booleans, no JSON columns. Both names
   exist identically in `sqlite-core` and `pg-core`, so the only column-level
   divergence is `integer` epoch/ID/cumulative columns → `bigint` on PG.

## Key design decisions

### Schema: one source, the Postgres twin codegen'd (NOT a shared factory)

Drizzle's table builders are dialect-branded and intentionally not type-compatible.
A shared "schema factory" parameterized by the dialect's builders is **not
type-safe** — empirically verified: a `sqliteTable | pgTable` union is uncallable
(`TS2349: none of those signatures are compatible`). Forcing it through with `as
any` would erase the table types the whole app (and the `AuthorizedProjectId`
brand) depends on.

So the two dialects are concrete parallel files — but only ONE is hand-maintained;
the other is generated, so there is no double-edit:

- `db/schema.d1.ts` — the **single source of truth** (the former `db/schema.ts`,
  moved verbatim; SQLite).
- `db/dialect-columns.mjs` — the single list of `integer` columns that widen to
  Postgres `bigint`. Consumed by BOTH the generator and the parity test.
- `db/schema.pg.ts` — **GENERATED** from `schema.d1.ts` by
  `scripts/gen-pg-schema.mjs` (mechanical: `sqliteTable`→`pgTable`, import swap,
  `integer`→`bigint` for the listed columns). Committed, marked generated, never
  hand-edited. The bigint widening (epoch-seconds, external 64-bit IDs, unbounded
  counters) dodges the int4 (~2.1e9) overflow; `bigint({ mode: "number" })` keeps
  the inferred JS type `number`, so `$inferSelect`/`$inferInsert` match the D1
  schema exactly and no app code changes.
- `db/schema.ts` — a thin **dialect barrel** that re-exports one of the two,
  materialized by `apply-dialect`. The `@schema` entry the app, `void db generate`,
  and the test alias resolve. Static re-export (not a runtime conditional) so the
  active dialect's concrete types flow to every call site.
- `src/__tests__/schema-parity.test.ts` — fails CI if the two files' table set,
  SQL names, column-name sets, `notNull`/`primary` flags, or composite PKs drift,
  and asserts the `integer`→`bigint` mapping from `dialect-columns.mjs`
  **positively** (every listed column must be `bigint` on PG; every other integer
  must stay `integer`), so a forgotten regen or an un-widened new epoch column
  fails. (89 assertions.)

### Atomicity seam: an executor builder

D1 and node-postgres expose **mutually exclusive** atomicity primitives: D1 has
`db.batch([...])` and no usable interactive transaction; node-postgres has
`db.transaction(tx => …)` and no `.batch()`. Crucially, a Drizzle statement is
bound to the executor it was built from — on PG a statement built off the pooled
`db` runs on a different connection than the one holding the `BEGIN`, so it would
**not** enroll in the transaction (and against the local max:1 pool, it deadlocks).

`runBatch` (`src/lib/db-batch.ts`) therefore changed from accepting a pre-built
array to accepting a **builder** `(exec) => statements[]`:

- **D1** — calls `build(db)`, runs the result through `db.batch([...])`.
- **Postgres** — `db.transaction(tx => …)`, building statements against `tx` so
  they enroll in the transaction (atomic).

There is **only this one form** — `runBatch` does not accept a pre-built array.
That's deliberate: an array binds its statements to the pooled `db`, which is
correct on D1 but silently non-atomic (or deadlocks) on Postgres, so allowing it
would be a dialect footgun. Forcing the builder makes the seam dialect-invisible
(the caller never knows it's `batch` on D1 vs `transaction` on PG) and impossible
to misuse — removing the overload immediately surfaced two call sites in `pages/`
that a grep had missed. All call sites use the builder, threading the executor
through the shared statement builders (`buildResultInsertStatements`,
`buildQueuePrefillStatements`, `usageBumpStatement`, `aggregateDeltaStatement`,
`activityBumpStatement`, `aggregateRecomputeStatement`), each of which gained an
optional `exec: BatchExecutor = db` parameter. The dialect surfaces in **only
four seam files** — `db-batch.ts`, `db-run.ts`, `analytics/bucketing-sql.ts`,
`db/dialect.ts` — never in routes/pages/loaders.

### Dialect seam: one module, named helpers — no scattered conditionals

- `src/lib/db/dialect.ts` — `isPostgres()` / `isSqlite()` / `maxBoundParams()`,
  resolved once from `WRIGHTFUL_DB_DIALECT` (a build-time `define` for the worker;
  `process.env` for tooling/tests). Plus a test-only override.
- `isUniqueViolation` (`db-batch.ts`) — now recognizes Postgres SQLSTATE `23505`
  (walking the Drizzle `.cause` chain) **and** SQLite's "UNIQUE constraint failed"
  text.
- `changedRows` (`db-batch.ts`) — affected-row count across the THREE driver
  shapes (D1 `meta.changes`, node-postgres `rowCount`, pglite `affectedRows`).
  Used by `reconcileAndBroadcast`'s no-op-finalize guard (`statementChangedRows`
  is now an alias) and the invite-decline 404 probe — both silently read 0 on PG
  before this (the D1-only `meta.changes` is absent), breaking those guards.
- `runRows`/`runRow` (`db-run.ts`) — raw-SQL row reader; D1 `db.run().results` vs
  Postgres `db.execute().rows`, behind the existing confined-cast doctrine.
- **Batching model + round-trips** — `runBatch` programs to D1's batch model (a
  static write set; reads done first, never a read-then-write _inside_ the atomic
  unit), which Postgres runs as a `db.transaction`. The one perf asymmetry: D1's
  `db.batch` is a single round-trip, but each statement in a PG transaction is its
  own. So the insert chunker (`chunkByParams`/`chunkInsertRows`) now derives its
  ceiling from `maxBoundParams()` — D1 packs ~7 rows/statement (99 params), PG
  ~4681 (65535) — so a large flush stays a couple of statements on PG instead of
  hundreds of round-trips. `.returning()` results are uniform (Drizzle normalizes
  to a rows array on both), so `summaryFromBatchResults` needs no branch.
- `bucketExpr` (`analytics/bucketing-sql.ts`) — only the **month** bucket diverges
  (`strftime('%Y-%m', …, 'unixepoch')` ⇄ `to_char(to_timestamp(…), 'YYYY-MM')`);
  day/week are portable integer division `(ts / 86400)`, `(ts / 604800)` (both
  dialects floor non-negative epochs identically). `percentilePick` is already
  portable (a `row_number()/count(*)` ranked CTE, not `WITHIN GROUP`).

## Details

| Area                                  | File(s)                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema (source + generated)           | `db/schema.d1.ts` (source), `db/schema.pg.ts` (generated), `db/schema.ts` (barrel), `db/dialect-columns.mjs` (bigint list)                                                                  |
| Dialect tooling + migrations          | `scripts/gen-pg-schema.mjs`, `scripts/apply-dialect.mjs`, `scripts/db-generate-all.mjs`; `db/migrations.d1/` + `db/migrations.pg/` (committed); `db/migrations/` (gitignored, materialized) |
| Dialect module                        | `src/lib/db/dialect.ts` (new)                                                                                                                                                               |
| Atomicity + error detection           | `src/lib/db-batch.ts`                                                                                                                                                                       |
| Raw-SQL row reader                    | `src/lib/db-run.ts`                                                                                                                                                                         |
| Date bucketing                        | `src/lib/analytics/bucketing-sql.ts`                                                                                                                                                        |
| Builder threading (ingest core)       | `src/lib/ingest.ts`, `src/lib/usage.ts`                                                                                                                                                     |
| Call-site migration (array → builder) | `provisioning.ts`, `retention.ts`, `monitors/scheduler.ts`, `monitors/monitors-repo.ts` (×2), `artifacts.ts`, `routes/api/invites/[inviteId]/accept.ts`                                     |
| Config                                | `env.ts` (`WRIGHTFUL_DB_DIALECT`, `DATABASE_URL`), `vite.config.ts` (`__WRIGHTFUL_DB_DIALECT__` define)                                                                                     |
| Tests                                 | `src/__tests__/schema-parity.test.ts` (new), `src/__tests__/pg-integration.test.ts` (new), `src/__tests__/reconcile-and-broadcast.test.ts` (updated to builder form)                        |
| Dep                                   | `@electric-sql/pglite` + `drizzle-orm` (devDeps, for the PG test lane)                                                                                                                      |

### Dialect switching & migrations — one knob, one command

The dialect is driven by a **single knob**: `WRIGHTFUL_DB_DIALECT` (env /
`.env.local`; default `d1`). `scripts/apply-dialect.mjs` derives the three
build-time things from it and is wired into the `pre*` hooks of dev / build /
deploy / typecheck (package.json), so they're always consistent before Void
reads them:

1. `db/schema.ts` re-export → `./schema.<dialect>` (drives `@schema` types)
2. `void.json` `database` key (drives Void's `db` driver + migrations + auth);
   `vite.config.ts` bakes the worker seam's dialect from this same key
3. `db/migrations/` ← materialized (copied) from `db/migrations.<dialect>/`

So a Postgres deployment sets `WRIGHTFUL_DB_DIALECT=pg` and supplies a connection
(`DATABASE_URL` for local dev; a managed Hyperdrive binding in production, which
Void wires) — nothing else by hand.

**Migrations are per-dialect, committed, and generated by ONE command.** Void
hard-codes its migrations dir to `db/migrations/` and stamps the journal with the
dialect, so the two dialects' SQL can't share it. The canonical sets therefore
live in committed `db/migrations.d1/` + `db/migrations.pg/`; `db/migrations/` is
the gitignored active dir that `apply-dialect` materializes. **`pnpm db:generate`**
(`scripts/db-generate-all.mjs`) regenerates `schema.pg.ts` and runs
`void db generate` for BOTH dialects against their own history in one pass — you
never run it per-dialect by hand. (`db:generate:active` keeps the raw
single-dialect `void db generate` for the active dialect only.)

## Verification

- **D1 (default):** `pnpm check` (format + lint + typecheck) → 0 errors;
  `vp test run` → **109 files, 1248 tests pass** (includes the parity test and
  the unchanged ingest/usage/db-batch suites — proving no regression).
- **Postgres typecheck:** with `WRIGHTFUL_DB_DIALECT=pg`, `apply-dialect` +
  `void prepare` regenerate `.void/db.d.ts` as `NodePgDatabase<Schema>`, and
  `tsgo --noEmit` → **0 errors across the whole app**, including every call site.
  This now runs in CI (a dedicated "Typecheck (Postgres dialect)" step) so the two
  dialects stay a true 1:1 toggle — a D1-only API (e.g. a stray `db.run()`) breaks
  the PG build in CI, not in production.
- **Postgres execution:** `pg-integration.test.ts` runs `schema.pg` + the dialect
  seam against an in-process Postgres (pglite — real Postgres in WASM, no Docker),
  proving on real PG semantics: `runBatch` transaction commit, **atomic rollback**
  on a failed statement, `bucketExpr("month")` (`to_char(to_timestamp(...) AT TIME
ZONE 'UTC')`) executing + grouping + UTC-labelling regardless of session TZ,
  `bigint` columns holding values > int4 max, and `isUniqueViolation` recognizing
  `23505`. **8 tests pass.** It runs in the default suite (CI included) via a
  module-isolated dialect override, without leaking into the D1 tests.

## Known follow-ups / operational notes

- **Migrations** are now handled (see "Dialect switching & migrations"): both
  dialects' sets are committed (`db/migrations.d1/`, `db/migrations.pg/`) and
  regenerated by `pnpm db:generate`; the active `db/migrations/` is materialized
  from the dialect knob. The PG migration SQL is verified correct (`bigint` for
  epoch/cumulative columns, `integer` for bounded ones, quoted identifiers).
- **Raw-SQL identifier casing on PG.** Drizzle renders `${table.column}` as quoted
  camelCase identifiers (preserved on PG), and the analytics aliases that were
  exercised (`bucket`, `n`) are lowercase. A full audit of every analytics loader's
  hand-written `sql` for unquoted camelCase aliases is a recommended follow-up
  before declaring PG analytics fully production-verified (the bucketing path is
  proven).
- **Better-Auth-on-PG and Hyperdrive** are provided by Void (`better-auth-pg.mjs`,
  managed binding) but not exercised end-to-end here (needs a live Postgres /
  deploy). Typecheck + codegen confirm the wiring resolves.
- **The `db.batch` 99-param chunker** stays as-is — harmless on PG (limit 65535);
  `maxBoundParams()` exists in `dialect.ts` for a future opt-in.

## Follow-up: raw-SQL result-shape hardening + dialect-containment guards

A prior-art review (Payload's Drizzle adapters, Drizzle's official "no shared
table" position, Prisma's per-provider migration lock, Knex/Kysely leak points,
Ghost/Strapi dropping SQLite-in-prod, Rails/Django adapter patterns) surfaced
two classes of latent PG bug in our raw SQL and motivated three enforcement
guards. All found by auditing our own `sql\`…\`` usage against the known, finite
list of SQLite⇄PG divergences.

### Result-shape coercion (the "bigint-as-string" trap)

node-postgres returns `int8` (`count`/`sum`/bigint expressions) and `numeric` as
JS **strings**; D1/SQLite return numbers. A bare `sql<number>\`count(\*)\``only
sets the TS type — no runtime decoder — so on PG the value was a string while the
types claimed`number`. **pglite hides this** (its int8 parser returns a number),
so the PG test lane could not catch it; the fix had to be correct-by-construction,
not test-discovered. Two mechanisms, by context:

- **Drizzle-builder selects** → `numericSql(sql\`…\`)`(new, in`db/sql-ops.ts`) =
`fragment.mapWith(Number)`, attaching Drizzle's decoder. Applied at `usage.ts`(×3: run/test/artifact counters + byte sum),`monitors-repo.ts` (`countMonitors`),
`owners-repo.ts` (`max(createdAt)`).
- **Raw `runRows`/`runRow`** (bypass Drizzle's decoders) → `cast(… as integer)` in
  the SQL, yielding `int4` which BOTH drivers parse to a number. Applied at
  `uptime-analytics.ts` (hour bucket, window counts, p50/p95) and `per-test.ts`
  (`statusCounter`). The values comfortably fit int4; a future sum that could
  exceed ~2.1e9 would need `numericSql` on a builder select instead.

Rejected: a global `pg.types.setTypeParser` — `pg` isn't our dependency (a static
import would break D1-only builds), pglite wouldn't exercise it, and the explicit
forms above are correct-by-construction and unit-testable.

### Case-insensitive LIKE parity

SQLite `LIKE` is case-insensitive (ASCII); Postgres `LIKE` is case-SENSITIVE.
Search/filter were written against SQLite's behaviour, so the test-catalog and
runs search silently returned fewer rows on PG. New `likeOperator()` seam helper
emits `ILIKE` on PG / `LIKE` on SQLite; routed through `likeEscaped`
(`runs-filters-where.ts`) and `searchFragment` (`analytics/filters.ts`). The
operator is now a sub-fragment (`${likeOperator()}`), so the recorded-SQL unit
tests were updated to detect likeEscaped fragments by their `ESCAPE '\'` clause
and to read the bound pattern as the lone string arg.

### Enforcement guards (so divergences can't re-enter silently)

- **`dialect-containment.test.ts`** (new): scans all of `src/` + `routes/` and
  fails if a dialect PREDICATE (`isPostgres`/`getDialect`/`maxBoundParams`/…) or a
  dialect-specific SQL TOKEN (`strftime`/`to_char`/`ilike`/`json_extract`/`->>`/…)
  appears outside the seam allow-list. This is the structural answer to Ghost's
  cautionary tale (dialect branches sprawling into app code). `::` is deliberately
  NOT matched — it collides with CSS `::placeholder` and IPv6 `::1`, and we use
  portable `cast(… as …)` anyway.
- **LCD-invariant** added to `schema-parity.test.ts`: every column must be `text`
  or `integer`(→`bigint` on PG) — the only families whose result shapes don't
  diverge after the coercions above. A `boolean`/`timestamp`/`numeric`/`jsonb`
  column now fails the parity test rather than reintroducing per-dialect
  deserialization silently.
- **Schema/migration drift** CI step: `pnpm db:generate` must be a no-op on a
  clean tree (verified deterministic by content hash), catching a schema edit that
  wasn't regenerated into `schema.pg.ts` or a migration set.

### Decision: SQLite stays the canonical schema source (codegen direction)

We generate the Postgres twin FROM the SQLite source and widen `integer`→`bigint`.
Payload/Rails treat Postgres as the superset and down-map to SQLite. We keep the
SQLite-as-source direction deliberately: we sit at the lowest-common-denominator
(everything is `text`/`integer`), which is exactly what keeps the seam tiny and
sidesteps the boolean/date/json/numeric deserialization minefield (the LCD-invariant
test enforces this). The trade-off — we forgo PG-only types (`jsonb`, native enums,
`timestamptz`, partial/BRIN indexes) on the hosted tier. Acceptable today (we use
none); if hosted-scale performance later needs them, flipping the codegen direction
is the deliberate change to make then, not a column edit now.

### Verification (this round)

- `pnpm check` (D1) → **0 errors**, 113 warnings (pre-existing style baseline).
- `vp test run` → **110 files, 1257 tests pass** (incl. the new containment guard,
  the LCD-invariant parity assertions, and `pg-integration.test.ts` now **14 tests**:
  added `numericSql` decoder coercion, a `cast(… as integer)` raw read, `ILIKE`
  emission, and case-insensitive `ILIKE` matching on pglite).
- Postgres typecheck (`WRIGHTFUL_DB_DIALECT=pg`) → **0 errors** across the app.
- `pnpm db:generate` is idempotent (identical content hash) — no schema drift.

## Follow-up: automated cross-dialect CI (so divergence can't be missed)

A second prior-art sweep (how Drizzle/Kysely/Knex/Rails/Django/Metabase ensure
divergences are caught AUTOMATICALLY, not manually) found a single universal
answer: **make the dialect a CI matrix axis and run one shared suite against a
REAL instance of every engine, every PR** — plus a conformance contract every
backend must pass. The decisive validation: Drizzle's OWN repo carries our exact
bug as issue #3106 (pglite reads int8 as a JS number while node-postgres returns
a string), confirming the surrogate-passes/real-fails risk is real and that
running pglite alongside real Postgres is the field's fix. Two layers added:

### Tier 1 — compiled-SQL conformance (deterministic, no DB)

`src/__tests__/dialect-sql-conformance.test.ts` (Kysely's `testSql` pattern):
builds each seam helper under a dialect override and compiles it with Drizzle's
own `PgDialect` / `SQLiteSyncDialect` `.sqlToQuery`, asserting the exact SQL per
dialect. Pins `bucketExpr` (month → `to_char`/`to_timestamp` vs `strftime`; day/
week IDENTICAL on both) and `likeOperator` (`ILIKE` vs `LIKE`), and proves the
"portable" helpers (`numericSql`, `statusCounter`) compile IDENTICALLY on both —
so a new dialect-specific function, a placeholder/quoting drift, or an accidental
branch fails instantly with zero infra. (It `vi.mock`s `void/db` with the real
`void/_db` operators, since unit tests otherwise get the recording stub.)

### Tier 2 — real Postgres in CI (the authority pglite can't be)

`pg-integration.test.ts` now runs **both variants of the same suite** (Kysely's
pattern): in-process **pglite by default** (fast, no infra, local), and a **real
node-postgres** when `PG_TEST_URL` is set — `drizzle({ connection: { connectionString, max: 1 } })`
(pg is already transitive; `max:1` so the TZ test's `SET TIME ZONE` persists).
A new CI job (`test-postgres`) boots a `postgres:16` service container, runs
`void prepare`, and runs the suite against it. This is the lane that catches the
int8-as-string class automatically: verified locally against real `postgres:16`
that uncast `count(*)`/`sum()` return JS **strings** (`"2"`, `"9000000001"`)
while `cast(… as integer)` returns a number `2` — so the suite's `cast`/
`numericSql` assertions FAIL on real PG if the coercion regresses, where pglite
would silently pass.

### Residual (honest)

Production runs on **workerd**, not Node, over **Hyperdrive** — so a Node-based
real-PG job catches SQL/result-shape/type-parser divergence (~the whole risk
surface) but not workerd/Hyperdrive runtime behavior. Cloudflare's first-class
path (`@cloudflare/vitest-pool-workers`, real workerd + Miniflare D1) is **blocked
for us**: our test runner is Vite+'s vitest fork, incompatible with that pool.
Cloudflare's own Hyperdrive example also uses a TCP echo server, not real
Postgres. So the last slice — PG-over-Hyperdrive-in-workerd — is left to a
pre-deploy `wrangler dev` smoke (`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_*`
points the binding at a local Postgres), not CI. See
[[project_pg_pglite_int8_string_trap]].

### Verification (this round)

- `pnpm check` (D1) → **0 errors**, 113 warnings (baseline).
- `vp test run` → **1263 tests pass** (incl. 6 new Tier-1 conformance tests).
- `pg-integration.test.ts` → **14 pass on pglite** AND **14 pass on real
  `postgres:16`** (`PG_TEST_URL`, via Docker) — transactions, atomic rollback,
  `changedRows` via `rowCount`, `23505`, `to_char`/`to_timestamp` + UTC, bigint,
  `cast`/`numericSql`, `ILIKE` all green on the production driver.
- Postgres-dialect typecheck → **0 errors**.
