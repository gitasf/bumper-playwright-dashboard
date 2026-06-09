import type { Monitor, MonitorExecution } from "@schema";

export type { Monitor, MonitorExecution };

/**
 * Monitor kinds. v1 ships only `"browser"` (a scheduled Playwright run).
 * `"http" | "tcp" | "ping"` are reserved for the later Checkly-style uptime
 * family, which reuses the scheduler + execution record with a lighter executor.
 */
export type MonitorType = "browser" | "http" | "tcp" | "ping";

/** Terminal + transient states of a single monitor execution attempt. */
export type ExecutionState =
  | "queued"
  | "running"
  | "pass"
  | "degraded"
  | "fail"
  | "error";

/** Terminal states only (what an {@link ExecutionResult} can settle to). */
export type TerminalExecutionState = Exclude<
  ExecutionState,
  "queued" | "running"
>;

/**
 * Queue message body for `queues/monitors.ts`. Deliberately tiny — IDs only —
 * so it stays far under Cloudflare's 128 KB message cap; the consumer loads the
 * monitor source + config from D1. NEVER inline the Playwright source here.
 */
export interface MonitorJob {
  monitorId: string;
  executionId: string;
  /** Epoch-seconds tick this job was scheduled for (idempotency / drift checks). */
  scheduledFor: number;
}

/**
 * Outcome of executing one monitor attempt, returned by a {@link MonitorExecutor}.
 *
 * `infraError` is the load-bearing distinction for the queue consumer:
 *   - `false` → the monitor RAN and we observed an outcome (incl. an app
 *     failure / "site is down"). Record it and `ack()` — this is a normal
 *     result, not a delivery failure.
 *   - `true` → we could not execute the monitor (sandbox unavailable, token
 *     mint failed, transient infra). The consumer should `retry()` the message.
 */
export interface ExecutionResult {
  state: TerminalExecutionState;
  /** The `runs.id` this execution produced (browser type); null otherwise. */
  runId: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  infraError: boolean;
}

/**
 * Executes one monitor attempt. Implementations:
 *   - `SandboxExecutor` (prod) — runs the user's Playwright in a Void Sandbox
 *     container; the in-container reporter streams a `run` into `/api/runs`.
 *   - `StubExecutor` (dev/test, `WRIGHTFUL_MONITOR_EXECUTOR=stub`) — synthesizes
 *     a deterministic run in-process with no container.
 *
 * Both guarantee that, for a browser execution, a `runs` row exists whose
 * `idempotencyKey === execution.id` (so the consumer can resolve `runId`).
 */
export interface MonitorExecutor {
  execute(input: {
    monitor: Monitor;
    execution: MonitorExecution;
  }): Promise<ExecutionResult>;
}
