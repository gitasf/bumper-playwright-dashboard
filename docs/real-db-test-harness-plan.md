> **Status: implemented.** The real-DB harness landed as part of the dual D1/Postgres work — executed-query integration tests run against pglite + real Postgres (`src/__tests__/pg-integration.test.ts`) over the `db-batch.ts` / `db-run.ts` dialect seam, plus a CI real-postgres job. See [docs/worklog/2026-06-16-dual-database-d1-postgres.md](worklog/2026-06-16-dual-database-d1-postgres.md). The plan below is retained as the original design record.

# Plan — Real-DB (SQLite) test harness for the data layer

**Status:** proposed (not started). Scoped from the 2026-06-15 large-scale-rework assessment, which rated this the one structural investment worth making.

## Why

The SQL-bearing code is exercised only by a **structural** `void/db` stub
(`src/__tests__/helpers/void-db-stub.ts`) that records operator calls and
**cannot execute SQL**. So a wrong scope predicate, a dropped JOIN, a wrong
column, or a broken CTE passes the unit tests green. Concretely:

- ~17 `src/lib` modules issue `db.*`; **zero** are tested through executed SQL.
- 5 analytics loaders (~1,300 lines) assemble multi-CTE raw SQL (`row_number() over`, `count(*) over`, dynamic `in (…)`, scope-join fragments) — only the extracted _fragment builders_ are tested, never the assembled query that runs.
- **Two SQL-correctness bugs already shipped**, caught only in human review:
  1. `db.insert(runs)` dropped `origin`/`monitorId` → every synthetic run persisted `origin='ci'` + null `monitorId`, leaving the column + index inert (worklog 2026-06-08).
  2. `max(testResults.title)`/`max(file)` returned the lexicographically-largest, not the latest, value → wrong analytics output (worklog 2026-04-24).
- Three docstrings already name the gap ("the real-D1 harness is outstanding" — `per-test.ts`, `ingest.ts`, the run-diff worklog).

The structural stub stays where it suffices (pure predicate-_shape_ assertions); this harness adds executed-query tests **only where SQL correctness is the risk**.

## Mechanism

A **test-only** harness — no production code changes. `better-sqlite3` `:memory:` + `drizzle-orm/better-sqlite3`, migrations applied, exposed through the same `void/db` surface production imports, mocked in per test.

```
helpers/real-db.ts
  bootRealDb():
    sqlite = new Database(":memory:")
    sqlite.pragma("foreign_keys = ON")          // exercise the onDelete:cascade FKs
    applyMigrations(sqlite)                       // db/migrations, _journal order, split on "--> statement-breakpoint"
    return drizzle(sqlite, { schema })            // + a thin D1-shape shim (see Phase 2)
  seed helpers: seedTeam / seedProject / seedRun / seedTestResults
```

Tests opt in by mocking `void/db` with the harness instance **and the real
drizzle operators** (so query-building executes real SQL):

```ts
vi.mock("void/db", async () => {
  const orm = await import("drizzle-orm");
  const { db } = bootRealDb();
  return { db, ...orm }; // and, eq, sql, … are the REAL operators here
});
```

## Confirmed obstacles (recon done 2026-06-15)

1. **`drizzle-orm/better-sqlite3` does not resolve from `apps/dashboard`.** `drizzle-orm` ships _under_ `void` (nested, `drizzle-orm@0.45.2`), not as a direct dep — a probe import failed at vite resolution. **First step:** add `drizzle-orm@0.45.2` (version-matched to void's, to avoid a dual-instance type/identity mismatch) + `better-sqlite3` (already in the pnpm `onlyBuiltDependencies` allowlist) as dashboard **devDependencies**, or add a vitest-only `resolve.alias`. Pin the drizzle version to void's.
2. **The D1-shape shim is small, not 23 sites.** `db.batch()` (D1-specific; `better-sqlite3` drizzle has none) is concentrated behind **`runBatch` in `db-batch.ts`** — only ~2 call sites touch `db.batch` directly. The shim wraps the drizzle instance to add `.batch([stmts])` (run each in a transaction) and the `.run(sql).results`/`.meta` shape D1 returns. Build it once in `real-db.ts`.
3. **Migration application.** Read `db/migrations/meta/_journal.json` for order (11 migrations today), split each `.sql` on `--> statement-breakpoint`, `sqlite.exec` each. The `-- void:allow-destructive` header comments are inert; the DDL is standard SQLite.
4. **Pool compatibility is fine.** Tests run in the plain-Node vitest pool (not workerd), so the native `better-sqlite3` loads — no conflict with the Vite+ closed pool set / the cloudflare workers pool.
5. **`@schema` already aliases in test config** (`vite.config.ts` test `resolve`), so the harness can pass the real schema to `drizzle(sqlite, { schema })`.

## Phasing (each independently shippable)

- **Phase 0 — foundation (S/M).** Resolve obstacle 1; build `helpers/real-db.ts` (boot + migrate + seed helpers, read-side only, no shim yet); one smoke test: seed two projects' runs, call a scoped read (`loadRunTestStatuses`), assert only the in-scope rows return (catches the cross-tenant class).
- **Phase 1 — read-side correctness (M).** Cover the bug-prone _reads_, which need **no shim** (select / `db.run(sql)` reads): the analytics CTEs (regression-pin the **max-vs-latest** bug), run-diff resolution end-to-end, the per-test aggregate loaders. This is where most of the untested-orchestration risk lives.
- **Phase 2 — write-side (M).** Add the `.batch` shim (obstacle 2); cover ingest open/append/complete (regression-pin the **dropped-column** bug), the guarded membership writes, and `teardownProject`'s FK cascade (with `foreign_keys = ON`).

## Scope guardrails

- Test-only; **no production code changes**.
- Keep structural-stub tests where they're the right surface (a fragment builder's exact SQL text, a predicate tree's shape). Add executed-query tests only where the _assembled_ query / write correctness is the risk.
- Don't chase 100% — target the SQL whose breakage is silent and high-impact (scope predicates, CTEs, ingest writes, cascades).

## Estimate

**M–L**, fully phaseable: Phase 0 is a small spike that de-risks the rest; Phases 1–2 can land incrementally as each module gets its first executed-query test. No migration/data risk (pre-launch).
