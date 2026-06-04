import { defineScheduled } from "void";
import { env } from "void/env";
import { logger } from "void/log";
import { sweepStaleRuns } from "@/lib/ingest";

/**
 * Watchdog: every 5 minutes, finalize runs that have had no ingest write for
 * longer than `WRIGHTFUL_RUN_STALE_MINUTES` (e.g. the CI job was SIGKILL'd and
 * never called /complete).
 *
 * "Stuck" is defined by `staleRunFilter` (`@/lib/scope`) off `runs.lastActivityAt`
 * — the liveness timestamp bumped on every /results, /complete, and open write
 * — NOT `createdAt`. A legitimately long suite that is still streaming results
 * keeps advancing its `lastActivityAt`, so it no longer gets force-flipped to
 * 'interrupted' just for crossing a wall-clock window since open.
 *
 * The whole select-bounded-slice → finalize-with-bounded-concurrency → tally
 * policy lives behind `sweepStaleRuns` (`@/lib/ingest`); this cron is a thin
 * adapter that maps env config in and logs the tally out. The `.limit` inside
 * `sweepStaleRuns` is the load-bearing budget: it caps the per-invocation drain
 * so a mass-stranding event (thousands of runs stuck at status='running') can't
 * make the watchdog self-DoS — each pass makes guaranteed forward progress and
 * the backlog drains incrementally across successive invocations.
 *
 * Each stale run is finalized through `finalizeStaleRun`, which shares the
 * `reconcileAndBroadcast` tail with `completeRun` (recompute aggregates from the
 * testResults rows actually present, then broadcast the terminal summary) rather
 * than doing a blanket status UPDATE. That matters because a SIGKILL'd run is
 * exactly the case where the incremental aggregate deltas are most likely to
 * have drifted: we recompute counts from the testResults rows actually present
 * and emit a terminal live event so any dashboard viewer stops spinning on
 * "running".
 */
export const cron = "*/5 * * * *";

export default defineScheduled(async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff = nowSeconds - env.WRIGHTFUL_RUN_STALE_MINUTES * 60;

  const { found, finalized, failed } = await sweepStaleRuns({
    cutoffSeconds: cutoff,
    limit: env.WRIGHTFUL_SWEEP_BATCH_SIZE,
    now: nowSeconds,
  });

  if (found > 0) {
    logger.info("swept stuck runs", { found, finalized, failed });
  }
});
