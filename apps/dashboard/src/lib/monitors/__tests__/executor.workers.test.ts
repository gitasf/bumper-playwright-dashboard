import { describe, expect, it, vi } from "vite-plus/test";
import { runMonitorJob, type RunMonitorJobDeps } from "@/lib/monitors/executor";
import type {
  ExecutionResult,
  Monitor,
  MonitorExecution,
  MonitorJob,
} from "@/lib/monitors/types";

/**
 * `runMonitorJob` (`@/lib/monitors/executor`) is the queue consumer's PURE
 * per-job decision: load the execution + monitor, flip to running, run the
 * executor, record the terminal result, and return ack/retry — all with its IO
 * injected, so it is unit-testable WITHOUT the `void/db` / `void/sandbox`
 * runtime the queue file pulls in (and the harness can't resolve). The actual
 * `monitors-repo` IO + the resolved executor + the clock live in
 * `queues/monitors.ts`, which is the integration-only adapter; the ack-vs-retry
 * contract that protects against double-billing a container (ack a real
 * outcome) vs. dropping an infra failure (retry) is exactly this function.
 *
 * Pins the four branches the consumer keys off:
 *   (1) missing execution → ack, nothing recorded (deleted out from under it);
 *   (2) missing monitor → record an `error` + ack (re-running can't recreate it);
 *   (3) executor returns `infraError: true` → record that result + retry;
 *   (4) executor THROWS → record an `error` (infra) + retry;
 *   (5) executor returns a real (even failing) outcome → record it + ack.
 */

const JOB: MonitorJob = {
  monitorId: "mon-1",
  executionId: "ex-1",
  scheduledFor: 1000,
};

const EXECUTION = {
  id: "ex-1",
  projectId: "proj-1",
  createdAt: 4321,
} as MonitorExecution;
const MONITOR = { id: "mon-1", projectId: "proj-1" } as Monitor;

/** A passing executor result — the common "site is up" outcome. */
const PASS_RESULT: ExecutionResult = {
  state: "pass",
  runId: "run-1",
  durationMs: 1234,
  errorMessage: null,
  infraError: false,
  statusCode: null,
  resultDetail: null,
};

type SpiedDeps = RunMonitorJobDeps & {
  recordResult: ReturnType<typeof vi.fn<RunMonitorJobDeps["recordResult"]>>;
  claim: ReturnType<typeof vi.fn<RunMonitorJobDeps["claim"]>>;
  broadcast: ReturnType<typeof vi.fn<RunMonitorJobDeps["broadcast"]>>;
};

/** Build `RunMonitorJobDeps` with sensible fakes, overridable per test. */
function makeDeps(overrides: Partial<RunMonitorJobDeps> = {}): SpiedDeps {
  const recordResult =
    (overrides.recordResult as SpiedDeps["recordResult"] | undefined) ??
    vi.fn<RunMonitorJobDeps["recordResult"]>(() => Promise.resolve());
  const claim =
    (overrides.claim as SpiedDeps["claim"] | undefined) ??
    vi.fn<RunMonitorJobDeps["claim"]>(() => Promise.resolve(true));
  const broadcast =
    (overrides.broadcast as SpiedDeps["broadcast"] | undefined) ??
    vi.fn<RunMonitorJobDeps["broadcast"]>(() => Promise.resolve());
  return {
    loadExecution: () => Promise.resolve(EXECUTION),
    loadMonitor: () => Promise.resolve(MONITOR),
    executor: { execute: () => Promise.resolve(PASS_RESULT) },
    now: () => 5000,
    ...overrides,
    recordResult,
    claim,
    broadcast,
  };
}

describe("runMonitorJob", () => {
  it("acks and records nothing when the execution is gone", async () => {
    const deps = makeDeps({ loadExecution: () => Promise.resolve(null) });

    const outcome = await runMonitorJob(JOB, deps);

    expect(outcome).toEqual({ action: "ack" });
    expect(deps.recordResult).not.toHaveBeenCalled();
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it("records an error and acks when the monitor was deleted before running", async () => {
    const deps = makeDeps({ loadMonitor: () => Promise.resolve(null) });

    const outcome = await runMonitorJob(JOB, deps);

    expect(outcome).toEqual({ action: "ack" });
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.recordResult).toHaveBeenCalledTimes(1);
    const [exec, result, now] = deps.recordResult.mock.calls[0]!;
    expect(exec).toBe(EXECUTION);
    expect(result).toMatchObject({ state: "error", infraError: true });
    expect(now).toBe(5000);
  });

  it("claims, records the result, and acks on a passing outcome", async () => {
    const deps = makeDeps();

    const outcome = await runMonitorJob(JOB, deps);

    expect(outcome).toEqual({ action: "ack" });
    expect(deps.claim).toHaveBeenCalledWith(EXECUTION, 5000);
    expect(deps.recordResult).toHaveBeenCalledTimes(1);
    expect(deps.recordResult.mock.calls[0]![1]).toBe(PASS_RESULT);
  });

  it("acks without running or recording when the claim is lost", async () => {
    // A concurrent at-least-once redelivery already owns the execution (or it
    // already settled to a terminal success) — claim returns false.
    const execute = vi.fn(() => Promise.resolve(PASS_RESULT));
    const deps = makeDeps({
      claim: vi.fn<RunMonitorJobDeps["claim"]>(() => Promise.resolve(false)),
      executor: { execute },
    });

    const outcome = await runMonitorJob(JOB, deps);

    expect(outcome).toEqual({ action: "ack" });
    expect(execute).not.toHaveBeenCalled();
    expect(deps.recordResult).not.toHaveBeenCalled();
  });

  it("records a failing-but-real outcome and acks (never retries an app failure)", async () => {
    const failResult: ExecutionResult = {
      state: "fail",
      runId: "run-2",
      durationMs: 999,
      errorMessage: "expected element to be visible",
      infraError: false,
      statusCode: null,
      resultDetail: null,
    };
    const deps = makeDeps({
      executor: { execute: () => Promise.resolve(failResult) },
    });

    const outcome = await runMonitorJob(JOB, deps);

    expect(outcome).toEqual({ action: "ack" });
    expect(deps.recordResult.mock.calls[0]![1]).toBe(failResult);
  });

  it("records a wall-clock-timeout outcome terminally and acks (never retries a hang)", async () => {
    // The SandboxExecutor classifies an exec that hit the execution budget as
    // a TERMINAL user-facing error (`infraError: false`): the per-test timeout
    // is clamped below the budget, so reaching the exec kill means the user's
    // script hung deterministically — re-running would burn maxRetries full
    // container runs for the same outcome.
    const timeoutResult: ExecutionResult = {
      state: "error",
      runId: null,
      durationMs: 300_000,
      errorMessage:
        "check exceeded the 300s execution budget and was terminated",
      infraError: false,
      statusCode: null,
      resultDetail: null,
    };
    const deps = makeDeps({
      executor: { execute: () => Promise.resolve(timeoutResult) },
    });

    const outcome = await runMonitorJob(JOB, deps);

    expect(outcome).toEqual({ action: "ack" });
    expect(deps.recordResult).toHaveBeenCalledTimes(1);
    expect(deps.recordResult.mock.calls[0]![1]).toBe(timeoutResult);
  });

  it("records the infra-error result and retries when infraError is set", async () => {
    const infraResult: ExecutionResult = {
      state: "error",
      runId: null,
      durationMs: 10,
      errorMessage: "sandbox unavailable (concurrency)",
      infraError: true,
      statusCode: null,
      resultDetail: null,
    };
    const deps = makeDeps({
      executor: { execute: () => Promise.resolve(infraResult) },
    });

    const outcome = await runMonitorJob(JOB, deps);

    expect(outcome).toEqual({ action: "retry" });
    expect(deps.recordResult).toHaveBeenCalledTimes(1);
    expect(deps.recordResult.mock.calls[0]![1]).toBe(infraResult);
  });

  it("records an error and retries when the executor throws", async () => {
    const deps = makeDeps({
      executor: {
        execute: () => Promise.reject(new Error("container boot timeout")),
      },
    });

    const outcome = await runMonitorJob(JOB, deps);

    expect(outcome).toEqual({ action: "retry" });
    expect(deps.recordResult).toHaveBeenCalledTimes(1);
    const [, result] = deps.recordResult.mock.calls[0]!;
    expect(result).toMatchObject({
      state: "error",
      infraError: true,
      errorMessage: "container boot timeout",
    });
  });

  it("fires the alert on a REAL outcome, with the prior status for classification", async () => {
    const alert = vi.fn<NonNullable<RunMonitorJobDeps["alert"]>>(() =>
      Promise.resolve(),
    );
    // The monitor's CURRENT lastStatus is the PRIOR result the classifier needs.
    const monitorWithStatus = {
      id: "mon-1",
      projectId: "proj-1",
      lastStatus: "pass",
    } as Monitor;
    const deps = makeDeps({
      alert,
      loadMonitor: () => Promise.resolve(monitorWithStatus),
    });

    await runMonitorJob(JOB, deps);

    expect(alert).toHaveBeenCalledTimes(1);
    const [mon, result, prevStatus] = alert.mock.calls[0]!;
    expect(mon).toBe(monitorWithStatus);
    expect(result).toBe(PASS_RESULT);
    expect(prevStatus).toBe("pass");
  });

  it("does NOT fire the alert on a retryable infra error (no spurious down/recovery emails)", async () => {
    // The core P1 fix: a transient infra error must not email "down", because
    // the retry would then email a spurious "recovered". The result is still
    // RECORDED (visible in the timeline) — only the alert is suppressed.
    const alert = vi.fn<NonNullable<RunMonitorJobDeps["alert"]>>(() =>
      Promise.resolve(),
    );
    const infraResult: ExecutionResult = {
      state: "error",
      runId: null,
      durationMs: 10,
      errorMessage: "sandbox unavailable (concurrency)",
      infraError: true,
      statusCode: null,
      resultDetail: null,
    };
    const deps = makeDeps({
      alert,
      executor: { execute: () => Promise.resolve(infraResult) },
    });

    const outcome = await runMonitorJob(JOB, deps);

    expect(outcome).toEqual({ action: "retry" });
    expect(deps.recordResult).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
  });

  it("does NOT fire the alert when the executor throws (infra error)", async () => {
    const alert = vi.fn<NonNullable<RunMonitorJobDeps["alert"]>>(() =>
      Promise.resolve(),
    );
    const deps = makeDeps({
      alert,
      executor: {
        execute: () => Promise.reject(new Error("container boot timeout")),
      },
    });

    const outcome = await runMonitorJob(JOB, deps);

    expect(outcome).toEqual({ action: "retry" });
    expect(alert).not.toHaveBeenCalled();
  });

  it("broadcasts the settled result to the monitor's project room on a real outcome", async () => {
    const deps = makeDeps();

    await runMonitorJob(JOB, deps);

    expect(deps.broadcast).toHaveBeenCalledTimes(1);
    const [projectId, event] = deps.broadcast.mock.calls[0]!;
    expect(projectId).toBe("proj-1");
    expect(event).toEqual({
      type: "monitor-result",
      monitorId: "mon-1",
      // Mirrors recordExecutionResult: new lastStatus = result state, lastRunAt = now.
      lastStatus: "pass",
      lastRunAt: 5000,
      execution: {
        id: "ex-1",
        state: "pass",
        runId: "run-1",
        createdAt: 4321,
        // Carried through from the result so the live list can show response
        // time / status (null for browser executions like this one).
        durationMs: 1234,
        statusCode: null,
      },
    });
  });

  it("broadcasts an error settle (the row should turn red) and still retries", async () => {
    const deps = makeDeps({
      executor: {
        execute: () => Promise.reject(new Error("container boot timeout")),
      },
    });

    const outcome = await runMonitorJob(JOB, deps);

    expect(outcome).toEqual({ action: "retry" });
    expect(deps.broadcast).toHaveBeenCalledTimes(1);
    expect(deps.broadcast.mock.calls[0]![1]).toMatchObject({
      type: "monitor-result",
      monitorId: "mon-1",
      lastStatus: "error",
    });
  });

  it("does NOT broadcast when there is no live row to update (missing execution, lost claim, deleted monitor)", async () => {
    const gone = makeDeps({ loadExecution: () => Promise.resolve(null) });
    await runMonitorJob(JOB, gone);
    expect(gone.broadcast).not.toHaveBeenCalled();

    const lostClaim = makeDeps({
      claim: vi.fn<RunMonitorJobDeps["claim"]>(() => Promise.resolve(false)),
    });
    await runMonitorJob(JOB, lostClaim);
    expect(lostClaim.broadcast).not.toHaveBeenCalled();

    const deletedMonitor = makeDeps({
      loadMonitor: () => Promise.resolve(null),
    });
    await runMonitorJob(JOB, deletedMonitor);
    expect(deletedMonitor.broadcast).not.toHaveBeenCalled();
  });

  it("a broadcast failure never changes the ack decision (result is already persisted)", async () => {
    const deps = makeDeps({
      broadcast: vi.fn<RunMonitorJobDeps["broadcast"]>(() =>
        Promise.reject(new Error("room DO unreachable")),
      ),
    });

    const outcome = await runMonitorJob(JOB, deps);

    expect(outcome).toEqual({ action: "ack" });
    expect(deps.recordResult).toHaveBeenCalledTimes(1);
  });

  it("claims before invoking the executor", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      claim: vi.fn(() => {
        order.push("claim");
        return Promise.resolve(true);
      }),
      executor: {
        execute: () => {
          order.push("execute");
          return Promise.resolve(PASS_RESULT);
        },
      },
    });

    await runMonitorJob(JOB, deps);

    expect(order).toEqual(["claim", "execute"]);
  });
});
