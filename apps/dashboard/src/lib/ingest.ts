/**
 * The streaming ingest pipeline's PUBLIC surface.
 *
 * Every write carries `teamId AND projectId` for logical tenant isolation, and
 * `runBatch` (a Postgres `db.transaction`) is the atomicity boundary. Realtime
 * broadcasts go through the `void/ws` rooms — the run room (`run:<runId>`) and
 * the project room (`project:<projectId>`) — via `@/realtime/publish` (ADR 0001).
 * See `docs/worklog/void-migration-consolidated.md` for the single-database
 * architecture decisions.
 *
 * The implementation is split by responsibility under `./ingest/`:
 *
 *   lifecycle.ts    open a run, its idempotency/quota/write-closure rules
 *   results.ts      append a batch of test results
 *   finalization.ts complete a run, merge shard status
 *   stale-runs.ts   the watchdog that finalizes abandoned runs
 *   write-and-publish.ts
 *                   shared statement builders + the commit-then-publish tail
 *
 * This file re-exports ONLY what callers outside the pipeline legitimately need
 * — deliberately NOT `export *`. The statement builders, the broadcast helpers
 * and the aggregate math are internal: they emit SQL that is only valid inside a
 * specific `runBatch`, or publish realtime events that must follow a committed
 * write. Widening this list re-opens the door to calling them from a route.
 * Tests that need an internal import the submodule directly, which keeps the
 * fact that they are testing internals visible at the import site.
 */
export {
  backdatingAllowed,
  openRun,
  RUN_WRITE_GUARD_COLUMNS,
  runClosedForWrites,
  RunQuotaOvershootError,
  RunRowCapExceededError,
} from "./ingest/lifecycle";
export { appendRunResults } from "./ingest/results";
export { completeRun } from "./ingest/finalization";
export { sweepStaleRuns } from "./ingest/stale-runs";
