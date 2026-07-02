# 2026-07-01 — Sharded runs: defer terminal status until every shard completes (+ per-shard status records)

## What changed

Fixes the long-standing "the run shows **succeeded** while sibling shards are still streaming tests" behavior for sharded Playwright suites.

**Before:** all shards of a suite share one `idempotencyKey` → one `runs` row, and each shard called `POST /api/runs/:id/complete` **independently**. `mergeRunStatus` took the first shard's status verbatim out of `running` (`if (current === "running") return incoming`), so the run flipped to a terminal status (usually `passed`) the instant the **first** shard finished — while other shards were still streaming `/results`. The severity merge kept the _final_ recorded status correct (a later failing shard escalated `passed → failed`), but the run visibly showed a terminal/green header with a climbing test count, could flip green→red later, and posted a GitHub check on the first shard's complete. There was no shard-count coordination anywhere.

**After:** the reporter now sends Playwright's `config.shard` (`{ index, total }`) on both open and complete. The dashboard records **one `runShards` row per shard** and keeps the run at `status='running'` until every shard has reported, then sets the run's status to the **worst status across all shards**. The run stays in the loading/in-progress state until the final shard's final test — exactly the requested behavior. Per-shard status is persisted (`runShards`) for a future per-shard UI breakdown.

Non-sharded runs (and pre-shard-aware reporters) are completely unchanged: no `shard` field → `expectedShards` NULL → the legacy `mergeRunStatusSql` finalize-on-single-complete path.

## Details

| Area                             | Change                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Schema** (`db/schema.ts`)      | New `runShards` table (`id`, `projectId`, `runId`, `shardIndex`, `shardTotal`, `status`, `durationMs`, `completedAt`, `createdAt`) with unique `(projectId, runId, shardIndex)` and FK cascade off both `runs` and `projects`. New nullable `runs.expectedShards` (the shard-total denominator).                                                                   |
| **Migration**                    | `db/migrations/20260701150234_overrated_loki.sql` (generated via `pnpm db:generate`). Additive: one new table + one nullable column.                                                                                                                                                                                                                               |
| **Wire contract**                | `ShardSchema { index, total }` added optional on `OpenRunPayloadSchema` + `CompleteRunPayloadSchema` (`src/lib/schemas.ts`); mirrored as `ShardInfo` on the reporter's `OpenRunPayload`/`CompleteRunPayload` (`packages/reporter/src/types.ts`). Additive + optional → no protocol version bump (still v3); old dashboards strip the field, old reporters omit it. |
| **Reporter**                     | `onBegin` captures `config.shard` → `this.shard`; sent on the open payload and threaded into `client.completeRun` on both the normal `onEnd` path and the SIGTERM/SIGINT best-effort `interrupted` complete. `client.completeRun` gained a `shard?` option.                                                                                                        |
| **Ingest** (`src/lib/ingest.ts`) | `buildRunInsertValues` sets `expectedShards`. `openRun`'s duplicate paths backfill it via `reopenRunForWrites` (coalesce). `completeRun` branches: sharded (`payload.shard && expectedShards > 1`) → new `completeShardedRun`; else legacy. `finalizeStaleRun` (watchdog) is now shard-aware. New pure export `worstShardStatus`.                                  |

### `completeShardedRun` — concurrency

Shards complete in any order and can overlap. The whole decision runs in one transaction that first takes a **`SELECT … FOR UPDATE`** lock on the run row, serializing every sibling's `/complete` for that run. That is what makes the per-shard count reliable: whichever shard commits **last** acquires the lock after all others have committed their rows, sees the full count, and is the one that flips the run terminal. Without the lock, two concurrent completes could each read a count below the total under READ COMMITTED and **neither** would flip, stranding the run at `running`. The `runShards` upsert (`ON CONFLICT (projectId, runId, shardIndex)`) makes a retried `/complete` idempotent — it updates the shard's row in place instead of double-counting toward `expectedShards`. Final status/duration/completedAt are order-independent (worst severity / max), so a retried last-shard complete lands on the same values.

While the run is still waiting on shards it stays `running` (no `completedAt`), so `runClosedForWrites` never closes it — a slow-but-alive straggler can always complete. This also **narrows the old "late failing shard rejected past the 30-min grace window" data-loss edge**: the run can't go terminal (and thus can't start the grace clock) until all shards have reported.

### Watchdog shard-awareness

A sharded run only sits at `running` past the stale window when a shard died (SIGKILL) — but sibling shards that _did_ complete may have failed. `finalizeStaleRun` now finalizes to the worst of `{completed shard statuses} ∪ {interrupted}` instead of always `interrupted`, so a real failure (severity 4) isn't masked as `interrupted` (severity 3). Non-sharded runs have no `runShards` rows → the set is just `{interrupted}` → unchanged behavior.

### GitHub check

`maybePostGithubCheck` is only called from the sharded path once the run is actually terminal (`allDone`), so an in-progress (still-sharding) run never publishes a "completed" check. The legacy path is unchanged.

## Retention / DB growth

`runShards` is **run-level metadata** (a handful of rows per run — one per shard), the same order of magnitude as the `runs` table, not per-test detail like `testResults`. The retention sweep (`src/lib/retention.ts`) deliberately keeps `runs` summary rows forever and only prunes `testResults` (+cascade) and artifacts, so it does **not** touch `runShards` — and shouldn't, by the same "run history outlives its detail" rationale. The FK cascade (`runShards.runId → runs`, `runShards.projectId → projects`, both `ON DELETE CASCADE`) means shard rows are removed automatically whenever a run _is_ deleted (project/team teardown, or any future run-level pruning). No retention-cron change was made; if run-level pruning is ever added, `runShards` is already cascade-safe.

## Verification

- `pnpm db:generate` — migration generated cleanly (23 tables, `runShards` 9 cols / 1 index / 2 fks).
- `pnpm check` (format + lint + type-aware typecheck, whole repo) — **0 errors** (120 pre-existing warnings in `packages/e2e`, unrelated).
- Dashboard typecheck (`tsgo --noEmit`) + reporter typecheck (`tsc --noEmit`) — clean.
- New tests:
  - `src/__tests__/sharded-complete.test.ts` (node lane, real pglite) — deferred finalize (stays running until the last shard, then worst status), all-pass → passed, idempotent retry (no double-count), non-sharded legacy immediate finalize, and shard-aware `finalizeStaleRun` (completed-shard failure surfaces; incomplete all-pass → interrupted; non-sharded → interrupted). 7 tests.
  - `worstShardStatus` unit tests appended to `merge-run-status.workers.test.ts`.
  - Sharded open/complete wire-contract tests in the reporter's `contract.test.ts`.
- Regression sweep: reporter 274 tests pass; dashboard node-lane pg-integration + sharded-complete (40) and workers-lane ingest/merge-run-status/retention/github-checks/drain-stale/summary/build-run-insert/scope-where (110) all pass.

## Not done (follow-ups)

- **UI** — no per-shard breakdown or "N of M shards" indicator yet; `expectedShards` + `runShards` are persisted and available to the run-detail loader for that work. The realtime `RunProgressEvent.summary` was intentionally left unchanged (it already carries `status`, which now stays `running` until all shards finish, so live viewers see the in-progress state without any UI change).
