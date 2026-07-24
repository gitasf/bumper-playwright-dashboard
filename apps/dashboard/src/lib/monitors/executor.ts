import type { Monitor, MonitorExecution } from "@schema";
import type { ProjectRoomEvent } from "@/realtime/events";
import type {
  ExecutionResult,
  MonitorExecutor,
  MonitorJob,
  TerminalExecutionState,
} from "@/lib/monitors/types";

/**
 * The queue consumer's PURE per-job orchestrator — the synthetic-monitoring
 * twin of `finalizeStaleRun`'s "do the right thing with a trusted row" shape,
 * but expressed as a dependency-injected pure function so it is unit-testable
 * WITHOUT the `void/db` / `void/sandbox` / `void/queues` runtime (all of which
 * throw or fail to resolve under the vitest harness — see the test-harness
 * constraint in the monitors notes).
 *
 * Every effect — loading the monitor + execution rows, flipping the execution
 * to `running`, recording the terminal result, running the actual check, and
 * reading the clock — is a parameter on {@link RunMonitorJobDeps}. The queue
 * file (`queues/monitors.ts`) is the thin adapter that wires those params to
 * the real `monitors-repo` IO + the resolved `MonitorExecutor` + `Date.now`;
 * this function owns only the ack/retry DECISION, which is the load-bearing
 * logic and the part worth testing.
 *
 * The ack-vs-retry contract is the whole point:
 *   - missing rows (execution or monitor deleted out from under the job) → ack:
 *     there is nothing to run and re-delivery would never find them either;
 *   - the executor RAN and observed an outcome (`infraError === false`, incl.
 *     an app failure / "site down") → record it and ack: a real result, not a
 *     delivery failure, so re-running would just double-bill a container;
 *   - the executor THREW, or returned `infraError === true` (sandbox
 *     unavailable, token mint failed, transient infra) → record an `error`
 *     terminal row so the UI shows the attempt, and retry: re-delivery may
 *     succeed where the infra hiccup failed.
 */

/**
 * Injected effects for {@link runMonitorJob}. Each maps 1:1 to a
 * `monitors-repo` system-internal function (load/mark/record) or the resolved
 * executor; `now` is the clock so the consumer can record consistent
 * `completedAt` timestamps and tests stay deterministic.
 */
export interface RunMonitorJobDeps {
  loadMonitor: (id: string) => Promise<Monitor | null>;
  loadExecution: (id: string) => Promise<MonitorExecution | null>;
  /**
   * Atomically claim the execution for running (CAS, `queued`/`error` →
   * `running`), returning whether THIS delivery won. A lost claim is the
   * at-least-once-redelivery / already-terminal signal — the consumer acks
   * without running. Backed by `claimExecution` in `monitors-repo`.
   */
  claim: (e: MonitorExecution, now: number) => Promise<boolean>;
  recordResult: (
    e: MonitorExecution,
    r: ExecutionResult,
    now: number,
  ) => Promise<void>;
  executor: MonitorExecutor;
  now: () => number;
  /**
   * Push a settled-execution event to the monitor's project `void/ws` room so
   * the live monitors list advances the row. Wired to `broadcastProjectRoom`
   * (`@/realtime/publish`) in `queues/monitors.ts`. NON-FATAL: the result is
   * already in D1, so a realtime hiccup must never change the ack/retry outcome
   * — `runMonitorJob` guards every call so a throw here can't flip the decision.
   */
  broadcast: (projectId: string, event: ProjectRoomEvent) => Promise<void>;
  /**
   * Fire a down/recovery email alert for the settled result, given the monitor's
   * PRIOR `lastStatus` (captured before `recordResult` overwrites it) so the
   * transition can be classified. Wired to `maybeSendMonitorAlert`
   * (`@/lib/monitors/alerts`) in the queue consumers. OPTIONAL + NON-FATAL: like
   * `broadcast`, the result is already in D1, so a throw here must never change
   * the ack/retry outcome — `runMonitorJob` guards every call. Omitted by tests
   * that don't exercise alerting. Called ONLY for a REAL (non-`infraError`)
   * outcome: a retryable infra error is not a health signal, so `runMonitorJob`
   * skips it (see the alert-gating note in the executor body).
   */
  alert?: (
    monitor: Monitor,
    result: ExecutionResult,
    prevStatus: string | null,
  ) => Promise<void>;
}

/** The consumer's per-message decision: ack the message or retry it. */
export type RunMonitorJobOutcome = { action: "ack" | "retry" };

/**
 * The terminal result recorded — and the message ack'd — when the executor
 * could not run the check (threw, or flagged `infraError`). Shaped as a normal
 * {@link ExecutionResult} so it flows through the SAME `recordResult` path a
 * real outcome does: the execution row lands on `error`, so a persistently
 * failing infra problem is visible in the UI rather than stuck at `running`
 * while the message silently retries. The monitor's badge is left untouched —
 * `infraError: true` makes {@link monitorBadgeUpdate} return `null`, so the
 * persisted `lastStatus`/`lastRunAt` and the broadcast both keep prior values.
 */
function infraErrorResult(errorMessage: string): ExecutionResult {
  return {
    state: "error",
    runId: null,
    durationMs: null,
    errorMessage,
    infraError: true,
    statusCode: null,
    resultDetail: null,
  };
}

/**
 * The settled-result → monitor-badge projection: what one terminal result does
 * to the monitor's denormalized `lastStatus`/`lastRunAt`. Returns the new badge,
 * or `null` (leave it unchanged) for a retryable infra error (sandbox capacity,
 * token mint failure) — an our-side hiccup being retried isn't a health signal
 * about the target, so it must neither regress the badge nor pollute the alert
 * baseline the classifier reads on retry. A real `error` (`infraError: false`,
 * e.g. a wall-clock timeout) lands on the badge like `pass`/`fail`/`degraded`.
 *
 * The one place this rule lives: both badge writers derive from it, so the
 * persisted row (`recordExecutionResult`, skips the bump on `null`) and the
 * live broadcast ({@link monitorResultEvent}, falls back to the prior badge on
 * `null`) can never disagree.
 */
export function monitorBadgeUpdate(
  result: ExecutionResult,
  settledAt: number,
): { lastStatus: TerminalExecutionState; lastRunAt: number } | null {
  if (result.infraError) return null;
  return { lastStatus: result.state, lastRunAt: settledAt };
}

/**
 * Build the live `monitor-result` event for a settled execution. Badge fields
 * come from the same {@link monitorBadgeUpdate} projection `recordExecutionResult`
 * persists, so the broadcast mirrors the DB: a real outcome advances the badge,
 * a retryable infra error carries the `monitor` argument's unchanged prior
 * values (no live badge flipping red on a hiccup then reverting on reload). The
 * execution row (id + settled state + runId + mint time) is prepended to the
 * history strip in every case; its id dedupes a redelivery.
 */
function monitorResultEvent(
  monitor: Monitor,
  execution: MonitorExecution,
  result: ExecutionResult,
  settledAt: number,
): ProjectRoomEvent {
  const badge = monitorBadgeUpdate(result, settledAt);
  return {
    type: "monitor-result",
    monitorId: monitor.id,
    lastStatus: badge ? badge.lastStatus : monitor.lastStatus,
    lastRunAt: badge ? badge.lastRunAt : monitor.lastRunAt,
    execution: {
      id: execution.id,
      state: result.state,
      runId: result.runId,
      createdAt: execution.createdAt,
      durationMs: result.durationMs,
      statusCode: result.statusCode,
    },
  };
}

/**
 * Broadcast the settle event, swallowing any failure. A realtime hiccup must
 * never change the job's ack/retry decision — the outcome is already in D1 — so
 * this is isolated from the caller's control flow. In particular it guards the
 * SUCCESS path: an unguarded throw there would fall into `runMonitorJob`'s catch
 * and wrongly re-record the run as an infra error + retry.
 */
async function safeBroadcast(
  deps: RunMonitorJobDeps,
  projectId: string,
  event: ProjectRoomEvent,
): Promise<void> {
  try {
    await deps.broadcast(projectId, event);
  } catch {
    // intentionally ignored — see docstring
  }
}

/**
 * Fire the down/recovery alert, swallowing any failure for the same reason as
 * {@link safeBroadcast}: the result is already recorded, so an alert hiccup must
 * not flip the ack/retry decision. `maybeSendMonitorAlert` already catches its
 * own errors; this is belt-and-braces (and a no-op when no `alert` dep is wired).
 */
async function safeAlert(
  deps: RunMonitorJobDeps,
  monitor: Monitor,
  result: ExecutionResult,
  prevStatus: string | null,
): Promise<void> {
  if (!deps.alert) return;
  try {
    await deps.alert(monitor, result, prevStatus);
  } catch {
    // intentionally ignored — see docstring
  }
}

/**
 * Run one monitor job to a terminal record + an ack/retry decision. See the
 * module docstring for the full contract; the branch order here is the tested
 * surface (`executor.test.ts`):
 *
 *   1. Load the execution. Gone → ack (deleted/cancelled; nothing to do).
 *   2. Load the monitor. Gone → record an `error` against the execution and ack
 *      (the monitor was deleted after enqueue; re-running can't recreate it, so
 *      retrying would loop forever — record the dead-end and move on).
 *   3. Claim the execution (CAS `queued`/`error` → `running`). Lost claim → ack
 *      and do nothing: a concurrent at-least-once redelivery already owns it, or
 *      it already settled to a terminal success a redelivery must not re-run.
 *   4. Run the executor:
 *        - throws → record `error` (infra) + retry;
 *        - returns `infraError === true` → record that result + retry;
 *        - returns a real outcome → record it + ack.
 *
 * The claim runs BEFORE the executor (not after a successful load) so it both
 * gates double-execution AND makes the in-flight state visible for the whole —
 * potentially multi-minute — container run, matching how the run-detail UI
 * expects to watch a live check.
 */
export async function runMonitorJob(
  job: MonitorJob,
  deps: RunMonitorJobDeps,
): Promise<RunMonitorJobOutcome> {
  const execution = await deps.loadExecution(job.executionId);
  if (!execution) return { action: "ack" };

  const monitor = await deps.loadMonitor(job.monitorId);
  if (!monitor) {
    await deps.recordResult(
      execution,
      infraErrorResult("monitor was deleted before its execution ran"),
      deps.now(),
    );
    return { action: "ack" };
  }

  // The monitor's CURRENT lastStatus is the PRIOR result — captured here, before
  // `recordResult` overwrites it — so the alert can classify the health
  // transition (healthy↔down) and only email on an edge, not every interval.
  const prevStatus = monitor.lastStatus;

  // Claim the execution before running (CAS). A lost claim means another
  // delivery already owns it (Cloudflare Queues is at-least-once) or it already
  // reached a terminal success — ack without launching a container or recording
  // anything, so a redelivery can't double-bill or overwrite a terminal row.
  if (!(await deps.claim(execution, deps.now()))) {
    return { action: "ack" };
  }

  try {
    const result = await deps.executor.execute({ monitor, execution });
    const settledAt = deps.now();
    await deps.recordResult(execution, result, settledAt);
    await safeBroadcast(
      deps,
      monitor.projectId,
      monitorResultEvent(monitor, execution, result, settledAt),
    );
    // Only a REAL (non-infra) outcome is a health signal worth emailing. An
    // infra error (sandbox unavailable, token mint failed, transient) is being
    // RETRIED — alerting on it would email "🔴 down" for OUR hiccup and then a
    // spurious "✅ recovered" when the retry succeeds. Skip it; the retry's
    // terminal outcome is what alerts, classified against the true prior health
    // (`recordExecutionResult` leaves the monitor's `lastStatus` untouched on an
    // infra error, so the baseline isn't polluted with 'error').
    if (!result.infraError) {
      await safeAlert(deps, monitor, result, prevStatus);
    }
    return { action: result.infraError ? "retry" : "ack" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const settledAt = deps.now();
    const result = infraErrorResult(message);
    await deps.recordResult(execution, result, settledAt);
    await safeBroadcast(
      deps,
      monitor.projectId,
      monitorResultEvent(monitor, execution, result, settledAt),
    );
    // No alert here: a thrown executor is always an infra error being retried
    // (see the success-path note above) — the retry's real outcome alerts.
    return { action: "retry" };
  }
}
