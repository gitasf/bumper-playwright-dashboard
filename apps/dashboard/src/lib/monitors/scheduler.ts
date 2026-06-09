import { ulid } from "ulid";
import { and, asc, db, eq, lte } from "void/db";
import { monitorExecutions, monitors } from "@schema";
import type { Monitor } from "@schema";
import { runBatch } from "@/lib/db-batch";
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
  dueMonitors: Monitor[],
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
 * Max jobs enqueued concurrently per `allSettled` wave — the enqueue-side twin
 * of `STALE_RUN_FINALIZE_CONCURRENCY`. Each `enqueue` is one queue-send
 * subrequest; bounding in-flight sends keeps a large due slice from opening the
 * whole batch's worth of RPC connections at once while staying parallel enough
 * to keep the cron's wall-time down.
 */
const MONITOR_ENQUEUE_CONCURRENCY = 10;

/**
 * Sweep entry point: select up to `limit` enabled, due monitors, plan their
 * executions + re-arm, persist BOTH in one atomic D1 batch, then enqueue each
 * job with bounded concurrency. Returns `{ found, enqueued }`.
 *
 * The `.limit(limit)` is the load-bearing budget (matching `sweepStaleRuns`):
 * each 1-minute invocation drains a capped slice in `nextRunAt` order, so a
 * project that armed hundreds of monitors can't make a single cron tick blow
 * the Workers subrequest budget — the backlog drains across ticks, oldest-due
 * first.
 *
 * Ordering is deliberate: the execution-insert + `nextRunAt` advance go in ONE
 * `runBatch` (all-or-nothing) BEFORE any enqueue. So if the batch fails, nothing
 * was enqueued and the monitors stay due for the next tick; and once it
 * succeeds, the monitors' `nextRunAt` is already pushed forward, so a double
 * cron tick selecting an overlapping slice won't re-enqueue them. Enqueue
 * failures are tolerated per-job (`allSettled`): the execution row already
 * exists in `queued` state, so a dropped send leaves a visibly-stuck execution
 * the operator can see, rather than silently advancing `nextRunAt` with no work
 * done — but the monitor itself is re-armed and will fire again next interval.
 */
export async function sweepDueMonitors(opts: {
  now: number;
  limit: number;
  enqueue: (job: MonitorJob) => Promise<void>;
}): Promise<{ found: number; enqueued: number }> {
  const due = await db
    .select()
    .from(monitors)
    .where(and(eq(monitors.enabled, 1), lte(monitors.nextRunAt, opts.now)))
    .orderBy(asc(monitors.nextRunAt))
    .limit(opts.limit);

  if (due.length === 0) return { found: 0, enqueued: 0 };

  const plan = planMonitorSweep(due, opts.now, ulid);

  const nowSeconds = opts.now;
  const statements = [
    ...plan.executions.map((e) =>
      db.insert(monitorExecutions).values({
        id: e.id,
        projectId: e.projectId,
        monitorId: e.monitorId,
        scheduledFor: e.scheduledFor,
        state: "queued",
        attempt: 0,
        createdAt: nowSeconds,
      }),
    ),
    ...plan.monitorUpdates.map((u) =>
      db
        .update(monitors)
        .set({ nextRunAt: u.nextRunAt, lastEnqueuedAt: u.lastEnqueuedAt })
        .where(eq(monitors.id, u.id)),
    ),
  ];
  await runBatch(statements);

  // Enqueue with bounded concurrency, same wave policy as `drainStaleRuns`:
  // each `allSettled` wave holds at most `MONITOR_ENQUEUE_CONCURRENCY` sends in
  // flight, and a fresh wave only starts once the previous settles. A failed
  // send is tolerated (the execution row is already persisted as `queued`); we
  // count only the sends that landed.
  let enqueued = 0;
  for (let i = 0; i < plan.jobs.length; i += MONITOR_ENQUEUE_CONCURRENCY) {
    const wave = plan.jobs.slice(i, i + MONITOR_ENQUEUE_CONCURRENCY);
    const settled = await Promise.allSettled(
      wave.map((job) => opts.enqueue(job)),
    );
    for (const result of settled) {
      if (result.status === "fulfilled") enqueued++;
    }
  }

  return { found: due.length, enqueued };
}
