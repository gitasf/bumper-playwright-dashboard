import type { Monitor, MonitorExecution } from "@schema";

export type { Monitor, MonitorExecution };

/**
 * Monitor kinds. v1 ships only `"browser"` (a scheduled Playwright run).
 * `"http" | "tcp" | "ping"` are reserved for the later Checkly-style uptime
 * family, which reuses the scheduler + execution record with a lighter executor.
 */
export type MonitorType = "browser" | "http" | "tcp" | "ping";

/**
 * The queue/executor family partition over {@link MonitorType}, defined once:
 * the lightweight uptime family (`http`, `tcp`, `ping` — raw connects, no
 * container) vs the container-backed `browser` family. Both the sweep's queue
 * routing (`crons/sweep-monitors.ts`) and the consumers' executor dispatch
 * (`executor-registry.ts`) derive from this, so the partition can't drift.
 * Takes a plain string (the DB column isn't narrowed); anything unknown falls
 * to `"browser"`, matching both call sites' historical defaults.
 */
export function monitorFamily(type: string): "uptime" | "browser" {
  return type === "http" || type === "tcp" || type === "ping"
    ? "uptime"
    : "browser";
}

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
 * One assertion's evaluated outcome, stored in {@link HttpResultDetail}. `actual`
 * is the observed value stringified for display (e.g. the status code, a header
 * value, a response time in ms); `null` when the source had nothing to read
 * (e.g. a missing header / JSON path). `source`/`comparison` are kept as plain
 * strings (not the zod enums) so this storage/display type carries no dependency
 * on the validation module.
 */
export interface AssertionResult {
  source: string;
  property: string | null;
  comparison: string;
  target: string;
  actual: string | null;
  pass: boolean;
}

/**
 * Inline result detail for an `http` (uptime) execution — serialized as JSON
 * into `monitorExecutions.resultDetail`. A browser execution stores `null` here
 * (its detail lives in the linked `runs` row). The detail page parses this back
 * to render per-assertion results, timing phases, and the redirect chain.
 *
 * `bodyExcerpt` is present only when a body assertion FAILED (so a user can see
 * what came back) and is capped to ≤2 KiB by the executor — never the full body.
 */
export interface HttpResultDetail {
  assertions: AssertionResult[];
  timings: {
    /** Time to first byte (headers received), ms. Null if not measurable. */
    ttfbMs: number | null;
    /** Body download time after headers, ms. Null if not measurable. */
    downloadMs: number | null;
    /** Total wall-clock of the check, ms. */
    totalMs: number;
  };
  redirected: boolean;
  finalUrl: string;
  bodyExcerpt?: string;
}

/**
 * Inline result detail for a `tcp` / `ping` execution — serialized as JSON into
 * `monitorExecutions.resultDetail`, the TCP twin of {@link HttpResultDetail}. A
 * TCP check has no HTTP response, so it carries only the connection facts: the
 * host:port it dialed and the time the raw socket took to OPEN (TCP handshake
 * completing). The detail page renders these instead of the http
 * status/assertion view.
 *
 * Workers cannot send ICMP, so a `ping`-type monitor is modelled as the SAME
 * TCP-connect probe — see `tcp/tcp-run.ts` for the full rationale; the detail
 * shape is identical for both.
 */
export interface TcpResultDetail {
  host: string;
  port: number;
  timings: {
    /** Time for the TCP connection to open (handshake), ms. */
    connectMs: number;
    /** Total wall-clock of the check, ms (connect + close). */
    totalMs: number;
  };
}

/**
 * The inline result detail an http OR tcp execution stores on
 * `monitorExecutions.resultDetail`. A browser execution stores `null` (its
 * detail lives in the linked `runs` row). Discriminated structurally by the
 * detail-parsers, NOT by a tag field — each type's executor writes its own
 * shape, and the matching read-path parser (`parseHttpResultDetail` /
 * `parseTcpResultDetail`) validates it.
 */
export type MonitorResultDetail = HttpResultDetail | TcpResultDetail;

/**
 * Outcome of executing one monitor attempt, returned by a {@link MonitorExecutor}.
 *
 * `infraError` is the load-bearing distinction for the queue consumer:
 *   - `false` → the monitor RAN and we observed an outcome (incl. an app
 *     failure / "site is down"). Record it and `ack()` — this is a normal
 *     result, not a delivery failure.
 *   - `true` → we could not execute the monitor (sandbox unavailable, token
 *     mint failed, transient infra). The consumer should `retry()` the message.
 *
 * `statusCode` is filled by the `http` executor only (null for tcp/browser).
 * `resultDetail` is filled by the `http` AND `tcp`/`ping` executors (each its
 * own shape — {@link HttpResultDetail} / {@link TcpResultDetail}) and is `null`
 * for `browser` executions (whose rich detail lives in the linked run).
 */
export interface ExecutionResult {
  state: TerminalExecutionState;
  /** The `runs.id` this execution produced (browser type); null otherwise. */
  runId: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  infraError: boolean;
  /** HTTP response status code (http type); null for tcp / browser / no response. */
  statusCode: number | null;
  /** Inline result detail (http or tcp type); null for browser. */
  resultDetail: MonitorResultDetail | null;
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
