import { env } from "void/env";
import { getSandbox, SandboxLimitError } from "void/sandbox";
import {
  generatePlaywrightConfig,
  specFilename,
} from "@/lib/monitors/playwright-config";
import {
  findRunByIdempotencyKey,
  runStatusToExecutionState,
  tenantScopeForMonitor,
} from "@/lib/monitors/run-linking";
import {
  mintSyntheticKey,
  revokeSyntheticKey,
} from "@/lib/monitors/synthetic-key";
import type {
  ExecutionResult,
  Monitor,
  MonitorExecution,
  MonitorExecutor,
} from "@/lib/monitors/types";

/**
 * The production `MonitorExecutor` (`WRIGHTFUL_MONITOR_EXECUTOR=sandbox`,
 * default). Runs the user's `monitors.source` as a one-file Playwright project
 * inside a Void Sandbox container; the in-container `@wrightful/reporter`
 * streams a real `runs` row back to `/api/runs` linked to this execution.
 * Imports `void/sandbox` / `void/env` / `void/db` (via the link + key helpers) —
 * INTEGRATION-only, no unit test (the harness can't resolve those runtime
 * imports). The pure parts it leans on (`generatePlaywrightConfig`,
 * `runStatusToExecutionState`) are unit-tested in their own modules.
 *
 * Flow:
 *   1. Resolve the tenant scope from the (trusted) monitor row.
 *   2. Mint a fresh per-run ingest key (revoked in `finally`).
 *   3. Acquire the container, scaffold `/work` (config + the spec), and run
 *      `npx playwright test` with the `WRIGHTFUL_*` env that makes the reporter
 *      open the run with `idempotencyKey === execution.id`, `origin =
 *      "synthetic"`, `monitorId` set — the LINKING contract.
 *   4. Resolve the produced run by `(projectId, idempotencyKey=execution.id)`
 *      and map its terminal status to a monitor `state`.
 *
 * Error policy mirrors the `ExecutionResult.infraError` contract the consumer
 * keys ack/retry off:
 *   - A `SandboxLimitError` (concurrency / runtime budget) or any thrown
 *     transport/setup error → `{ state: "error", infraError: true }` so the
 *     consumer RETRIES (a later tick may have budget).
 *   - The container ran but no run was streamed (reporter never reached
 *     `onBegin`, e.g. an import error before the first test) → also an infra
 *     error: the check did not produce an observable outcome.
 *   - The container ran AND a run exists → a REAL result (`infraError: false`),
 *     even if the run failed: that is the monitor's whole job (the site is down
 *     / a test failed), recorded and ack'd, never retried.
 */
export class SandboxExecutor implements MonitorExecutor {
  async execute(input: {
    monitor: Monitor;
    execution: MonitorExecution;
  }): Promise<ExecutionResult> {
    const { monitor, execution } = input;
    const startedAt = Date.now();
    const maxDurationMs = env.WRIGHTFUL_MONITOR_MAX_DURATION_SECONDS * 1000;

    // A browser monitor must carry a Playwright spec. The create/edit schemas
    // already force non-empty `source`, so this fires only on a bad direct DB
    // write or a future code path — but fail it TERMINALLY (`infraError: false`
    // → the consumer acks) rather than launch a container that finds no tests,
    // streams no run, and would otherwise read as an infra error retried all the
    // way to the dead-letter (a wasted container per delivery).
    const source = monitor.source ?? "";
    if (source.trim() === "") {
      return {
        state: "error",
        runId: null,
        durationMs: Date.now() - startedAt,
        errorMessage: "monitor has no Playwright source",
        infraError: false,
      };
    }

    let scope;
    try {
      scope = await tenantScopeForMonitor(monitor);
    } catch (err) {
      return infraError(err, Date.now() - startedAt);
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    let key;
    try {
      key = await mintSyntheticKey(scope.projectId, execution.id, nowSeconds);
    } catch (err) {
      return infraError(err, Date.now() - startedAt);
    }

    // Declared outside the try so `finally` can tear it down even if a later
    // step throws. Left undefined when `getSandbox` itself throws (e.g. a
    // budget/limit error before the container is acquired).
    let sandbox: Awaited<ReturnType<typeof getSandbox>> | undefined;
    try {
      // `getSandbox` is keyed on the execution id so a redelivered message
      // re-targets the same container slot, and the gate's per-user budget
      // accounting keys off a stable id. May throw `SandboxLimitError`.
      sandbox = await getSandbox(execution.id);

      const workDir = "/work";
      const testsDir = `${workDir}/tests`;
      await sandbox.mkdir(testsDir, { recursive: true });
      await sandbox.writeFile(
        `${workDir}/playwright.config.ts`,
        generatePlaywrightConfig({ reporterModule: "@wrightful/reporter" }),
      );
      await sandbox.writeFile(`${testsDir}/${specFilename()}`, source);

      // The LINKING env: the reporter reads these to open the run attributable
      // to this execution. `WRIGHTFUL_IDEMPOTENCY_KEY = execution.id` is the
      // key the run is later resolved by. `PLAYWRIGHT_TIMEOUT_MS` clamps the
      // per-test timeout to the same budget that bounds the exec wall-clock.
      const runEnv: Record<string, string> = {
        WRIGHTFUL_URL: env.WRIGHTFUL_PUBLIC_URL,
        WRIGHTFUL_TOKEN: key.token,
        WRIGHTFUL_IDEMPOTENCY_KEY: execution.id,
        WRIGHTFUL_MONITOR_ID: monitor.id,
        WRIGHTFUL_RUN_ORIGIN: "synthetic",
        PLAYWRIGHT_TIMEOUT_MS: String(maxDurationMs),
      };

      // Hard wall-clock cap on the whole suite: the container can't outlive the
      // budget even if a user script hangs past the per-test timeout.
      await sandbox.exec("npx playwright test", {
        cwd: workDir,
        env: runEnv,
        timeout: maxDurationMs,
      });

      // The exec's exit code is intentionally NOT the source of truth: a failed
      // test makes Playwright exit non-zero, which is a NORMAL monitor outcome,
      // not an infra error. The real result is the run the reporter streamed —
      // resolve it by the idempotency key.
      const run = await findRunByIdempotencyKey(scope, execution.id);
      const wallMs = Date.now() - startedAt;
      if (!run) {
        return {
          state: "error",
          runId: null,
          durationMs: wallMs,
          errorMessage:
            "container ran but no run was streamed (reporter never opened a run)",
          infraError: true,
        };
      }
      return {
        state: runStatusToExecutionState(run.status),
        runId: run.id,
        durationMs: run.durationMs || wallMs,
        errorMessage: null,
        infraError: false,
      };
    } catch (err) {
      // `SandboxLimitError` and any transport/setup throw are infra errors →
      // retry. (A non-zero `npx playwright test` exit does NOT throw from
      // `exec`, so a failing check never lands here.)
      if (err instanceof SandboxLimitError) {
        return {
          state: "error",
          runId: null,
          durationMs: Date.now() - startedAt,
          errorMessage: `sandbox unavailable (${err.reason})`,
          infraError: true,
        };
      }
      return infraError(err, Date.now() - startedAt);
    } finally {
      // Tear the container down immediately so it scales to zero. The Sandbox
      // SDK mandates `destroy()` ("you MUST call sandbox.destroy() when done");
      // skipping it leaves the instance to idle out (~10 min default), billing
      // container minutes long after a ~45s check finished. Best-effort — a
      // failed teardown must not flip an otherwise-recorded result.
      if (sandbox) await sandbox.destroy().catch(() => {});
      // Best-effort delete of the per-run ingest key (single-use; no audit
      // value). A lingering key is a tolerable leak, never a reason to fail the
      // recorded execution.
      await revokeSyntheticKey(key.id, Math.floor(Date.now() / 1000)).catch(
        () => {},
      );
    }
  }
}

/** Wrap an unexpected error as a retryable infra-error result. */
function infraError(err: unknown, durationMs: number): ExecutionResult {
  return {
    state: "error",
    runId: null,
    durationMs,
    errorMessage: err instanceof Error ? err.message : String(err),
    infraError: true,
  };
}
