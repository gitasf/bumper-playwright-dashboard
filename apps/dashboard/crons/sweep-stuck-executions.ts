import { loggedScheduled } from "@/lib/cron-logging";
import { env } from "void/env";
import { logger } from "void/log";
import { sweepStaleExecutions } from "@/lib/monitors/monitors-repo";

/**
 * Reaper for stuck synthetic-monitor executions — the execution-level twin of
 * `sweep-stuck-runs.ts`. Every 5 minutes it finalizes any `monitorExecutions`
 * row still non-terminal (`queued` or `running`) past
 * `WRIGHTFUL_MONITOR_EXECUTION_STALE_MINUTES`, flipping it to a terminal
 * `error`.
 *
 * Why it's needed: an execution can strand at `queued` (the sweep's enqueue send
 * failed — `sweepDueMonitors` tolerates that) or at `running` (the consumer
 * claimed it, then the Worker was evicted before `recordExecutionResult`).
 * Nothing else finalizes these, and `monitorExecutions` is append-only, so they
 * leak forever, grow the table, and skew uptime (which excludes `running` /
 * `error` from its denominator).
 *
 * Thin adapter, like the other sweeps: it computes `now` (epoch seconds) + the
 * cutoff, maps the `.limit` budget in (`WRIGHTFUL_MONITOR_SWEEP_BATCH_SIZE`, so a
 * mass-stranding event drains across ticks rather than blowing one tick's
 * budget), and logs the tally. The select + bounded reap live behind
 * `sweepStaleExecutions` (`@/lib/monitors/monitors-repo`).
 */
// Offset from the other 5-minute reapers — `sweep-stuck-runs` (`*/5`) and
// `sweep-synthetic-keys` (`4-59/5`). Void dispatches scheduled events via
// `switch (controller.cron)` (one `case` per cron expression), so two crons
// sharing an expression COLLIDE — only the first by filename order ever runs,
// silently killing the rest. Distinct expressions keep each handler on its own
// case. This fires at :02,:07,:12,… — still every 5 minutes. Do NOT normalize
// back to `*/5`.
export const cron = "2-59/5 * * * *";

export default loggedScheduled("sweep-stuck-executions", async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff =
    nowSeconds - env.WRIGHTFUL_MONITOR_EXECUTION_STALE_MINUTES * 60;

  const { found, reaped } = await sweepStaleExecutions({
    cutoffSeconds: cutoff,
    limit: env.WRIGHTFUL_MONITOR_SWEEP_BATCH_SIZE,
    now: nowSeconds,
  });

  if (found > 0) {
    logger.info("reaped stuck monitor executions", { found, reaped });
  }
});
