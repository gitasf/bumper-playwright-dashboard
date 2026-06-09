import { appendRunResults, completeRun, openRun } from "@/lib/ingest";
import {
  findRunByIdempotencyKey,
  runStatusToExecutionState,
  tenantScopeForMonitor,
} from "@/lib/monitors/run-linking";
import type {
  ExecutionResult,
  Monitor,
  MonitorExecution,
  MonitorExecutor,
} from "@/lib/monitors/types";

/**
 * The dev/test `MonitorExecutor` (`WRIGHTFUL_MONITOR_EXECUTOR=stub`). Imports
 * `void/db` (via the ingest lib) so it is INTEGRATION-only — no unit test (the
 * harness's `void/db` stub throws on use); the full schedule → queue → ingest
 * pipeline is exercised against it without Docker / a Void Sandbox.
 *
 * It synthesizes the SAME linkage a real container produces: a `runs` row whose
 * `idempotencyKey === execution.id`, `origin = "synthetic"`, `monitorId` set,
 * carrying a couple of fake tests, then resolves the produced `runId` + maps the
 * run's terminal status to a monitor `state` through the shared `run-linking`
 * helpers — so the consumer downstream of `MonitorExecutor.execute` cannot tell
 * a stub run from a container run.
 *
 * Outcome is deterministic and content-driven: a monitor whose `source`
 * contains the sentinel `FORCE_FAIL` synthesizes a failing run (state `fail`);
 * otherwise a passing one (state `pass`). It NEVER returns `infraError` — the
 * stub always "runs", so the consumer always acks; the infra-error/retry branch
 * is the SandboxExecutor's territory.
 */

/** Sentinel in `monitors.source` that makes the stub synthesize a failing run. */
const FORCE_FAIL_SENTINEL = "FORCE_FAIL";

/** Per-attempt + duration shape the stub streams for each synthetic test. */
const STUB_TEST_DURATION_MS = 100;

export class StubExecutor implements MonitorExecutor {
  async execute(input: {
    monitor: Monitor;
    execution: MonitorExecution;
  }): Promise<ExecutionResult> {
    const { monitor, execution } = input;
    const startedAt = Date.now();
    const scope = await tenantScopeForMonitor(monitor);

    const shouldFail = (monitor.source ?? "").includes(FORCE_FAIL_SENTINEL);
    const runStatus = shouldFail ? "failed" : "passed";
    const nowSeconds = Math.floor(Date.now() / 1000);

    // Open the run keyed on the execution id — the same idempotency identity a
    // real container's reporter uses — with synthetic provenance so it is
    // attributable to its monitor on the runs list / insights.
    const opened = await openRun(
      scope,
      {
        idempotencyKey: execution.id,
        run: {
          ciProvider: null,
          ciBuildId: null,
          branch: null,
          environment: "synthetic",
          commitSha: null,
          commitMessage: null,
          prNumber: null,
          repo: null,
          actor: null,
          reporterVersion: "stub",
          playwrightVersion: "stub",
          expectedTotalTests: 2,
          plannedTests: [],
          origin: "synthetic",
          monitorId: monitor.id,
        },
      },
      nowSeconds,
    );

    // A couple of fake tests so the run renders like a real one. The failing
    // monitor fails its second test; the passing one passes both.
    await appendRunResults(
      scope,
      opened.runId,
      {
        results: [
          stubResult("stub-check-1", "homepage loads", "passed"),
          stubResult(
            "stub-check-2",
            "checkout flow",
            shouldFail ? "failed" : "passed",
          ),
        ],
      },
      nowSeconds,
    );

    const durationMs = STUB_TEST_DURATION_MS * 2;
    await completeRun(
      scope,
      opened.runId,
      { status: runStatus, durationMs },
      nowSeconds,
    );

    // Resolve the produced run + final status through the shared link helper,
    // exactly as the SandboxExecutor does, so the mapping lives in one place.
    const run = await findRunByIdempotencyKey(scope, execution.id);
    const wallMs = Date.now() - startedAt;
    return {
      state: run ? runStatusToExecutionState(run.status) : "error",
      runId: run?.id ?? opened.runId,
      durationMs: run?.durationMs ?? wallMs,
      errorMessage: shouldFail ? "stub monitor forced failure" : null,
      infraError: false,
    };
  }
}

/** Build one synthetic `TestResultInput` with a single attempt. */
function stubResult(
  testId: string,
  title: string,
  status: "passed" | "failed",
) {
  return {
    clientKey: testId,
    testId,
    title,
    file: "synthetic/check.spec.ts",
    projectName: "chromium",
    status,
    durationMs: STUB_TEST_DURATION_MS,
    retryCount: 0,
    errorMessage: status === "failed" ? "expected element to be visible" : null,
    errorStack: null,
    tags: [],
    annotations: [],
    attempts: [
      {
        attempt: 0,
        status,
        durationMs: STUB_TEST_DURATION_MS,
        errorMessage:
          status === "failed" ? "expected element to be visible" : null,
        errorStack: null,
      },
    ],
  };
}
