import { loggedScheduled } from "@/lib/cron-logging";
import { logger } from "void/log";
import { reconcileUsage } from "@/lib/usage";

/**
 * Usage reconciliation: once a day, recompute every team's current-period
 * usage counters from the authoritative `runs` / `testResults` / `artifacts`
 * rows and overwrite the live meter.
 *
 * The live counters are incremented in-batch with each ingest write
 * (`usageBumpStatement`), which is exact for additions but can drift when rows
 * are removed inside the current window — chiefly the retention sweep deleting
 * artifacts/testResults. This pass re-bases the meter so `checkQuota` and the
 * usage page can't slowly diverge from reality. It only ever corrects DOWNWARD
 * for deletes (or upward if a bump was somehow lost); steady state is a no-op.
 *
 * Distinct cron expression (daily 03:00 UTC) so it never collides with the
 * five-minute reaper family — Void dispatches crons via `switch(controller.cron)`,
 * so two files must never share an expression. The whole recompute-per-team
 * policy lives behind `reconcileUsage`; this cron is a thin adapter that logs
 * the tally.
 */
export const cron = "0 3 * * *";

export default loggedScheduled("rollup-usage", async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { teamsReconciled } = await reconcileUsage(nowSeconds);
  logger.info("reconciled team usage", { teamsReconciled });
});
