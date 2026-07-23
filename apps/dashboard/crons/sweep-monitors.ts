import { loggedScheduled } from "@/lib/cron-logging";
import { env } from "void/env";
import { logger } from "void/log";
import { queues } from "void/queues";
import { sweepDueMonitors } from "@/lib/monitors/scheduler";
import { monitorFamily } from "@/lib/monitors/types";

/**
 * Synthetic-monitor scheduler: every minute, find the enabled monitors whose
 * `nextRunAt` is due and enqueue one `MonitorJob` per due monitor — ROUTED by
 * the monitor's type: the lightweight uptime family (`http`, plus `tcp`/`ping` —
 * a raw socket connect, batched) goes to the `uptime` queue; browser jobs to the
 * `monitors` queue (one Void Sandbox container per job). The job body is IDs-only
 * either way; the sweep already holds the monitor row, so the type-routing is
 * free.
 *
 * Minute granularity is the floor Cloudflare cron offers and matches the
 * 60-second floor of `MONITOR_INTERVAL_PRESETS` (the hardcoded allowed
 * intervals in `@/lib/monitors/monitor-schemas`) — a monitor can fire at most
 * once per tick.
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

export default loggedScheduled("sweep-monitors", async (controller) => {
  // Use the event's scheduled time rather than wall-clock time. This keeps a
  // delayed delivery tied to the tick it represents and lets authenticated
  // production-trigger tests advance one deterministic scheduler cycle.
  const nowSeconds = Math.floor(controller.scheduledTime / 1000);

  const { found, enqueued } = await sweepDueMonitors({
    now: nowSeconds,
    limit: env.WRIGHTFUL_MONITOR_SWEEP_BATCH_SIZE,
    // Route by family (`monitorFamily` — the shared partition the executor
    // registry also dispatches on): the lightweight uptime family (http +
    // tcp/ping) to the batched `uptime` queue, browser checks to the
    // container-tuned `monitors` queue.
    enqueue: async (job, monitor) => {
      if (monitorFamily(monitor.type) === "uptime") {
        await queues.uptime.send(job);
      } else {
        await queues.monitors.send(job);
      }
    },
  });

  if (found > 0) {
    logger.info("swept due monitors", { found, enqueued });
  }
});
