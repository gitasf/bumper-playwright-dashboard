/**
 * Pure presentation shared by both GitHub run surfaces — the merge-gating
 * check run (`@/lib/github-checks`) and the sticky PR comment
 * (`@/lib/github-pr-comment`) — so the merge-gate decision, headline, and
 * stats table render identically on both. Everything here is PURE: no env,
 * DB, or network.
 */

export type CheckConclusion = "success" | "failure" | "neutral";

/**
 * Map a terminal run status to a check-run conclusion. The merge-gate
 * decision, unit-tested directly. `failed`/`timedout`/`interrupted` fail the
 * check (interrupted = incomplete, don't merge); `passed` succeeds even with
 * flaky retries (every test ultimately passed; the output notes the flake
 * count); anything unrecognized is `neutral` (non-blocking).
 */
export function statusToConclusion(status: string): CheckConclusion {
  switch (status) {
    case "passed":
      return "success";
    case "failed":
    case "timedout":
    case "interrupted":
      return "failure";
    default:
      return "neutral";
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  // Round to the displayed tenth BEFORE the sub-minute comparison, so 59.96s
  // carries into the minutes path instead of rendering as "60.0s".
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  // Round to whole seconds before splitting, so a leftover rounding up to 60
  // carries into the minutes place instead of rendering as "1m 60s".
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ${totalSeconds - minutes * 60}s`;
}

/** The subset of a run summary the headline title needs. */
interface RunHeadlineSummary {
  status: string;
  passed: number;
  failed: number;
  flaky: number;
}

/**
 * The "N passed, M flaky" / "N failed, M passed" headline shared by the
 * check-run title and the sticky PR comment's heading.
 */
export function runHeadline(summary: RunHeadlineSummary): string {
  return statusToConclusion(summary.status) === "success"
    ? `${summary.passed} passed${summary.flaky > 0 ? `, ${summary.flaky} flaky` : ""}`
    : `${summary.failed} failed, ${summary.passed} passed`;
}

/** The subset of a run summary the stats table needs. */
interface RunSummaryTableSummary {
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  durationMs: number;
}

/**
 * The 3-line markdown stats table shared by the check-run output and the
 * sticky PR comment.
 */
export function runSummaryTable(summary: RunSummaryTableSummary): string[] {
  return [
    `| Passed | Failed | Flaky | Skipped | Duration |`,
    `| --- | --- | --- | --- | --- |`,
    `| ${summary.passed} | ${summary.failed} | ${summary.flaky} | ${summary.skipped} | ${formatDuration(summary.durationMs)} |`,
  ];
}
