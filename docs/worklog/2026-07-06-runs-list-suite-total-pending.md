# 2026-07-06 — Runs list Outcome column: full suite total + pending count (exact for sharded runs)

## What changed

The Outcome column on the runs list previously used only the _reported_ buckets
(`passed + failed + flaky + skipped`) as the bar's denominator and the `/N`
total, so a streaming run's bar was always "full" and gave no sense of how far
through the suite the run was. The column now uses the full declared suite size
as the denominator and shows a still-pending count while results stream — and
that suite size is **exact for sharded runs**, derived as the sum of per-shard
planned-test counts.

Two pieces:

1. **Display** — the reporter counts `suite.allTests()` at `onBegin` and sends
   it as `run.expectedTotalTests` on `POST /api/runs`; ingest persists it on
   `runs.expectedTotalTests`. The Outcome column now uses it as the bar's
   denominator and renders the not-yet-reported remainder as a muted
   `{n} pending` count.
2. **Sharded exactness** — Playwright filters the suite _before_ reporters see
   it, so in a sharded run each shard's `onBegin` count covers only its own
   slice and no single shard knows the suite total. Previously only the
   run-opening shard's count was recorded (shards 2..N hit the duplicate-open
   path and their counts were discarded), so a sharded run's denominator
   started at one shard's slice. Now every shard's open records its count and
   the run's total is re-derived as the sum, converging on the exact suite
   size as soon as all shards have opened (typically seconds into the run).

## Details

### Storage: `runs.shardExpectedTests` (jsonb)

Per-shard counts live in a jsonb map ON the run row — `{"1": 100, "2": 120}`,
1-based shard index → that shard's `onBegin` planned-test count. Migration:
`20260706223515_abnormal_omega_red.sql` (one nullable column; null for
non-sharded runs).

**Design decision — jsonb column over a child table.** A first cut used a
`runShardExpectations` table (unique on `(projectId, runId, shardIndex)`,
`FOR UPDATE` + upsert + SQL sum in a transaction). We swapped to jsonb
deliberately:

- **Retention/cleanup**: the sweep crons tidy old runs; per-shard counts on
  the run row itself mean no extra child table for the retention path (or any
  future run-deletion surface) to know about — the data dies with the row.
- **One statement, no explicit lock**: the merge + re-sum collapse into a
  single UPDATE, so racing sibling-shard opens serialize on the ordinary row
  lock (a blocked UPDATE re-evaluates its SET against the winner's committed
  row under READ COMMITTED). The table version needed a `FOR UPDATE`
  transaction to make the upsert-then-sum race-safe.
- The cost is hand-written jsonb SQL (Drizzle 0.45 has no builder API for
  `jsonb_set`/`jsonb_each_text` — whole-value reads/writes only), which is the
  repo's known raw-SQL trap zone — mitigated by verifying the exact statement
  shape against real Postgres 16 (below). `runShards` (per-shard _completion_
  rows, where "a row exists" gates the deferred terminal flip) is untouched.

### Ingest (`src/lib/ingest.ts`)

- `expectedTestsFromOpenPayload` — single owner of the "explicit count, else
  planned-list length" derivation.
- Fresh open: `buildRunInsertValues` seeds `expectedTotalTests` with the
  opener's count and, when sharded, seeds `shardExpectedTests` with the
  opener's own slice (`{"<index>": count}`) so later re-sums include it.
- Duplicate open (shards 2..N, or a shard's retry) with a `shard` payload:
  `reopenRunForWrites` runs ONE UPDATE that merges the shard's count via
  `jsonb_set(coalesce(shardExpectedTests,'{}'), array['<index>'], to_jsonb(...))`
  and re-derives `expectedTotalTests` as
  `sum(cast(value as integer)) from jsonb_each_text(<merged map>)` — the
  merged-map fragment appears in both SET expressions because SET can't
  reference its own new values; both evaluate against the OLD row, which is
  consistent. Keying by shard index makes a reporter retry REPLACE its count,
  and the exact re-sum (not `greatest`) lets a shrunken re-run LOWER the
  total instead of showing phantom pending tests forever. The
  `expectedShards` coalesce-backfill and `lastActivityAt` bump fold into the
  same statement. Non-sharded duplicate opens keep the plain
  `lastActivityAt` bump.
- `AGGREGATE_SUMMARY_COLUMNS` now includes `expectedTotalTests`, so every
  `run-progress` summary broadcast carries the current value — live runs-list
  rows converge on the exact total as shards open (the value rides the next
  /results flush; the duplicate open itself doesn't broadcast).

### Wire types / realtime

- `RunProgressEvent["summary"]` and the zod `summarySchema` gain
  `expectedTotalTests: number | null`; `RunListRowData` gains the same field
  (seeded by SSR / `run-created`, kept fresh by the summary overlay in
  `applyProjectFeedEvent`).
- `openRun`'s synthesized initial snapshot and the `run-created` event carry
  it from the inserted row values.
- `RUN_PUBLIC_COLUMNS` includes `shardExpectedTests` (keeping its
  "every column except the `idempotencyKey` credential" contract true).
- **Public API**: `GET /api/v1/runs/:runId` now returns `expectedTotalTests`
  alongside `totalTests` (documented in `docs/api/query-export.md`) — lets an
  API consumer detect a partially-run suite, and gives the e2e suite a clean
  assertion surface.

### UI (`src/components/run-list-row.tsx`)

Denominator is `max(expectedTotalTests ?? 0, totalTests, reported buckets)` —
`totalTests` backstops legacy runs (null column) and a mixed-version fleet
whose opener predates shard-aware opens (its slice is missing from the map, so
the sum undercounts); the buckets floor guards over-reporting. The
`OutcomeBar` gets this as its `total` override, so the un-filled `bg-3` track
_is_ the pending fraction; a muted `{pending} pending` count renders in the
mono counts row when > 0.

## Behavior notes

- Non-sharded runs: exact `0 … /N` with an empty bar from `onBegin`.
- Sharded runs: the denominator starts at the opening shard's slice and jumps
  to the exact suite total as each shard's open lands (shards open near-
  simultaneously in CI); pending counts down from there.
- Interrupted/early-terminated runs keep showing the never-ran remainder as
  `pending` — deliberate: it surfaces that part of the suite never ran.
- No reporter changes: it already sent `shard {index,total}` +
  `expectedTotalTests` on every shard's open.

## Verification

- `pnpm check` — 0 errors.
- `pnpm test` — dashboard 105 files / 1205 tests, reporter 268 — all pass.
- Coverage map for the feature:
  - `run-outcome-totals.workers.test.ts` — the Outcome column's
    denominator/pending math (`runOutcomeTotals`, extracted from
    `<RunListRow>`): declared-size denominator, pending countdown → 0, legacy
    `totalTests` fallback, mixed-version backstop, over-report floor.
  - `build-run-insert-values.workers.test.ts` — the opener's
    `expectedTotalTests` derivation + `shardExpectedTests` map seed (and the
    non-sharded null).
  - `pg-integration.test.ts` ("sharded expected-total merge") — executes the
    EXACT production `jsonb_set` + `jsonb_each_text` re-sum UPDATE
    (`applyShardExpectedTests`, exported for this) against the real schema:
    shards 2 and 3 merge to the exact sum, a retried shard REPLACES its count
    and LOWERS the total, a legacy opener's null map coalesces (and
    `expectedShards` backfills), and a foreign tenant scope can't touch the
    row. pglite locally; real node-postgres under `PG_TEST_URL` in CI —
    closing the raw-jsonb-SQL dialect gap in an automated lane (initially
    verified by hand against the `wrightful-pg` Postgres 16 container).
  - `ingest-pipeline.workers.test.ts` — a sharded duplicate open runs NO
    transaction (single pooled UPDATE), still no prefill, no broadcast; the
    fresh-open broadcast summary carries `expectedTotalTests`.
  - Reducer/live lanes (`project-feed`, `run-progress-reducer`,
    `use-room-reseed`, `events-schema`, `ws-rooms`) — summaries carry and
    overlay the field.
  - **E2E** (`packages/e2e/src/e2e.test.ts`, "Sharded ingest") — the full
    sharded lifecycle over raw HTTP against the booted dashboard, exactly as
    N reporter processes would drive it: one idempotencyKey, per-shard
    opens (out of order — shard 2 wins the open race), results with
    `shardIndex`, per-shard completes. Pins: all shards land on ONE run;
    `expectedTotalTests` reads 2 mid-open and exactly 6 once all shards have
    opened (via `GET /api/v1/runs/:runId`); the run stays `running` after 2
    of 3 completes and flips to the worst status (`failed`) only on the last;
    final totals 6/5 passed/1 failed with nothing pending. Ran green against
    the local `wrightful_e2e` Postgres (3 passed, 29-total suite green).
