import type { Monitor, MonitorExecution } from "@schema";
import type {
  ExecutionResult,
  MonitorExecutor,
  MonitorJob,
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
}

/** The consumer's per-message decision: ack the message or retry it. */
export type RunMonitorJobOutcome = { action: "ack" | "retry" };

/**
 * The terminal result recorded — and the message ack'd — when the executor
 * could not run the check (threw, or flagged `infraError`). Shaped as a normal
 * {@link ExecutionResult} so it flows through the SAME `recordResult` path a
 * real outcome does: the execution row + the monitor's `lastStatus` both land
 * on `error`, so a persistently-failing infra problem is visible in the UI
 * rather than leaving the execution stuck at `running` while the message
 * silently retries in the background.
 */
function infraErrorResult(errorMessage: string): ExecutionResult {
  return {
    state: "error",
    runId: null,
    durationMs: null,
    errorMessage,
    infraError: true,
  };
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

  // Claim the execution before running (CAS). A lost claim means another
  // delivery already owns it (Cloudflare Queues is at-least-once) or it already
  // reached a terminal success — ack without launching a container or recording
  // anything, so a redelivery can't double-bill or overwrite a terminal row.
  if (!(await deps.claim(execution, deps.now()))) {
    return { action: "ack" };
  }

  try {
    const result = await deps.executor.execute({ monitor, execution });
    await deps.recordResult(execution, result, deps.now());
    return { action: result.infraError ? "retry" : "ack" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.recordResult(execution, infraErrorResult(message), deps.now());
    return { action: "retry" };
  }
}
