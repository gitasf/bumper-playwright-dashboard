# 2026-06-22 — Ingest hot-path write contention + hand-synced dual encodings

Acted on a review that flagged two issues: (2) single-row write contention on the
ingest hot path, and (3) the proliferation of hand-synced dual encodings. Each
candidate was investigated against the real code (parallel readers + adversarial
critics) before deciding; several turned out to be already-solved or intrinsic,
so this worklog records both the changes made AND the reasoned no-ops.

## What changed

### P2 — Defer `testResults` usage metering off the ingest hot path (the real fix)

**Problem.** Every `/results` flush ran one transaction (`appendRunResults`,
`src/lib/ingest.ts`) that, alongside the per-test writes, upserted the team's
`usageCounters` row to bump `testResultsCount`. That row is **one per (teamId,
month)**, so the `ON CONFLICT (teamId, periodStart)` lock serialized _every
concurrent flush across the whole team_ — unrelated runs of the same team
(parallel CI shards/suites) blocked each other on that single row for the full
duration of each flush transaction. Invisible at current volume; a throughput
ceiling under a wide sharded suite.

**Key fact.** `testResults` is **never quota-gated**. `checkQuota` is only ever
called with `"runs"` (`routes/api/runs/index.ts`) and `"artifactBytes"`
(`src/lib/artifacts.ts`) — confirmed by grep and by the adversarial review. So
the live `testResultsCount` counter served **display only** (the usage settings
page). A counter you only display doesn't need a hot-path write.

**Change.** Removed the `testResults` `usageBumpStatement` (and the now-dead
`freshResultCount` reduction) from `appendRunResults`. `testResultsCount` is now
**derived on read**:

- New `countTeamTestResults(teamId, periodStart)` in `src/lib/usage.ts` — a live
  `count(*)` over the team's `testResults` rows in the period (project-scoped,
  `createdAt >= periodStart`, wrapped in `numericSql` for the int8-as-string
  trap). The query idiom is copied verbatim from the existing artifacts count in
  the same module.
- `loadTeamUsage` now derives `testResultsCount` via that helper instead of
  reading the stored column. The usage page therefore stays **exactly accurate**
  with no hot-path write and no cron-freshness dependency.
- `reconcileUsage` (the daily `rollup-usage` cron) uses the **same** helper, so
  the cron-stored value and the live page value can't disagree.

**Unchanged (deliberately):** `openRun` still bumps `runsCount` synchronously
(once per run; the run-open quota gate reads it), and `registerArtifacts` still
bumps **and** quota-gates `artifactBytes` synchronously on fresh bytes. The
per-run `runs`-row aggregate UPDATE stays as-is — its lock is per-run and
intrinsic (the `.returning()` broadcast summary must be transactionally
consistent), and it was never the team-wide ceiling.

### P3 — status-bucket: single-source the status→bucket membership

`STATUS_BUCKET_MEMBERS` (ingest, server) and the UI's `STATUS`/`statusGroupKey`
(`src/lib/status.ts`, ~10 client islands) encoded the same `timedout → failed`
collapse by hand, kept aligned only by cross-referencing comments + **per-side**
canaries — so a shared-row edit on one side would pass CI while the other
silently diverged.

- New dependency-free leaf `src/lib/status-buckets.ts` owns the membership as
  `STATUS_BUCKETS` (the superset, incl. `interrupted → flaky`), plus
  `WIRE_INVISIBLE_STATUSES`, the `StatusGroupKey` type, and `statusGroupKey()`.
  Dependency-free so both the server (ingest) and client (status) can import it
  without crossing the server/UI boundary (`status.ts` must not pull `void/db`
  into the browser bundle).
- `ingest.ts` now **derives** `STATUS_BUCKET_MEMBERS` from `STATUS_BUCKETS` minus
  `WIRE_INVISIBLE_STATUSES` (the per-test wire enum never carries `interrupted`).
  That filter is the one deliberate divergence — now an explicit transform, not a
  hand-maintained omission.
- `status.ts` drops the per-entry `groupKey` field, the local `StatusGroupKey`
  type, and the local `statusGroupKey()`; it re-exports both from the leaf so
  existing `@/lib/status` importers are unchanged.
- The ingest canary (`status-bucketing.workers.test.ts`) now cross-checks
  `STATUS_BUCKET_MEMBERS === STATUS_BUCKETS \ WIRE_INVISIBLE_STATUSES` — the
  cross-side guard the per-side canaries lacked.

### P3 — status-merge: pg-lane output-equivalence test (hardening)

The JS↔SQL run-status merge was already mostly single-sourced (the SQL severity
CASE is built by looping the JS `RUN_STATUS_SEVERITY` table; a workers test pins
the branch shape structurally). Added a **real-Postgres** property test in
`pg-integration.test.ts` that runs `mergeRunStatusSql` via a live `UPDATE` over
the full `current × incoming` status matrix and asserts equality with
`mergeRunStatus`. This executes the comparator (proving the _direction_
`current < incoming` and the running-bypass, not just the token shape) — the
sharding invariant that a later all-passing shard can't overwrite an earlier
failure. Also added a direct `countTeamTestResults` test (project-scope + period
window + empty-team-reads-zero), closing the only gap the P2 review flagged.

## Evaluated and deliberately NOT changed

- **config-gates** (`auth.ts` inlines the github/billing/open-signup decode
  rules that `@/lib/config` owns). Attempted to import the shared resolvers; the
  constraint is now **empirically confirmed intrinsic**: `void prepare` evaluates
  `auth.ts` in a bare-Node context that can't statically import the config source
  — the `@/lib` alias doesn't resolve, an extensionless relative `./src/lib/config`
  fails module resolution, and adding the `.ts` extension trips tsgo's TS5097
  (`allowImportingTsExtensions` is off). A `.mjs`+`.d.mts` leaf would add more
  machinery than the ~3 lines of trivial boolean duplication it removes. Reverted
  to the inline form; the comment now records the verified constraint, and
  `config.workers.test.ts` continues to pin the canonical copy.
- **artifact-identity** (`artifactIdentity()` ⇆ `artifacts_identity_uq`
  `COALESCE(role,'')` index). Intrinsic: the JS Map and the btree run in
  different engines, the enforced index is **frozen migration DDL that can't
  reference JS**, and the index leads with `projectId` while the JS key omits it
  (the lookup Map is already project-scoped) — so a single shared field array is
  _wrong_. The COALESCE literal can't be shared into the Drizzle index expression
  without parameterizing it (illegal in an index) or regressing to `sql.raw`. The
  existing canary (`artifacts-pipeline.test.ts`) already pins the JS null-coalesce,
  the index column set, the `COALESCE(role,'')` shape, and the drizzle-kit
  mis-quote regression at CI — every real drift vector. Left as-is.
- **aggregate-delta** (`computeAggregateDelta` ⇆ `aggregateRecomputeStatement`).
  Already single-sourced via `STATUS_BUCKET_MEMBERS` (now extended by the
  status-bucket work). No action; the dangerous drift was already eliminated.
- **wire-contract** (`packages/reporter/src/types.ts` ⇆ dashboard `schemas.ts`).
  The clean fix (a shared `z.infer` package) collides with the reporter's
  deliberate zero-runtime-dependency, published-artifact design (a value import
  pulls `zod` into the reporter bundle; a type-only import risks a dangling
  cross-package reference in the published `.d.ts`). `contract.test.ts` already
  makes drift a red-CI failure. Left as-is; revisit only if a shared package is
  created for other reasons.

## Files changed

| File                                             | Change                                                                                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/ingest.ts`                              | Removed `testResults` usage bump + dead `freshResultCount` from `appendRunResults`; `STATUS_BUCKET_MEMBERS` now derived from `STATUS_BUCKETS`; import of the new leaf |
| `src/lib/usage.ts`                               | New `countTeamTestResults`; `loadTeamUsage` + `reconcileUsage` use it; module doc updated                                                                             |
| `src/lib/status-buckets.ts`                      | **New** dependency-free leaf: `STATUS_BUCKETS`, `WIRE_INVISIBLE_STATUSES`, `StatusGroupKey`, `statusGroupKey`                                                         |
| `src/lib/status.ts`                              | Removed local `groupKey`/`StatusGroupKey`/`statusGroupKey`; re-exports from leaf                                                                                      |
| `db/schema.ts`                                   | `usageCounters` doc updated (testResults exception)                                                                                                                   |
| `auth.ts`                                        | config-gates comment updated to record the confirmed constraint (no behavior change)                                                                                  |
| `src/__tests__/status-bucketing.workers.test.ts` | Cross-side derivation assertion                                                                                                                                       |
| `src/__tests__/status-registry.workers.test.ts`  | `groupKey` assertion routed through `statusGroupKey()`                                                                                                                |
| `src/__tests__/pg-integration.test.ts`           | `mergeRunStatusSql` full-matrix equivalence test + `countTeamTestResults` test; `testResults` added to the harness                                                    |

No schema/migration change (the `usageCounters` edit is comment-only).

## Follow-up recommendations (not done here)

- **Load test the "one team, many parallel suites" case before launch**, driving
  many `/results` **batches** (not just run-opens) — the per-batch `testResults`
  bump was the contention point, so the test must exercise batches to confirm the
  fix.
- If `testResults` (or any dimension fed by `reconcileUsage`) ever becomes
  quota-gated, **bound `reconcileUsage` to a team slice and tighten its cadence**
  first — it currently recomputes all teams in one unbounded daily pass (already
  flagged pre-launch in `usage.ts`).
- Minor, pre-existing (unchanged by this work): `buildResultInsertStatements`
  rewrites `createdAt = now` on existing-row updates, so a cross-month re-streamed
  testResult is counted in the later month. The new read-time count inherits the
  same `createdAt` semantics `reconcileUsage` always used, so the page now _agrees_
  with the cron rather than diverging.

## Verification

- `tsgo --noEmit` (dashboard): clean on all touched files.
- `vp check` (format + lint + typecheck, whole repo): **0 errors** (119 pre-existing
  warnings, none in touched files).
- Node test lane (`vp test run`): **211 passed** (was 210; +1 merge-matrix, +1
  countTeamTestResults, both in pg-integration).
- Workers test lane (`vp test run -c vitest.workers.config.ts`): **1113 passed**.
- pg-integration (pglite): **33 passed**, including the new `mergeRunStatusSql`
  matrix + `countTeamTestResults` tests (also exercised on real node-postgres
  under `PG_TEST_URL` in CI).
- Two independent adversarial review agents (one per substantive change) reviewed
  the diffs against `git HEAD` and returned **"correct and safe to ship,"** no
  blockers/majors. The P2 review's one actionable suggestion (a direct
  `countTeamTestResults` test) was implemented.
