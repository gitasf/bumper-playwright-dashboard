import { defineScheduled } from "void";
import { env } from "void/env";
import { logger } from "void/log";
import { queues } from "void/queues";
import { sweepDueMonitors } from "@/lib/monitors/scheduler";

/**
 * Synthetic-monitor scheduler: every minute, find the enabled monitors whose
 * `nextRunAt` is due and enqueue one `MonitorJob` per due monitor onto the
 * `monitors` queue. The queue consumer (`queues/monitors.ts`) then executes
 * each one in a Void Sandbox (or the in-process stub in dev).
 *
 * Minute granularity is the floor Cloudflare cron offers and matches the
 * 60-second `WRIGHTFUL_MONITOR_MIN_INTERVAL_SECONDS` interval floor — a monitor
 * can fire at most once per tick.
 *
 * The whole select-due-slice → plan → persist-in-one-batch → enqueue policy
 * lives behind `sweepDueMonitors` (`@/lib/monitors/scheduler`), mirroring how
 * `sweep-stuck-runs.ts` delegates to `sweepStaleRuns`. This cron is a thin
 * adapter: it computes `now` (epoch seconds), maps env config in
 * (`WRIGHTFUL_MONITOR_SWEEP_BATCH_SIZE` is the per-tick `.limit` budget that
 * keeps a project with hundreds of armed monitors from blowing one tick's
 * subrequest budget — the backlog drains oldest-due-first across ticks), wires
 * the producer (`queues.monitors.send`) as the enqueue fn, and logs the tally.
 */
export const cron = "* * * * *";

export default defineScheduled(async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);

  const { found, enqueued } = await sweepDueMonitors({
    now: nowSeconds,
    limit: env.WRIGHTFUL_MONITOR_SWEEP_BATCH_SIZE,
    enqueue: async (job) => {
      await queues.monitors.send(job);
    },
  });

  if (found > 0) {
    logger.info("swept due monitors", { found, enqueued });
  }
});
