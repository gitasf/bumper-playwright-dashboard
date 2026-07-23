import { ulid } from "ulid";
import { and, asc, db, eq, inArray, lte, sql } from "void/db";
import { logger } from "void/log";
import { monitorExecutions, monitors } from "@schema";
import type { Monitor } from "@schema";
import type { MonitorJob } from "@/lib/monitors/types";

/**
 * The monitor scheduler — the synthetic-monitoring twin of the stuck-run
 * watchdog (`sweepStaleRuns` / `drainStaleRuns` in `@/lib/ingest`). A 1-minute
 * cron calls `sweepDueMonitors`, which selects a bounded slice of due monitors,
 * plans the executions + monitor re-arm transactionally, persists them in ONE
 * D1 batch, then enqueues a job per execution with bounded concurrency.
 *
 * The split mirrors `drainStaleRuns`'s PURE-orchestrator discipline: the
 * decision of WHAT to do — which execution rows to write, how to re-arm each
 * monitor's `nextRunAt`, what job bodies to enqueue — is `planMonitorSweep`, a
 * pure function with NO `void/db` import that is fully unit-testable with an
 * injected `makeId`. The IO — the SELECT with its `.limit` budget, the batch
 * write, and the enqueue loop — is `sweepDueMonitors`, integration-covered.
 */

/**
 * The slice of a `Monitor` row the sweep reads (`planMonitorSweep` uses
 * id/projectId/intervalSeconds/nextRunAt; `enqueue` routes by `type`).
 * Projecting exactly these in the sweep SELECT avoids pulling `source` (the
 * full Playwright spec) and the jsonb config columns every cron minute — the
 * queue consumer re-loads the full row via `loadMonitorById`.
 */
export type DueMonitor = Pick<
  Monitor,
  "id" | "projectId" | "type" | "intervalSeconds" | "nextRunAt"
>;

/**
 * The transactional plan for one sweep pass: the execution rows to INSERT, the
 * per-monitor `nextRunAt`/`lastEnqueuedAt` re-arm UPDATEs, and the queue jobs to
 * send. `executions` and `jobs` are 1:1 and index-aligned (job N enqueues
 * execution N). Separating the plan from its persistence is what lets the
 * scheduling decision be unit-tested without a database.
 */
export interface SweepPlan {
  executions: Array<{
    id: string;
    projectId: string;
    monitorId: string;
    scheduledFor: number;
  }>;
  monitorUpdates: Array<{
    id: string;
    nextRunAt: number;
    lastEnqueuedAt: number;
  }>;
  jobs: MonitorJob[];
}

/**
 * Plan a sweep of the given due monitors — PURE, no `void/db`, no `Date.now` /
 * `Math.random` (ids come from the injected `makeId`, time from `now`), so it is
 * deterministic and unit-testable.
 *
 * For each due monitor it mints one queued execution, re-arms the monitor's
 * `nextRunAt = now + intervalSeconds` (so the NEXT tick is one interval out from
 * THIS sweep, not from when the execution finishes — fixed cadence, no drift),
 * stamps `lastEnqueuedAt = now`, and builds the tiny IDs-only job body. The
 * `nextRunAt` advance lands in the same D1 batch as the execution insert (see
 * `sweepDueMonitors`) BEFORE the enqueue, so a double cron tick selecting the
 * same monitor twice can't double-fire it — the second tick finds `nextRunAt`
 * already pushed past `now`. Each execution's `scheduledFor` is the monitor's
 * pre-advance due time (`nextRunAt ?? now`), the tick this job represents.
 *
 * An empty input yields an empty plan (no executions, no updates, no jobs).
 */
export function planMonitorSweep(
  dueMonitors: DueMonitor[],
  now: number,
  makeId: () => string,
): SweepPlan {
  const plan: SweepPlan = { executions: [], monitorUpdates: [], jobs: [] };
  for (const monitor of dueMonitors) {
    const executionId = makeId();
    const scheduledFor = monitor.nextRunAt ?? now;
    plan.executions.push({
      id: executionId,
      projectId: monitor.projectId,
      monitorId: monitor.id,
      scheduledFor,
    });
    plan.monitorUpdates.push({
      id: monitor.id,
      nextRunAt: now + monitor.intervalSeconds,
      lastEnqueuedAt: now,
    });
    plan.jobs.push({
      monitorId: monitor.id,
      executionId,
      scheduledFor,
    });
  }
  return plan;
}

/**
 * The sweep SELECT's WHERE — exported pure (no `db`, just operators over the
 * schema tables) so the overlap-suppression predicate is unit-testable.
 *
 * A monitor is due when it is enabled, `nextRunAt` has passed, AND it has no
 * execution still in flight (`queued`/`running`). Without the NOT EXISTS, a
 * monitor whose checks run longer than its interval (60s interval, 300s check)
 * stacks one new container per tick forever, starving other tenants of the
 * shared `maxInstances` budget. Skipped monitors deliberately do NOT advance
 * `nextRunAt`: the past-due value keeps them due, so the tick after the
 * in-flight execution settles picks them straight back up (then re-arms
 * `nextRunAt` as usual). No monitor can starve permanently — the stale-execution
 * reaper (`sweepStaleExecutions`) bounds how long any execution can sit
 * non-terminal, which bounds how long the NOT EXISTS can suppress.
 */
export function dueMonitorsWhere(now: number) {
  return and(
    eq(monitors.enabled, 1),
    lte(monitors.nextRunAt, now),
    sql`not exists (select 1 from ${monitorExecutions} where ${monitorExecutions.monitorId} = ${monitors.id} and ${monitorExecutions.state} in ('queued', 'running'))`,
  );
}

/** Compare-and-swap predicate used to claim a due monitor for re-arming. */
export function monitorReArmCasWhere(monitorId: string, now: number) {
  return and(
    eq(monitors.id, monitorId),
    eq(monitors.enabled, 1),
    lte(monitors.nextRunAt, now),
  );
}

/** Collect monitor ids returned by successful re-arm claims. */
export function claimedMonitorIds(
  updateResults: readonly unknown[],
): Set<string> {
  const ids = new Set<string>();
  for (const rows of updateResults) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const candidate: unknown = row;
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        !("id" in candidate)
      ) {
        continue;
      }
      const id = candidate.id;
      if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}

/**
 * Max jobs enqueued concurrently per `allSettled` wave — the enqueue-side twin
 * of `STALE_RUN_FINALIZE_CONCURRENCY`. Each `enqueue` is one queue-send
 * subrequest; bounding in-flight sends keeps a large due slice from opening the
 * whole batch's worth of RPC connections at once while staying parallel enough
 * to keep the cron's wall-time down.
 */
const MONITOR_ENQUEUE_CONCURRENCY = 10;

/** Claim due monitors, create executions, and enqueue jobs in bounded waves. */
export async function sweepDueMonitors(opts: {
  now: number;
  limit: number;
  /**
   * Enqueue one job, given its due-monitor slice so the caller can route by
   * `monitor.type` (http → `queues.uptime`, browser → `queues.monitors`). The
   * job body itself stays IDs-only.
   */
  enqueue: (job: MonitorJob, monitor: DueMonitor) => Promise<void>;
}): Promise<{ found: number; enqueued: number }> {
  const due = await db
    .select({
      id: monitors.id,
      projectId: monitors.projectId,
      type: monitors.type,
      intervalSeconds: monitors.intervalSeconds,
      nextRunAt: monitors.nextRunAt,
    })
    .from(monitors)
    .where(dueMonitorsWhere(opts.now))
    .orderBy(asc(monitors.nextRunAt))
    .limit(opts.limit);

  if (due.length === 0) return { found: 0, enqueued: 0 };

  const plan = planMonitorSweep(due, opts.now, ulid);
  const nowSeconds = opts.now;

  const items = await db.transaction(async (tx) => {
    const claimed: Array<{
      job: MonitorJob;
      execution: SweepPlan["executions"][number];
      monitor: DueMonitor;
    }> = [];
    for (let i = 0; i < plan.monitorUpdates.length; i++) {
      const update = plan.monitorUpdates[i]!;
      const claimRows = await tx
        .update(monitors)
        .set({
          nextRunAt: update.nextRunAt,
          lastEnqueuedAt: update.lastEnqueuedAt,
        })
        .where(monitorReArmCasWhere(update.id, nowSeconds))
        .returning({ id: monitors.id });
      if (!claimRows[0]) continue;

      const execution = plan.executions[i]!;
      await tx.insert(monitorExecutions).values({
        id: execution.id,
        projectId: execution.projectId,
        monitorId: execution.monitorId,
        scheduledFor: execution.scheduledFor,
        state: "queued",
        attempt: 0,
        createdAt: nowSeconds,
      });
      claimed.push({ job: plan.jobs[i]!, execution, monitor: due[i]! });
    }
    return claimed;
  });

  if (items.length === 0) return { found: due.length, enqueued: 0 };

  let enqueued = 0;
  const failedExecutionIds: string[] = [];
  for (let i = 0; i < items.length; i += MONITOR_ENQUEUE_CONCURRENCY) {
    const wave = items.slice(i, i + MONITOR_ENQUEUE_CONCURRENCY);
    const settled = await Promise.allSettled(
      wave.map((item) => opts.enqueue(item.job, item.monitor)),
    );
    settled.forEach((result, j) => {
      if (result.status === "fulfilled") enqueued++;
      else {
        const item = wave[j]!;
        logger.error("monitor enqueue failed", {
          executionId: item.execution.id,
          monitorId: item.monitor.id,
          reason:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
        failedExecutionIds.push(item.execution.id);
      }
    });
  }

  // Do not leave failed sends in `queued`, where they suppress future checks.
  if (failedExecutionIds.length > 0) {
    await db
      .update(monitorExecutions)
      .set({
        state: "error",
        completedAt: nowSeconds,
        errorMessage: "monitor enqueue failed",
      })
      .where(
        and(
          inArray(monitorExecutions.id, failedExecutionIds),
          eq(monitorExecutions.state, "queued"),
        ),
      );
  }

  return { found: due.length, enqueued };
}
