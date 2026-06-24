import { loggedScheduled } from "@/lib/cron-logging";
import { env } from "void/env";
import { logger } from "void/log";
import { sweepStaleSyntheticKeys } from "@/lib/monitors/synthetic-key";

/**
 * Backstop sweeper for orphaned synthetic-monitor ingest keys. The
 * `SandboxExecutor` revokes each per-run key in its `finally`, but that is
 * best-effort — a Worker evicted / CPU-killed mid-run skips it — and
 * `validateApiKey` enforces no time-based expiry, so an orphaned key would stay
 * a permanently-valid project-scoped Bearer credential. Every 5 minutes this
 * hard-deletes any `synthetic-monitor:*` key older than the execution-stale
 * window whose owning execution is no longer in flight.
 *
 * The cutoff reuses `WRIGHTFUL_MONITOR_EXECUTION_STALE_MINUTES` so the two
 * sweeps share one notion of "stale"; the in-flight guard itself is the NOT
 * EXISTS on the owning execution inside `sweepStaleSyntheticKeys` — age alone
 * races the execution lifecycle (a key minted late in the window can still be
 * live ingest auth when it crosses the cutoff). Thin adapter over
 * `sweepStaleSyntheticKeys` (`@/lib/monitors/synthetic-key`); the bounded
 * `.limit` keeps a mass-orphan event from blowing one tick's budget.
 */
// Offset from the other 5-minute reapers — `sweep-stuck-runs` (`*/5`) and
// `sweep-stuck-executions` (`2-59/5`). Void dispatches scheduled events via
// `switch (controller.cron)`, so a shared expression would shadow all but the
// first cron (by filename order). Distinct expressions keep each on its own
// case. This fires at :04,:09,:14,… — still every 5 minutes. Do NOT normalize
// back to `*/5`.
export const cron = "4-59/5 * * * *";

export default loggedScheduled("sweep-synthetic-keys", async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff =
    nowSeconds - env.WRIGHTFUL_MONITOR_EXECUTION_STALE_MINUTES * 60;

  const { deleted } = await sweepStaleSyntheticKeys({
    cutoffSeconds: cutoff,
    limit: env.WRIGHTFUL_MONITOR_SWEEP_BATCH_SIZE,
  });

  if (deleted > 0) {
    logger.info("swept orphaned synthetic keys", { deleted });
  }
});
