# 2026-07-02 — Group run tests by shard

## What changed

Added a third **Group by** axis to the run-detail Tests tab — **Shard** — alongside
the existing File / Playwright project. Users running a sharded Playwright suite
(`--shard=1/N`) can now see which tests ran in which shard.

The hard part (correlating N shards into one run) already existed — all shards
share an `idempotencyKey`, land on one `runs` row, and record per-shard
completion in `runShards` (see the sharded-finalize worklogs). What was missing
was **per-test shard attribution**: shard coordinates rode only on the open /
complete payloads, never on individual test rows, so we knew _how many_ shards
ran but not _which shard produced a given test_. This change threads a per-test
`shardIndex` end-to-end so the (already client-side) grouping engine can key on
it.

`shardIndex` is a **new per-test attribute**, deliberately distinct from the
existing `testResults.workerIndex`: worker indices reset per shard and repeat
across shards, so they are **not** a valid shard proxy.

## Details

`shardIndex` is **1-based** (mirrors Playwright `config.shard.current`) and
**nullable** — `null` on a non-sharded run and on still-queued rows no shard has
claimed. It is threaded through every layer:

| Layer               | File                                             | Change                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reporter wire type  | `packages/reporter/src/types.ts`                 | `TestResultPayload.shardIndex: number \| null` (always present, unlike the run-level `shard` which is omitted when non-sharded)                                                                                                  |
| Reporter emit       | `packages/reporter/src/index.ts`                 | `buildPayload(entry, rootDir, shardIndex?)`; call site passes `this.shard?.index ?? null`                                                                                                                                        |
| Seeder builder      | `packages/reporter/src/payload.ts`               | `ResultFields.shardIndex?`; `buildResult` defaults to `null`                                                                                                                                                                     |
| Ingest Zod          | `apps/dashboard/src/lib/schemas.ts`              | `TestResultSchema.shardIndex: z.number().int().min(1).nullable().optional()` (optional keeps pre-shard-aware reporters parsing)                                                                                                  |
| DB column           | `apps/dashboard/db/schema.ts`                    | `testResults.shardIndex: integer` (nullable)                                                                                                                                                                                     |
| Ingest write        | `apps/dashboard/src/lib/ingest.ts`               | the batch-flush upsert carries `shardIndex` (in `insertRows` + refreshed on conflict via `resultUpsertSet()`); `buildQueuePrefillStatements` stamps the opening shard's queued rows; `buildChangedTests` (live event) carries it |
| SSR seed / paginate | `apps/dashboard/src/lib/run-results-page.ts`     | projection selects + maps `shardIndex`                                                                                                                                                                                           |
| Realtime wire row   | `apps/dashboard/src/realtime/events.ts`          | `RunProgressTest.shardIndex: number \| null`                                                                                                                                                                                     |
| Grouping engine     | `apps/dashboard/src/lib/group-tests-by-file.ts`  | `GroupByAxis` gains `"shard"`; `groupKeyFor()` → `"Shard N"` / `"Unsharded"`                                                                                                                                                     |
| Island              | `apps/dashboard/src/components/run-progress.tsx` | `isSharded` derived from rows; **Shard** toggle shown only when the run has shard data                                                                                                                                           |

### Design decisions

- **Always-present per-test field, run-level field stays conditional.** The
  open/complete `shard` object is omitted for non-sharded runs (legacy path
  preserved); the per-test `shardIndex` is always emitted (as `null`) so the
  cross-package contract key-set canary (`contract.test.ts`) stays exact.
- **No protocol-version bump.** The field is additive + optional; request
  schemas are plain `z.object()` (Zod default _strip_), so a new reporter and an
  old dashboard — or vice-versa — parse clean across version skew.
- **Queue prefill stamps the opening shard only.** Shards 2..N re-open the same
  run and (by existing design) do **not** re-prefill; their tests arrive as
  fresh `/results` rows already carrying their own `shardIndex`. So queued rows
  show the opening shard immediately, and every other shard's rows are attributed
  as they stream.
- **Toggle is data-driven.** The Shard option appears only when some row has a
  non-null `shardIndex` (`tests.some(...)`), so non-sharded runs never see it.
- **Shard groups reuse the shared worst-first sort** (`groupSeverityScore`) —
  the failing shard floats to the top, consistent with File/project grouping.
  (Intentional; easy to switch to numeric order later if desired.)

### Migration

`apps/dashboard/db/migrations/20260703205234_groovy_madripoor.sql` — a single
additive nullable column:

```sql
ALTER TABLE "testResults" ADD COLUMN "shardIndex" integer;
```

Generated via `pnpm --filter @wrightful/dashboard db:generate`. Non-destructive;
backfill is unnecessary (existing rows read `null` → "Unsharded").

## Local seeding — a faithful sharded run

To exercise the grouping at scale there was no way to produce a sharded run
locally (the synthetic history caps a run at ~60 tests, the Playwright seed suite
is 12, and `--volume` only adds more _runs_). Added an opt-in seeder:

```bash
pnpm --filter @wrightful/dashboard seed:sharded        # 1000 tests, 8 shards
SHARDED_TESTS=2000 SHARDS=12 pnpm --filter @wrightful/dashboard seed:sharded
```

It injects **one genuinely-sharded run** into the running dev dashboard — not
cosmetic tagging. `buildShardedRun` (`scripts/seed/generator.mjs`) partitions N
tests round-robin across K shards; `ingestShardedRun`
(`scripts/seed/ingest-runs.mjs`) opens/appends/completes **once per shard**, all
sharing one `idempotencyKey`, each carrying `shard {index,total}` on open +
complete. That drives the real path: `expectedShards`, one `runShards` row per
shard, deferred worst-status finalize — plus per-test `shardIndex` for grouping.
The run is not backdated, so it lands at the top of the runs list.

| File                                                       | Change                                                                                                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/reporter/src/payload.ts`                         | `buildOpenRunPayload` accepts `meta.shard` (top-level); `buildCompleteRunPayload(status, durationMs, shard?)` — both optional, backward-compatible |
| `apps/dashboard/scripts/seed/generator.mjs`                | new `buildShardedRun({ tests, shards, seed })`                                                                                                     |
| `apps/dashboard/scripts/seed/ingest-runs.mjs` (+ `.d.mts`) | new `ingestShardedRun`; `IngestClient.completeRun` options gain `shard`                                                                            |
| `apps/dashboard/scripts/seed-sharded.mjs`                  | new standalone `seed:sharded` entry (always rebuilds the reporter so `dist` carries the new fields)                                                |
| `apps/dashboard/package.json`                              | `"seed:sharded"` script                                                                                                                            |

## Verification

- **Typecheck** — `pnpm --filter @wrightful/reporter typecheck` and
  `pnpm --filter @wrightful/dashboard typecheck` both clean. (Fixed two reporter
  test payload literals — `batcher.test.ts`, `quarantine.test.ts` — plus three
  `RunProgressTest` test helpers that the new required field surfaced.)
- **Reporter tests** — 279 passed (includes the `contract.test.ts` key-set
  canary confirming reporter ↔ dashboard field parity, new `buildPayload`
  shard-threading cases in `aggregation.test.ts`, and `buildOpenRunPayload` /
  `buildCompleteRunPayload` shard cases in `payload.test.ts`).
- **Dashboard tests** — 225 passed / 4 skipped (default lane) + 1132 passed
  (workers lane). Added `groupAndSortTests` shard-grouping cases in
  `group-tests-by-file.workers.test.ts` and `ingestShardedRun` driver cases in
  `seed-ingest-runs.workers.test.ts`.
- **Seeder smoke** — `buildShardedRun({ tests: 10, shards: 3 })` produces 3
  shards sharing one idempotencyKey, correct `{index,total}` on open + complete,
  round-robin `shardIndex` on all 10 results, per-shard `expectedTotalTests`.
- **`pnpm check`** — 0 errors (format + lint + typecheck). The remaining
  `no-unsafe-type-assertion` entries are pre-existing repo-wide warnings,
  unrelated to this change.

## Not done (possible follow-ups)

- The test-detail page shows `workerIndex` but not `shardIndex` — could surface
  "ran on shard N" there too.
- Shard-group ordering is worst-first, not numeric — trivial to change if users
  prefer Shard 1 → N.
- A per-shard status/duration strip on the run-detail page (the `runShards` table
  already holds the data; only the grouping view was built).
