import { loggedScheduled } from "@/lib/cron-logging";
import { env } from "void/env";
import { logger } from "void/log";
import { createSweepBudget, sweepRetention } from "@/lib/retention";

/**
 * Two-axis data-retention sweep: every 6 hours, delete artifacts (R2 objects +
 * rows) and testResults rows that have aged past their team's retention
 * windows. See `sweepRetention` (`@/lib/retention`) for the bounded per-project
 * policy and the orphan-free R2 cleanup.
 *
 * Distinct cron expression (every 6 hours) so it never collides with the
 * five-minute reaper family or the daily usage rollup — Void dispatches crons
 * via `switch(controller.cron)`, so two files must never share an expression.
 * Retention is not latency-sensitive; a low frequency keeps the budget-bounded
 * backlog draining without competing with the hot reapers.
 */
export const cron = "0 */6 * * *";

export default loggedScheduled("sweep-retention", async () => {
  const now = Math.floor(Date.now() / 1000);
  // Drain until the invocation's wall-clock / chunk-count budget is spent, not a
  // fixed row cap — so a busy tenant's backlog keeps pace with ingest. The
  // deadline is anchored to real wall-clock (ms); `now` (seconds) is the logical
  // clock for the retention cutoffs.
  const budget = createSweepBudget({
    deadlineAtMs: Date.now() + env.WRIGHTFUL_RETENTION_SWEEP_BUDGET_MS,
    maxChunks: env.WRIGHTFUL_RETENTION_SWEEP_MAX_CHUNKS,
  });
  const result = await sweepRetention({
    now,
    chunkSize: env.WRIGHTFUL_RETENTION_SWEEP_BATCH_SIZE,
    defaults: {
      artifactDays: env.WRIGHTFUL_RETENTION_ARTIFACT_DAYS,
      testResultDays: env.WRIGHTFUL_RETENTION_TEST_RESULTS_DAYS,
    },
    budget,
  });

  if (result.artifactsDeleted > 0 || result.testResultsDeleted > 0) {
    logger.info("retention sweep", {
      artifactsDeleted: result.artifactsDeleted,
      artifactObjectsDeleted: result.artifactObjectsDeleted,
      testResultsDeleted: result.testResultsDeleted,
    });
  }
});
