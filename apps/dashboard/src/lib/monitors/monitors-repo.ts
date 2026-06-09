import { ulid } from "ulid";
import { and, asc, db, desc, eq, inArray, lt, sql } from "void/db";
import { monitorExecutions, monitors } from "@schema";
import type { Monitor, MonitorExecution } from "@schema";
import { runBatch } from "@/lib/db-batch";
import type { TenantScope } from "@/lib/scope";
import type {
  CreateMonitorInput,
  UpdateMonitorInput,
} from "@/lib/monitors/monitor-schemas";
import type { ExecutionResult } from "@/lib/monitors/types";

/**
 * The D1 data layer for synthetic monitoring — the deep module the page actions
 * (user-facing) and the queue consumer (system-internal) both speak to. Every
 * write carries `projectId` (and `teamId` where the table has it) for the same
 * logical tenant isolation the `runs` pipeline uses; there is no DO boundary, so
 * scoping each query by the branded `TenantScope` ids is what keeps a monitor
 * row from ever leaking across projects.
 *
 * Two access tiers live here deliberately:
 *   - User-facing functions take a branded `TenantScope` (`@/lib/scope`) so the
 *     UI cannot read or mutate another tenant's monitors — the brand makes a
 *     raw projectId un-passable, mirroring `runByIdWhere`.
 *   - System-internal functions (`loadMonitorById` / `loadExecutionById` /
 *     `claimExecution` / `recordExecutionResult`) operate on TRUSTED rows
 *     the queue consumer already pulled by id, scoping their writes by the row's
 *     OWN `projectId` — the same pattern `finalizeStaleRun` uses for a row that
 *     never crossed a user request. No `Authorized*` brand is required because
 *     the id originated from a previously-scoped DB row, not user input.
 *
 * Timestamps are epoch SECONDS (`Math.floor(Date.now()/1000)`) to match `runs`
 * and the cron's `nextRunAt` seek key. Ids are ULIDs (`import { ulid }`), like
 * every other primary key in the schema.
 */

/** Columns a `Monitor` row exposes — `monitors.$inferSelect` projected back. */
const MONITOR_COLUMNS = {
  id: monitors.id,
  teamId: monitors.teamId,
  projectId: monitors.projectId,
  name: monitors.name,
  type: monitors.type,
  enabled: monitors.enabled,
  source: monitors.source,
  config: monitors.config,
  intervalSeconds: monitors.intervalSeconds,
  schedulingStrategy: monitors.schedulingStrategy,
  retryConfig: monitors.retryConfig,
  nextRunAt: monitors.nextRunAt,
  lastEnqueuedAt: monitors.lastEnqueuedAt,
  lastRunAt: monitors.lastRunAt,
  lastStatus: monitors.lastStatus,
  createdBy: monitors.createdBy,
  createdAt: monitors.createdAt,
  updatedAt: monitors.updatedAt,
} as const;

/**
 * The blessed single-monitor predicate within a tenant: `(projectId, id)`. Like
 * `runByIdWhere`, scopes by `projectId` alone — `monitors.id` is a globally
 * unique ULID, so the project filter is sufficient isolation and matches the
 * `monitors_project_created_at_idx` access path. Brand load-bearing: requires a
 * `TenantScope`, so the id is always auth-checked.
 */
function monitorByIdWhere(scope: TenantScope, monitorId: string) {
  return and(
    eq(monitors.projectId, scope.projectId),
    eq(monitors.id, monitorId),
  );
}

// ─── User-facing (branded TenantScope) ──────────────────────────────────────

/**
 * Create a monitor and arm its schedule. `nextRunAt` is set to `now +
 * intervalSeconds` when `enabled`, else `null` — a paused monitor keeps its row
 * but is invisible to the sweep's `enabled = 1 AND nextRunAt <= now` SELECT.
 * `lastEnqueuedAt`/`lastRunAt`/`lastStatus` are null until the first execution.
 * The `(projectId, name)` unique index rejects a duplicate name with a D1
 * constraint error the caller maps to a form error.
 */
export async function createMonitor(
  scope: TenantScope,
  input: CreateMonitorInput,
  createdBy: string,
  now: number,
): Promise<Monitor> {
  const id = ulid();
  const row = {
    id,
    teamId: scope.teamId,
    projectId: scope.projectId,
    name: input.name,
    type: input.type,
    enabled: input.enabled ? 1 : 0,
    source: input.source,
    config: null,
    intervalSeconds: input.intervalSeconds,
    schedulingStrategy: "round_robin",
    retryConfig: null,
    nextRunAt: input.enabled ? now + input.intervalSeconds : null,
    lastEnqueuedAt: null,
    lastRunAt: null,
    lastStatus: null,
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(monitors).values(row);
  return row as Monitor;
}

/** All monitors in the project, newest first (matches the list page order). */
export function listMonitors(scope: TenantScope): Promise<Monitor[]> {
  return db
    .select(MONITOR_COLUMNS)
    .from(monitors)
    .where(eq(monitors.projectId, scope.projectId))
    .orderBy(desc(monitors.createdAt));
}

/** A single monitor by id within the tenant, or null if it doesn't exist. */
export async function getMonitor(
  scope: TenantScope,
  monitorId: string,
): Promise<Monitor | null> {
  const rows = await db
    .select(MONITOR_COLUMNS)
    .from(monitors)
    .where(monitorByIdWhere(scope, monitorId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Apply a partial edit. Re-arms `nextRunAt` so a config change can't strand a
 * monitor on a stale schedule:
 *   - toggling `enabled` true (re)arms `now + intervalSeconds`; false clears it;
 *   - changing only `intervalSeconds` on an enabled monitor re-bases the next
 *     tick off `now` so the new cadence takes effect immediately;
 *   - an edit that touches neither leaves `nextRunAt` as-is.
 *
 * Returns the updated row, or null when the id resolves to no row in scope (so
 * the caller maps a missing monitor to 404 without leaking existence).
 */
export async function updateMonitor(
  scope: TenantScope,
  monitorId: string,
  patch: UpdateMonitorInput,
  now: number,
): Promise<Monitor | null> {
  const current = await getMonitor(scope, monitorId);
  if (!current) return null;

  const set: Partial<typeof monitors.$inferInsert> = { updatedAt: now };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.type !== undefined) set.type = patch.type;
  if (patch.source !== undefined) set.source = patch.source;
  if (patch.intervalSeconds !== undefined) {
    set.intervalSeconds = patch.intervalSeconds;
  }
  if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;

  // Resolve the post-patch enabled/interval to re-derive the schedule, falling
  // back to the current row for fields the patch doesn't touch.
  const willBeEnabled = patch.enabled ?? current.enabled === 1;
  const interval = patch.intervalSeconds ?? current.intervalSeconds;
  if (!willBeEnabled) {
    set.nextRunAt = null;
  } else if (patch.enabled === true || patch.intervalSeconds !== undefined) {
    set.nextRunAt = now + interval;
  }

  await db.update(monitors).set(set).where(monitorByIdWhere(scope, monitorId));
  return getMonitor(scope, monitorId);
}

/**
 * Delete a monitor. The `monitorExecutions.monitorId` FK cascades the execution
 * history; produced `runs` are retained with a now-dangling `monitorId` (the
 * schema comment documents this — readers treat a missing monitor gracefully).
 */
export async function deleteMonitor(
  scope: TenantScope,
  monitorId: string,
): Promise<void> {
  await db.delete(monitors).where(monitorByIdWhere(scope, monitorId));
}

/**
 * Pause / resume a monitor without touching its other config. Enabling re-arms
 * `nextRunAt = now + intervalSeconds`; disabling clears it so the sweep skips
 * the row. The one-statement form keeps the quick pause/resume toggle off the
 * read-modify-write path `updateMonitor` takes.
 */
export async function setMonitorEnabled(
  scope: TenantScope,
  monitorId: string,
  enabled: boolean,
  now: number,
): Promise<void> {
  await db
    .update(monitors)
    .set({
      enabled: enabled ? 1 : 0,
      nextRunAt: enabled ? sql`${now} + ${monitors.intervalSeconds}` : null,
      updatedAt: now,
    })
    .where(monitorByIdWhere(scope, monitorId));
}

/** Count of monitors in the project — for the per-project cap enforcement. */
export async function countMonitors(scope: TenantScope): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(monitors)
    .where(eq(monitors.projectId, scope.projectId));
  return rows[0]?.count ?? 0;
}

/**
 * Recent executions for a monitor, newest first. Scoped by BOTH `projectId`
 * (tenant isolation) and `monitorId` (the lookup), matching the
 * `monitorExecutions_monitor_created_at_idx` access path.
 */
export function listExecutions(
  scope: TenantScope,
  monitorId: string,
  limit: number,
): Promise<MonitorExecution[]> {
  return db
    .select()
    .from(monitorExecutions)
    .where(
      and(
        eq(monitorExecutions.projectId, scope.projectId),
        eq(monitorExecutions.monitorId, monitorId),
      ),
    )
    .orderBy(desc(monitorExecutions.createdAt))
    .limit(limit);
}

/**
 * Recent executions for MANY monitors at once, keyed by monitorId — feeds the
 * list page's per-row history sparkline (`ExecStrip`) + uptime without an N+1 in
 * the page. One bounded query per monitor, run concurrently: the per-project
 * monitor cap (`WRIGHTFUL_MONITOR_MAX_PER_PROJECT`) keeps the fan-out small, and
 * each query rides the same `(projectId, monitorId, createdAt)` index
 * `listExecutions` uses. Returns an empty array for a monitor with no executions.
 */
export async function listRecentExecutionsByMonitor(
  scope: TenantScope,
  monitorIds: string[],
  perMonitor: number,
): Promise<Map<string, MonitorExecution[]>> {
  const entries = await Promise.all(
    monitorIds.map(
      async (id) => [id, await listExecutions(scope, id, perMonitor)] as const,
    ),
  );
  return new Map(entries);
}

/** A single execution by id within the tenant, or null. */
export async function getExecution(
  scope: TenantScope,
  executionId: string,
): Promise<MonitorExecution | null> {
  const rows = await db
    .select()
    .from(monitorExecutions)
    .where(
      and(
        eq(monitorExecutions.projectId, scope.projectId),
        eq(monitorExecutions.id, executionId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ─── System-internal (queue consumer; trusted rows) ─────────────────────────
//
// These load + mutate by id WITHOUT a TenantScope: the queue consumer's job
// body carries ids the sweep already wrote under a scoped insert, so the row is
// trusted. Writes are still scoped by the row's OWN `projectId` (defense in
// depth + the indexed access path) — the same pattern `finalizeStaleRun` uses.

/** Load a monitor by id, unscoped — for the queue consumer. Null if deleted. */
export async function loadMonitorById(
  monitorId: string,
): Promise<Monitor | null> {
  const rows = await db
    .select(MONITOR_COLUMNS)
    .from(monitors)
    .where(eq(monitors.id, monitorId))
    .limit(1);
  return rows[0] ?? null;
}

/** Load an execution by id, unscoped — for the queue consumer. Null if gone. */
export async function loadExecutionById(
  executionId: string,
): Promise<MonitorExecution | null> {
  const rows = await db
    .select()
    .from(monitorExecutions)
    .where(eq(monitorExecutions.id, executionId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * CLAIM an execution for this delivery: atomically flip it to `running` + stamp
 * `startedAt`, returning whether THIS caller won the claim. The
 * `state IN ('queued','error')` guard is the at-least-once-delivery defense —
 * Cloudflare Queues can hand the same `MonitorJob` to two consumer invocations
 * concurrently, and only one may launch the container; the losing claim is
 * ack'd without running (see `runMonitorJob`). It also makes a TERMINAL-SUCCESS
 * row immutable: a spurious redelivery of a `pass`/`fail`/`degraded` execution
 * finds it outside the set, claims nothing, and never re-runs or overwrites it
 * (no double-bill, no clobbered result). A legit infra-retry re-claims from
 * `error` — the one terminal state we re-enter on purpose. Scoped by the row's
 * own `(projectId, id)`; `.returning()` reports whether a row was claimed.
 */
export async function claimExecution(
  execution: MonitorExecution,
  now: number,
): Promise<boolean> {
  const claimed = await db
    .update(monitorExecutions)
    .set({ state: "running", startedAt: now })
    .where(
      and(
        eq(monitorExecutions.projectId, execution.projectId),
        eq(monitorExecutions.id, execution.id),
        inArray(monitorExecutions.state, ["queued", "error"]),
      ),
    )
    .returning({ id: monitorExecutions.id });
  return claimed.length > 0;
}

/**
 * Record an execution's terminal outcome AND bump the parent monitor's
 * `lastStatus` / `lastRunAt`, in one atomic D1 batch (both writes land or
 * neither does). The execution row takes the result's `state`, `runId`,
 * `durationMs`, `errorMessage`, and `completedAt = now`; the monitor's
 * denormalized "last result" columns mirror it so the list page can render the
 * latest status without a per-row join into executions.
 *
 * Both UPDATEs are scoped by the execution's own `projectId` (and the monitor's
 * id, taken from the trusted execution row). The monitor write is guarded only
 * by id — a concurrent newer execution recording after this one is acceptable
 * (last-write-wins on `lastStatus` is exactly the desired semantics for "the
 * most recent result").
 */
export async function recordExecutionResult(
  execution: MonitorExecution,
  result: ExecutionResult,
  now: number,
): Promise<void> {
  await runBatch([
    db
      .update(monitorExecutions)
      .set({
        state: result.state,
        runId: result.runId,
        durationMs: result.durationMs,
        errorMessage: result.errorMessage,
        completedAt: now,
      })
      .where(
        and(
          eq(monitorExecutions.projectId, execution.projectId),
          eq(monitorExecutions.id, execution.id),
        ),
      ),
    db
      .update(monitors)
      .set({ lastStatus: result.state, lastRunAt: now, updatedAt: now })
      .where(
        and(
          eq(monitors.projectId, execution.projectId),
          eq(monitors.id, execution.monitorId),
        ),
      ),
  ]);
}

/**
 * Reaper for stuck executions — the synthetic-monitoring twin of `sweepStaleRuns`
 * (`@/lib/ingest`). An execution can strand non-terminal two ways: at `queued`
 * (the sweep's enqueue send failed — `sweepDueMonitors` tolerates that via
 * `allSettled`), or at `running` (the consumer claimed it, then the Worker was
 * evicted / CPU-killed before `recordExecutionResult`). Nothing else finalizes
 * these, and `monitorExecutions` is append-only (one row per tick), so they leak
 * forever, grow the table, and skew uptime (which excludes `running`/`error`
 * from its denominator). This flips any execution still non-terminal past the
 * stale window to a terminal `error`, in a bounded `.limit` slice oldest-first —
 * the same load-bearing budget `sweepStaleRuns` uses so a mass-stranding event
 * can't make the cron self-DoS; the backlog drains across ticks.
 *
 * The per-row UPDATE is guarded on `state IN ('queued','running')` so it can't
 * clobber an execution that reached a terminal state between the SELECT and the
 * write (a real result racing the sweep). The cutoff must comfortably exceed a
 * full retry lifecycle (maxRetries × MAX_DURATION + queue dwell) so a
 * legitimately slow/retrying execution is never reaped mid-flight. The monitor's
 * denormalized `lastStatus` is deliberately left untouched: a reaped execution
 * still shows as `error` in the timeline + `ExecStrip`, while the monitor badge
 * stays owned by real recorded executions (so a late straggler can't regress a
 * healthy badge — the cross-execution last-write-wins window noted in the repo
 * docstring).
 */
export async function sweepStaleExecutions(opts: {
  cutoffSeconds: number;
  limit: number;
  now: number;
}): Promise<{ found: number; reaped: number }> {
  const stale = await db
    .select({
      id: monitorExecutions.id,
      projectId: monitorExecutions.projectId,
    })
    .from(monitorExecutions)
    .where(
      and(
        inArray(monitorExecutions.state, ["queued", "running"]),
        lt(monitorExecutions.createdAt, opts.cutoffSeconds),
      ),
    )
    .orderBy(asc(monitorExecutions.createdAt))
    .limit(opts.limit);

  if (stale.length === 0) return { found: 0, reaped: 0 };

  const updated = await runBatch(
    stale.map((e) =>
      db
        .update(monitorExecutions)
        .set({
          state: "error",
          completedAt: opts.now,
          errorMessage: "execution did not complete within the stale window",
        })
        .where(
          and(
            eq(monitorExecutions.projectId, e.projectId),
            eq(monitorExecutions.id, e.id),
            inArray(monitorExecutions.state, ["queued", "running"]),
          ),
        )
        .returning({ id: monitorExecutions.id }),
    ),
  );

  // `reaped` counts rows the guarded UPDATEs ACTUALLY flipped — a row that
  // settled to a terminal state between the SELECT and its UPDATE matches the
  // guard zero times and is not counted, so the logged tally stays honest
  // against `found` (the pre-flight slice) instead of over-reporting it.
  const reaped = updated.reduce<number>(
    (n, rows) => n + (Array.isArray(rows) ? rows.length : 0),
    0,
  );
  return { found: stale.length, reaped };
}
