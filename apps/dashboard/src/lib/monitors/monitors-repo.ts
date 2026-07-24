import { ulid } from "ulid";
import { and, asc, db, desc, eq, inArray, lt, or, sql } from "void/db";
import { monitorExecutions, monitors } from "@schema";
import type { Monitor, MonitorExecution } from "@schema";
import { runBatch } from "@/lib/db/batch";
import { runRows } from "@/lib/runs/db";
import { numericSql } from "@/lib/db/sql-ops";
import { monitorBadgeUpdate } from "@/lib/monitors/executor";
import {
  childByIdWhere,
  childProjectScopeWhere,
  type TenantScope,
} from "@/lib/scope";
import type {
  CreateMonitorInput,
  UpdateMonitorInput,
} from "@/lib/monitors/monitor-schemas";
import type { ExecutionResult, MonitorType } from "@/lib/monitors/types";

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
  alertsEnabled: monitors.alertsEnabled,
  alertTargets: monitors.alertTargets,
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
 * The blessed single-monitor predicate within a tenant: `(projectId, id)`,
 * built from the shared {@link childByIdWhere} family — `monitors.id` is a
 * globally unique ULID, so (as for `runByIdWhere`) the project filter is
 * sufficient isolation and matches the `monitors_project_created_at_idx` access
 * path. Brand load-bearing: requires a `TenantScope`, so the id is always
 * auth-checked.
 */
function monitorByIdWhere(scope: TenantScope, monitorId: string) {
  return childByIdWhere(monitors, scope, monitorId);
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
    // Alerts on by default for a new monitor; muted later via the detail toggle.
    alertsEnabled: 1,
    // null = notify all team members (default); narrowed later via the picker.
    alertTargets: null,
    // `source` carries the browser spec; `config` the http URL/assertions JSON
    // or the tcp host/port JSON. Each type writes its own field, leaving the
    // others null.
    source: input.type === "browser" ? input.source : null,
    // jsonb column — store the config object directly (no JSON.stringify).
    config: input.type === "http" || input.type === "tcp" ? input.config : null,
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
    .where(childProjectScopeWhere(monitors.projectId, scope))
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
  // The caller (the edit action) already loaded the row for type dispatch; pass
  // it to skip a redundant SELECT. Omitted callers still get the lookup.
  loaded?: Monitor,
): Promise<Monitor | null> {
  const current = loaded ?? (await getMonitor(scope, monitorId));
  if (!current) return null;

  // `type` is intentionally NOT patchable — it's immutable after creation, so
  // the update schemas omit it and this never reassigns it.
  const set: Partial<typeof monitors.$inferInsert> = { updatedAt: now };
  if (patch.name !== undefined) set.name = patch.name;
  // `source` is browser-only, `config` is http/tcp — gate each by the stored
  // type so a stray cross-type field can't contaminate the row. The action's
  // per-type dispatch already prevents this; this is the repo-level backstop for
  // a direct or future caller (`UpdateMonitorInput` permits both fields).
  if (current.type === "browser" && patch.source !== undefined) {
    set.source = patch.source;
  }
  if (
    (current.type === "http" || current.type === "tcp") &&
    patch.config !== undefined
  ) {
    // jsonb column — store the config object directly (no JSON.stringify),
    // matching createMonitor. Double-encoding it as a JSON string would make the
    // read-path parser (`parseHttp/TcpMonitorConfig`, which now safeParses an
    // object) reject it as null, silently breaking the monitor.
    set.config = patch.config;
  }
  if (patch.intervalSeconds !== undefined) {
    set.intervalSeconds = patch.intervalSeconds;
  }
  if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;
  if (patch.alertTargets !== undefined) {
    // jsonb column — store the `{ users, groups }` object (or null) directly, no
    // JSON.stringify, matching `config` above. Written in the SAME update as the
    // config so the edit modal's config + recipients commit atomically.
    set.alertTargets = patch.alertTargets;
  }

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
 * history; produced `runs` are retained, their `monitorId` set to null by the
 * FK's `onDelete: "set null"` (readers treat a missing monitor link gracefully).
 * A run being opened concurrently with this delete is handled by `openRun`'s
 * FK-violation recovery (it nulls the stale link and retries), not by any guard
 * here.
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

/**
 * Enable / silence down+recovery email alerts for a monitor, without touching
 * its schedule or other config. Independent of `enabled` (a running monitor can
 * have alerts silenced). One-statement form, like {@link setMonitorEnabled}.
 */
export async function setMonitorAlertsEnabled(
  scope: TenantScope,
  monitorId: string,
  alertsEnabled: boolean,
  now: number,
): Promise<void> {
  await db
    .update(monitors)
    .set({ alertsEnabled: alertsEnabled ? 1 : 0, updatedAt: now })
    .where(monitorByIdWhere(scope, monitorId));
}

/**
 * Count of monitors in the project — for per-project cap enforcement. With a
 * `type`, counts only that kind: browser, http, and tcp have SEPARATE caps
 * (`WRIGHTFUL_MONITOR_MAX_PER_PROJECT` / `WRIGHTFUL_HTTP_MONITOR_MAX_PER_PROJECT`
 * / `WRIGHTFUL_TCP_MONITOR_MAX_PER_PROJECT`) because a container run, a plain
 * `fetch()`, and a raw socket `connect()` have very different costs, so a project
 * can hold many cheap uptime checks without eating its browser budget. Without a
 * `type` (the list header) it counts all monitors in the project.
 */
export async function countMonitors(
  scope: TenantScope,
  type?: MonitorType,
): Promise<number> {
  const rows = await db
    .select({ count: numericSql(sql`count(*)`) })
    .from(monitors)
    .where(
      type
        ? and(eq(monitors.projectId, scope.projectId), eq(monitors.type, type))
        : childProjectScopeWhere(monitors.projectId, scope),
    );
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
 * list page's per-row history sparkline (`ExecStrip`) + uptime without an N+1.
 *
 * One raw query instead of a per-monitor `Promise.all` fan-out: an inner query
 * ranks each monitor's executions by recency
 * (`row_number() over (partition by "monitorId" order by "createdAt" desc)`),
 * scoped by `projectId` (tenant isolation) and `"monitorId" in (...)`; the
 * outer query keeps `rn <= perMonitor`. Still rides the `(monitorId, createdAt)`
 * index the old per-monitor `listExecutions` used, walked once not N times. A
 * monitorId with zero rows gets no entry (not an empty array) — matching the
 * `.get(id) ?? []` read at the only call site.
 *
 * Raw-SQL caveats (bypasses Drizzle's field decoders, see `db/sql-ops.ts`):
 *   - `row_number()` is only filtered on, never selected, so its int8-as-string
 *     trap never reaches JS.
 *   - the bigint timestamp columns ARE selected, so each is
 *     `cast(... as double precision)` — node-postgres returns int8 as a string
 *     (pglite returns a number, hiding it); double precision (not `integer`)
 *     matches the insights loaders' `numAggExpr` and dodges the int4 2038
 *     overflow on epoch-seconds.
 *   - `resultDetail` (jsonb) needs no cast — both drivers pre-parse it.
 */
export async function listRecentExecutionsByMonitor(
  scope: TenantScope,
  monitorIds: string[],
  perMonitor: number,
): Promise<Map<string, MonitorExecution[]>> {
  const result = new Map<string, MonitorExecution[]>();
  // An empty `in (...)` list is invalid/always-false SQL — short-circuit
  // before building the query (mirrors the guard in `latestFilePerTestId`).
  if (monitorIds.length === 0) return result;

  const rows = await runRows<MonitorExecution>(
    sql`
    select
      "id",
      "projectId",
      "monitorId",
      cast("scheduledFor" as double precision) as "scheduledFor",
      cast("startedAt" as double precision) as "startedAt",
      cast("completedAt" as double precision) as "completedAt",
      "state",
      "attempt",
      "runId",
      "durationMs",
      "statusCode",
      "resultDetail",
      "errorMessage",
      cast("createdAt" as double precision) as "createdAt"
    from (
      select
        "id",
        "projectId",
        "monitorId",
        "scheduledFor",
        "startedAt",
        "completedAt",
        "state",
        "attempt",
        "runId",
        "durationMs",
        "statusCode",
        "resultDetail",
        "errorMessage",
        "createdAt",
        row_number() over (
          partition by "monitorId"
          order by "createdAt" desc
        ) as rn
      from "monitorExecutions"
      where "projectId" = ${scope.projectId}
        and "monitorId" in (${sql.join(
          monitorIds.map((id) => sql`${id}`),
          sql`, `,
        )})
    ) ranked
    where rn <= ${perMonitor}
    order by "monitorId", "createdAt" desc
    `,
    { feature: "monitor-recent-executions" },
  );

  for (const row of rows) {
    const list = result.get(row.monitorId);
    if (list) {
      list.push(row);
    } else {
      result.set(row.monitorId, [row]);
    }
  }
  return result;
}

/** A single execution by id within the tenant, or null. */
export async function getExecution(
  scope: TenantScope,
  executionId: string,
): Promise<MonitorExecution | null> {
  const rows = await db
    .select()
    .from(monitorExecutions)
    .where(childByIdWhere(monitorExecutions, scope, executionId))
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
 * ack'd without running (see `runMonitorJob`).
 *
 * The PRECISE invariant: `pass`/`fail`/`degraded` rows are immutable — a
 * spurious redelivery finds them outside the claimable set and never re-runs
 * or overwrites them. `error` rows are re-claimable by ANY redelivery, not
 * just the infra-retry this exists for: the row does not persist whether its
 * error was infra (retryable — sandbox budget, transport) or real (a settled
 * user-facing outcome), so a duplicate redelivery arriving after a REAL error
 * settled can re-claim it, re-run the container, and overwrite the row with a
 * fresh outcome. That is a bounded, converging cost (one duplicate container
 * run; the idempotency-key run linking keeps the produced run singular), not
 * corruption — but closing it requires persisting an infra-error flag on
 * `monitorExecutions` (schema change), deliberately not taken here. Scoped by
 * the row's own `(projectId, id)`; `.returning()` reports whether a row was
 * claimed.
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
        // `error` remains claimable because infra failures are retryable and the
        // schema does not yet distinguish them from settled test failures.
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
 *
 * INFRA errors (`result.infraError`) record the execution row (so the failed
 * attempt is visible in the timeline / `ExecStrip`) but DO NOT bump the
 * monitor's denormalized `lastStatus`/`lastRunAt`: an infra error is OUR-side
 * (sandbox unavailable, transient) and is being retried, not a health signal
 * about the monitored target. Persisting it would regress the monitor badge AND
 * pollute the health baseline the alert classifier reads on the retry, turning
 * one transient hiccup into a "down" + spurious "recovered" email pair. The
 * badge therefore stays owned by real recorded executions — the same policy the
 * stale-execution reaper (`sweepStaleExecutions`) already follows. That rule
 * lives in the shared `monitorBadgeUpdate` projection (`@/lib/monitors/executor`),
 * which the broadcast path (`monitorResultEvent`) also derives from — so the
 * persisted badge and the live `monitor-result` event can never disagree.
 */
export async function recordExecutionResult(
  execution: MonitorExecution,
  result: ExecutionResult,
  now: number,
): Promise<void> {
  // The one settled-result → badge rule, shared with the broadcast path:
  // `null` = retryable infra error, leave the monitor's badge untouched.
  const badge = monitorBadgeUpdate(result, now);
  await runBatch((tx) => [
    tx
      .update(monitorExecutions)
      .set({
        state: result.state,
        runId: result.runId,
        durationMs: result.durationMs,
        // http inline result fields; null for browser executions. jsonb column —
        // store the detail object directly (no JSON.stringify).
        statusCode: result.statusCode,
        resultDetail: result.resultDetail ?? null,
        errorMessage: result.errorMessage,
        completedAt: now,
      })
      .where(
        and(
          eq(monitorExecutions.projectId, execution.projectId),
          eq(monitorExecutions.id, execution.id),
        ),
      ),
    // Skip the monitor badge/baseline bump for a retryable infra error (above).
    ...(badge === null
      ? []
      : [
          tx
            .update(monitors)
            .set({
              lastStatus: badge.lastStatus,
              lastRunAt: badge.lastRunAt,
              updatedAt: now,
            })
            .where(
              and(
                eq(monitors.projectId, execution.projectId),
                eq(monitors.id, execution.monitorId),
              ),
            ),
        ]),
  ]);
}

/**
 * The stale-execution predicate — exported pure (operators only, no `db`) so
 * the reaper's timing rule is unit-testable. The two non-terminal states age
 * from DIFFERENT clocks:
 *   - `queued` ages from `createdAt` (it never started; the enqueue send
 *     failed or the backlog is deep);
 *   - `running` ages from `coalesce(startedAt, createdAt)` — the claim
 *     transition stamps `startedAt`, and queue dwell before the claim is
 *     unbounded, so aging a running execution from `createdAt` would reap one
 *     that was legitimately claimed at minute 29 of a 30-minute window while
 *     its container is still mid-flight. The `coalesce` is belt-and-braces for
 *     a `running` row missing `startedAt` (not produced by any current path).
 */
export function staleExecutionsWhere(cutoffSeconds: number) {
  return or(
    and(
      eq(monitorExecutions.state, "queued"),
      lt(monitorExecutions.createdAt, cutoffSeconds),
    ),
    and(
      eq(monitorExecutions.state, "running"),
      sql`coalesce(${monitorExecutions.startedAt}, ${monitorExecutions.createdAt}) < ${cutoffSeconds}`,
    ),
  );
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
 * The per-row UPDATE re-applies the same stale predicate so it can't clobber an
 * execution that reached a terminal state — or was freshly (re-)claimed to
 * `running` — between the SELECT and the write (a real result racing the
 * sweep). The cutoff must comfortably exceed a full retry lifecycle
 * (maxRetries × MAX_DURATION + queue dwell) so a legitimately slow/retrying
 * execution is never reaped mid-flight. The monitor's denormalized `lastStatus`
 * is deliberately left untouched: a reaped execution still shows as `error` in
 * the timeline + `ExecStrip`, while the monitor badge stays owned by real
 * recorded executions (so a late straggler can't regress a healthy badge — the
 * cross-execution last-write-wins window noted in the repo docstring).
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
    .where(staleExecutionsWhere(opts.cutoffSeconds))
    .orderBy(asc(monitorExecutions.createdAt))
    .limit(opts.limit);

  if (stale.length === 0) return { found: 0, reaped: 0 };

  const updated = await runBatch((tx) =>
    stale.map((e) =>
      tx
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
            staleExecutionsWhere(opts.cutoffSeconds),
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
