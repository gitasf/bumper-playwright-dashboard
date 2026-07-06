# 2026-07-04 — Schema-rework review fixes (6 findings)

Follow-up to `2026-07-04-schema-rework.md`. A thermonuclear (max-effort) code
review of the schema-rework working tree surfaced 6 issues; each was
independently re-validated (adversarial validators) and then fixed with
regression coverage. All fixes are in `apps/dashboard`.

## What changed

| #   | Sev  | Fix                                                                                                           |
| --- | ---- | ------------------------------------------------------------------------------------------------------------- |
| 1   | HIGH | `updateMonitor` no longer double-encodes `config` into the `jsonb` column                                     |
| 2   | MED  | `tests`-catalog upsert rows are sorted by `testId` to avoid a cross-run deadlock                              |
| 3   | MED  | `openRun` recovers a synthetic run whose monitor was deleted mid-open (FK-violation retry) instead of 500-ing |
| 4   | LOW  | `cleanupUserData` (afterDelete sweep) is now best-effort (log + swallow)                                      |
| 5   | LOW  | Deterministic tiebreakers on three tie-prone `ORDER BY` sites                                                 |
| 6   | NIT  | Corrected the stale `deleteMonitor` docstring (FK sets `monitorId` null, not "dangling")                      |
| 7   | LOW  | Partial index on `runs.monitorId` so the new `set null` FK doesn't seq-scan `runs` on monitor delete          |

## Details

### 1 — `updateMonitor` config double-encode (data-corruption)

`monitors.config` migrated `text`→`jsonb`; `createMonitor` was updated to store
the object directly, but `updateMonitor` still called `JSON.stringify(patch.config)`,
storing a JSON **string scalar** in the jsonb column. The read path
(`parseHttp/TcpMonitorConfig`, which now `safeParse`s an object) then rejected
the string → `null` → the monitor's config silently vanished and its executions
errored. The type system missed it because `jsonb("config")` carries no `$type`
(infers `unknown`), so a `string` assignment typechecks.
**Fix:** `set.config = patch.config` (`monitors-repo.ts`). Also corrected the
stale "stores it as a JSON string" note in `monitor-schemas.ts`.
**Data caveat:** any http/tcp monitor edited between the jsonb migration and this
fix holds a double-encoded row; the read path degrades those to `null`
gracefully (no crash). A one-off repair (`UPDATE monitors SET config = (config #>> '{}')::jsonb WHERE jsonb_typeof(config) = 'string'`) can be run if such rows exist in a deployed env.

### 2 — cross-run deadlock on the shared `tests` catalog upsert

`buildTestCatalogUpsertStatements` emitted rows in `Map`-insertion order. The
`(projectId, testId)` ON CONFLICT row is shared across **all** runs of a project,
but the ingest transaction only locks the per-run row (openRun's prefill takes no
lock at all). Two concurrent same-project flushes with overlapping testIds in
different orders acquire the shared row locks AB/BA → Postgres 40P01 deadlock,
aborting a `/results` or `/open` flush with a 500.
**Fix:** sort the deduped rows by `testId` with a plain code-unit comparator
(`(a,b) => a<b?-1:a>b?1:0` — **not** `localeCompare`, which is locale-dependent)
before chunking, so every writer emits the shared rows in one global order.

### 3 — `runs.monitorId` real FK → openRun 500 on monitor-deleted-mid-run

The logical→real FK (`onDelete: set null`) means inserting a synthetic run whose
`monitorId` points at a just-deleted monitor raises `foreign_key_violation`
(23503); openRun's catch only recovered `isUniqueViolation` (23505), so it
rethrew → 500 and the run was lost. Pre-diff (logical FK) it inserted gracefully.
**Fix:** added `isForeignKeyViolation` (`db-batch.ts`, factored a shared
`hasDbErrorCode` cause-walker). openRun now extracts its batch into a named
`buildOpenBatch` builder; on a 23503 **gated to `monitorId != null`** (so a
projectId/teamId FK violation still rethrows) it nulls the link — matching what
`onDelete: set null` would do — logs a `logger.warn`, and retries once. A
retry-time unique violation is routed back into the winner-reselect path so a
sibling-shard race still returns `duplicate` rather than 500-ing. Rollback safety
is guaranteed: the failed transaction rolls back fully, so the retry never
double-bumps usage.

### 4 — `cleanupUserData` afterDelete not best-effort

Runs after the auth `user` row is already deleted. A transient `runBatch` throw
previously orphaned the four logical-FK tables with no retry and no log (invisible
to Cloudflare Tail), and surfaced a spurious 500 for an already-succeeded
deletion. **Fix:** wrapped in try/catch + `logger.error` + swallow, mirroring
`recordAudit`. The `beforeDelete` sole-owner guard (`assertUserDeletable`) is
untouched — its throw is load-bearing.

### 5 — nondeterministic ordering under ties (3 sites)

openRun's prefill seeds a whole suite with one identical `lastSeenAt`, making
`ORDER BY lastSeenAt` ties common. Added a `testId` tiebreaker to:

- `search.ts` (⌘K palette top-N) — `.orderBy(desc(lastSeenAt), tests.testId)`
- `tests.server.ts` `runPageQuery` — `order by "lastSeen" desc, "testId"`
- `insights/slowest-tests.server.ts` — `order by p95 desc, "testId"`

The latter two use OFFSET pagination, where a non-unique sort key can **skip or
duplicate** rows across page boundaries — the more impactful of the three.

### 6 — stale `deleteMonitor` docstring

Said produced runs keep a "dangling monitorId"; the real FK sets it `null`.
Reworded to match the schema comment.

### 7 — unindexed `runs.monitorId` FK → seq-scan of `runs` on monitor delete

Phase 3 promoted `runs.monitorId` to a real FK with `onDelete: "set null"` **and**
dropped `runs_project_monitor_created_at_idx` in the same change — leaving the FK
child column with no index. Postgres enforces `SET NULL` by locating referencing
rows, so every `deleteMonitor` now sequentially scans `runs` (the largest table)
where the prior logical FK scanned nothing. Only fires on the rare admin-initiated
monitor-delete path, but on a large `runs` table it is a slow, lock-holding op.
**Fix:** added a PARTIAL index `runs_monitorId_idx ON runs(monitorId) WHERE
monitorId IS NOT NULL` (`db/schema.ts`) — tiny, since only synthetic runs carry a
`monitorId` (the CI hot path is null and stays unindexed, no write amplification).
Migration `20260704124312_moaning_xorn` (single `CREATE INDEX`, purely additive —
no backfill). The sibling `monitorExecutions.runId → runs` FK needs no such index:
nothing bulk-deletes `runs` (retention deletes only `testResults`/`artifacts`), so
its `set null` never fires.

## Files changed

- `src/lib/monitors/monitors-repo.ts` — #1 (config), #6 (docstring)
- `src/lib/monitors/monitor-schemas.ts` — #1 (stale docstring)
- `src/lib/ingest.ts` — #2 (sort), #3 (FK-recovery restructure)
- `src/lib/db-batch.ts` — #3 (`isForeignKeyViolation`, `hasDbErrorCode`)
- `src/lib/user-teardown.ts` — #4 (best-effort)
- `routes/api/t/[teamSlug]/p/[projectSlug]/search.ts` — #5
- `pages/t/[teamSlug]/p/[projectSlug]/tests.server.ts` — #5
- `pages/t/[teamSlug]/p/[projectSlug]/insights/slowest-tests.server.ts` — #5
- `src/lib/scope.ts` — removed an orphaned `sql` import (the rework's `staleRunFilter`
  change dropped the `coalesce(sql…)` fallback but left the import; it was a live
  `no-unused-vars` **error** in the inherited working tree, failing `vp check`).
- `db/schema.ts` + `db/migrations/20260704124312_moaning_xorn.sql` — #7 (partial FK index)

## Tests added (10 regression tests across the 6 findings)

- `src/__tests__/pg-integration.test.ts` (real-shape lane)
  - `monitors.config survives updateMonitor as a JS object, not a JSON string` (#1 — real-DB round-trip; fails pre-fix as a string)
  - `emits catalog rows sorted by testId …` (#2 — captures the builder's `.values()` order)
  - `search ordering is deterministic under tied lastSeenAt …` (#5 — 12 tied rows, stable top-8)
- `src/__tests__/ingest-pipeline.workers.test.ts` — #3, three cases:
  - monitor-deleted-mid-open → nulls monitorId, retries once, succeeds (`transactionSpy` called twice, `duplicate: false`)
  - a non-FK error rethrows (no retry)
  - an FK violation with no monitorId to blame (CI run) rethrows (the `monitorId != null` gate)
- `src/__tests__/db-batch.workers.test.ts` — #3: `isForeignKeyViolation` detects 23503 by code/message/cause-hop; false for 23505 and unrelated errors.
- `src/__tests__/user-teardown.workers.test.ts` (new) — #4: resolves + logs on a failed sweep, never rejects.

## Verification

- `pnpm --filter @wrightful/dashboard test` — **100 files / 1138 pass** (+5 workers tests: 3 FK-retry + 2 `isForeignKeyViolation`).
- `vitest run src/__tests__/pg-integration.test.ts` (real-shape lane) — **47/47 pass**, incl. the 3 new regression tests.
- `vp check` — **exit 0, 0 errors** (format ✓, typecheck ✓, lint ✓). The 119 remaining warnings are pre-existing repo-wide `no-unsafe-type-assertion` style nits, unchanged by this work.
- **#7 index:** `pnpm --filter @wrightful/dashboard test` re-run — node 244 pass / 4 skip, workers 1138 pass (migration chain applies in both pglite lanes). Full 10-migration chain also applied against a throwaway **real Postgres 15** instance (`initdb` + `psql -f` each file in order) — all apply clean and `pg_indexes` confirms `runs_monitorId_idx` is the intended partial (`WHERE (monitorId IS NOT NULL)`).
