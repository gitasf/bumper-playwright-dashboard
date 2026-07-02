# 2026-07-01 — Post-review quality pass: dedup the sharded terminal tail + swap the retention subrequest-estimate for a chunk-count budget

## What changed

A thermo-nuclear code-quality review of the two same-day features
([sharded deferred-finalize](2026-07-01-sharded-run-deferred-finalize.md) and
[retention drain-to-budget](2026-07-01-retention-drain-to-budget.md)) surfaced a
small set of high-conviction structural findings. Each was independently
re-verified against the code, then addressed. **No behavior changed** — these
are behavior-preserving simplifications plus one accuracy fix to a budget model.

### Sharded finalize (`src/lib/ingest.ts`)

- **Deleted the duplicated terminal broadcast tail.** `completeShardedRun` had a
  byte-for-byte copy of the `broadcastRunUpdate` + `run-progress` project-room
  publish that `reconcileAndBroadcast` owns — which is exactly the "mirrored by
  convention" duplication `reconcileAndBroadcast`'s own docstring says it exists
  to prevent. Extracted `broadcastRunProgress(runId, projectId, summary)` as the
  single two-room publish; both `reconcileAndBroadcast` and `completeShardedRun`
  now call it.
- **Collapsed `worstShardStatus` onto the canonical severity merge.** It was a
  second severity reducer alongside `mergeRunStatus`/`RUN_STATUS_SEVERITY`. Its
  per-step logic (keep the strictly-more-severe, ties keep first-seen) is
  identical to `mergeRunStatus`'s non-`running` branch, and shard statuses are
  always terminal (never `running`), so it is now
  `statuses.reduce((worst, s) => mergeRunStatus(worst, s))` with an empty→null
  guard. One severity model instead of two; its unit tests are unchanged and
  still green.
- **Dropped the redundant `expectedShards` re-write from the not-done branch.**
  The column is set at open and `coalesce`-backfilled on every duplicate open,
  and the done branch re-asserts it, so re-writing it on every in-progress
  shard `/complete` was redundant. The not-done branch is now a pure liveness
  bump; the done branch still persists it (keeps the terminal row correct even
  in the mixed-version fallback).
- **Typed `completeShardedRun`'s `shard` param off the shared contract.** Was a
  third hand-written `{ index; total }`; now `NonNullable<CompleteRunPayload["shard"]>`,
  so a wire-shape change can't silently drift from this internal signature.

### Retention drain (`src/lib/retention.ts`, `env.ts`, `crons/sweep-retention.ts`, `src/lib/artifacts.ts`)

- **Replaced the subrequest-estimate budget with a chunk-count budget.** The old
  per-chunk estimate `2 + … + r2(a) + r2(t)` never charged the cascaded-artifact-key
  SELECT `sweepProjectTestResults` issues, so its "deliberate over-count — never
  past the budget" comment was **false** (it under-counted). Every `sweepOne` is
  `.limit(chunkSize)`-bounded and does a fixed, bounded handful of subrequests,
  so a **chunk count is itself a hard subrequest bound** — no drift-prone cost
  model needed. `SweepBudget.spend(subrequests)` → `recordChunk()`; the drain
  charges one chunk per `sweepOne`. Deleted `r2Subrequests`, the
  `ProjectSweepChunk` interface (its `subrequests` field is gone and the rest is
  isomorphic to `RetentionSweepResult`, which `sweepOne` now returns directly),
  and the estimate expression + comment. `DELETE_KEYS_PER_CALL` un-exported
  (`artifacts.ts`) — its only external consumer was `r2Subrequests`.
- **Env:** `WRIGHTFUL_RETENTION_SWEEP_MAX_SUBREQUESTS` (default 800) →
  `WRIGHTFUL_RETENTION_SWEEP_MAX_CHUNKS` (default 120). At ~7 subrequests/chunk
  worst case, 120 chunks stays under the Workers per-invocation subrequest cap
  with margin; wall-clock (`_BUDGET_MS`, 20s) remains the normal binding limit.
  Both features are unshipped in this same diff, so no live config contract broke.
- **`SweepBudget` kept, now justified.** With two real axes (wall-clock deadline
  - chunk ceiling) the interface + factory earn their encapsulation, so the
    review's "collapse it to a bare deadline predicate" note no longer applies.
- Cleared a pre-existing `no-shadow` lint warning: `drainRetention`'s `projects`
  param (shadowing the `projects` table import) → `projectList`.

## Findings addressed vs. deferred/corrected

| Finding                                                                      | Disposition                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1 duplicated terminal tail + parallel severity reducer                      | Fixed (extract + fold)                                                                                                                                                                                                                                                                                                                                |
| #2 subrequest estimate under-count / false comment                           | Fixed (chunk-count budget)                                                                                                                                                                                                                                                                                                                            |
| #3 `SweepBudget` over-abstracted                                             | Resolved — now genuinely two-axis, so justified                                                                                                                                                                                                                                                                                                       |
| #4 `ProjectSweepChunk` ≈ `RetentionSweepResult`                              | Fixed (deleted; `sweepOne` returns the result directly)                                                                                                                                                                                                                                                                                               |
| #5 redundant `expectedShards` re-persist                                     | Fixed (dropped from the not-done branch)                                                                                                                                                                                                                                                                                                              |
| #7 inline `shard` param type                                                 | Fixed (`NonNullable<CompleteRunPayload["shard"]>`)                                                                                                                                                                                                                                                                                                    |
| #6 split the merge layer / shard code out of `ingest.ts` (1736 lines)        | **Deferred** — `ingest.ts` was already >1k before these features (the PR didn't cross the boundary), a clean split re-points many `@/lib/ingest` imports across source + tests for purely cosmetic gain, and #1 already shrinks the shard footprint. Left as a standalone follow-up.                                                                  |
| Review's "int8-as-string bonus bug" on `runShards.completedAt`               | **Corrected — not a bug.** `completeShardedRun` reads it via a _typed_ Drizzle `.select`, and `big = bigint(mode:"number")` → `PgBigInt53.mapFromDriverValue = Number(value)` (verified in drizzle-orm 0.45.2), so it is a JS number in both node-postgres and pglite. The trap only bites raw reads. No cast added; the `Math.max` was never unsafe. |
| Review's judo "merge every shard into `runs.status` via `mergeRunStatusSql`" | **Rejected as unsafe.** `mergeRunStatusSql` promotes the run out of `running` on the FIRST shard (`WHEN current='running' THEN incoming`) — that is the early-flip bug the feature fixes. Kept `runShards` + the count-gate; only the JS-side dedup (above) was applied.                                                                              |

## Verification

- `pnpm check` (format + lint + type-aware typecheck, whole repo) — **0 errors, 120 warnings** (all pre-existing in `packages/e2e` + unrelated files; one `retention.ts` shadow warning cleared, 121 → 120).
- Full dashboard unit suite — **1126 workers-lane + 225 node/workers-lane tests pass** (0 new failures).
- Focused reruns after the last edit: `retention.workers` + `merge-run-status.workers` (28 pass), `sharded-complete` node lane (7 pass).
- Behavior-preservation rationale: `broadcastRunProgress` is the same two calls in the same order; `worstShardStatus` reduces to the same severity pick (empty→null preserved); the not-done `expectedShards` write was redundant with the open-time/backfill/done-branch writes; the chunk-count budget stops the drain on the same two conditions (wall-clock OR a hard work cap) as before, just with an accurate, drift-free cost measure.

## Not done (follow-ups)

- #6 module extraction of the `RUN_STATUS_SEVERITY`/`mergeRunStatus*` layer + shard orchestration out of `ingest.ts` — deferred (rationale above); a good standalone cleanup if `ingest.ts` keeps growing.
