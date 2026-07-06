# 2026-07-03 — Ingest /results flush: batched upsert + insert-only createdAt + locked delta (P1-1, P2-createdAt, P2-delta)

## What changed

Rewrote the per-flush write shape in `buildResultInsertStatements`
(`src/lib/ingest.ts`) and restructured `appendRunResults` around a run-row
`FOR UPDATE` lock. Three coupled fixes from the 2026-07-03 architecture review,
in one change because they share the hot path and the lock is what makes the
upsert's id-mapping race-safe.

### P1-1 — batch the flush (was ~4 statements **per existing result**)

The reporter prefills a `queued` row for every planned test at `onBegin`, so
**every** streamed result took the existing-row branch: `UPDATE testResults` +
`DELETE testTags` + `DELETE testAnnotations` per row, plus an unconditional
`DELETE testResultAttempts` per row. `runBatch` awaits statements strictly
sequentially on one connection, so a 5000-result flush was ~20k serial
round-trips inside one transaction.

Now a flush is a handful of statements regardless of size:

1. **One** multi-row `INSERT … ON CONFLICT (runId, testId) DO UPDATE` upserts
   every result — a fresh row inserts, a prefilled/re-sent row updates in place
   keeping its `id` (child FKs stay valid) and `createdAt`. Chunked under the
   65535 bound-param ceiling.
2. **Three** IN-list `DELETE`s (tags, annotations, attempts) via the new
   `childByTestResultsWhere` scope predicate — a flush is `≤ MAX_RESULTS_PER_BATCH`
   ids, so one statement each in practice. Deleting a fresh row's (absent)
   children is a harmless no-op, so one uniform path covers insert + update.
3. Chunked multi-row `INSERT`s of the new child rows.

Ordering is load-bearing: parent upsert → child DELETEs → child INSERTs.

### P2-createdAt — `createdAt` is now insert-only; added `updatedAt`

The old UPDATE path wrote `createdAt = nowSeconds` on every re-write, making it a
de-facto "last-modified" — which skewed month-boundary usage metering, analytics
time-buckets, and retention age. The `DO UPDATE SET` **omits** `createdAt`
(insert-only) and writes a new nullable **`updatedAt`** column instead. No reader
needed to change — they all become correct once `createdAt` stops moving.

- Schema: `testResults.updatedAt = big("updatedAt")` (nullable → simple
  `ADD COLUMN`, no NOT-NULL backfill; readers `coalesce(updatedAt, createdAt)`).
- Migration: `db/migrations/20260703090745_big_vampiro.sql`.
- Prefill + insert set `updatedAt = nowSeconds`; the upsert's `DO UPDATE` sets it
  from `excluded`.

### P2-delta — prev-status read under a FOR UPDATE lock

`appendRunResults` previously read prior statuses (`resolveTestResultIds`) **before**
the transaction and applied an additive `runs.<counter> = col + delta` UPDATE.
Two concurrent identical flushes (the reporter's 30s per-attempt timeout re-POSTs
a batch while the first is still running) each read the same prev-status and
**both** added the delta — double-applying the live counters (self-heals at
`/complete`'s recompute, but mid-run viewers saw inflated totals).

`appendRunResults` now takes a `SELECT … FOR UPDATE` on the run row (scoped to the
single row via `runByIdWhere`) at the top of its transaction and reads
`resolveTestResultIds` on `tx` under the lock — mirroring `completeShardedRun`. A
serialized second flush sees the first's committed status → the delta nets to
zero. Reading the ids under the lock **also** keeps the upsert mapping race-safe:
a second flush resolves the real id instead of a phantom fresh ULID the
`ON CONFLICT DO UPDATE` would discard (which would have pointed the reporter's
artifact PUTs at a non-existent testResultId).

## Details

| File                                            | Change                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db/schema.ts`                                  | `testResults.updatedAt` (nullable bigint); doc on `createdAt` (insert-only) + `updatedAt`.                                                                                                                                                                                                                                                         |
| `db/migrations/20260703090745_big_vampiro.sql`  | `ALTER TABLE "testResults" ADD COLUMN "updatedAt" bigint;`                                                                                                                                                                                                                                                                                         |
| `src/lib/ingest.ts`                             | `buildResultInsertStatements` rewritten to the batched upsert + IN-list deletes; `resolveTestResultIds` takes an optional `exec` (defaults to `db`); `buildQueuePrefillStatements` sets `updatedAt`; `appendRunResults` restructured to a direct `db.transaction` with the `FOR UPDATE` lock; removed the now-unused `runBatchWithSummary` helper. |
| `src/lib/scope.ts`                              | Added `childByTestResultsWhere` (the batched `(projectId, testResultId IN (…))` predicate); imported `inArray`.                                                                                                                                                                                                                                    |
| `src/__tests__/ingest-pipeline.workers.test.ts` | Mock: tx SELECTs (the lock + prev-status read) dequeue the read FIFO instead of recording as statements; added `.for` to the builder chain; four append tests gain the FOR-UPDATE FIFO entry.                                                                                                                                                      |
| `src/__tests__/pg-integration.test.ts`          | New describe executing the upsert on real Postgres: prefilled-row upsert keeps id + `createdAt`, refreshes status + `updatedAt`, replaces children; fresh insert stamps both timestamps; serial re-flush nets a **zero** aggregate delta (the serial-equivalent of the lock; true concurrency needs the `PG_TEST_URL` CI leg).                     |

## Notes / follow-ups

- The `FOR UPDATE` lock's true-concurrency protection is only exercisable on the
  real-postgres CI leg (`PG_TEST_URL`); pglite is single-connection and can only
  prove the serial-equivalent, which the pg-integration test does.
- `createdAt` for a prefilled test now reflects **run-open** time (the prefill
  insert), not first-result time — both stable and monotonic; retention age is
  measured from open time.

## Verification

- `pnpm --filter @wrightful/dashboard exec vitest run src/__tests__/pg-integration.test.ts` — 36 passed (3 new upsert tests, pglite lane).
- `ingest-pipeline.workers.test.ts` — 11 passed.
- Full dashboard suite (node 231 + workers 1129) green; reporter 274 green; `pnpm check` — 0 errors.
