import type { RunHistoryPoint } from "@/components/run/history-chart";
import { statusGroupKey } from "@/lib/status";
import { formatDuration, formatRelativeTime } from "@/lib/time-format";

/**
 * The minimal per-result row a test's history is built from. Both the
 * run-scoped result-detail loader and the test-level history loader return (at
 * least) these columns, newest-first.
 */
export interface TestHistoryRow {
  testResultId: string;
  runId: string;
  status: string;
  durationMs: number;
  createdAt: number;
  branch: string | null;
  commitSha: string | null;
}

/** Pass/fail/flaky summary over the visible history window. */
export interface TestHistoryStats {
  /** Non-skipped results that actually ran. */
  ran: number;
  failed: number;
  flaky: number;
  /** Pass % over `ran` (0 ran → 100). */
  passPct: number;
}

export interface TestHistoryView {
  /** Chronological (oldest → newest) — the order `RunHistoryChart` plots. */
  points: RunHistoryPoint[];
  stats: TestHistoryStats;
}

/**
 * Turn a test's recent results into `RunHistoryChart` inputs. The single owner
 * of the per-test history bar's label / hover / href shape AND the pass/fail/
 * flaky bucketing, shared by the run-scoped result-detail page and the
 * test-level history page (both previously hand-rolled an identical copy).
 *
 * Status is bucketed through the canonical {@link statusGroupKey}, so
 * `timedout → failed` and `interrupted → flaky` are counted correctly — the
 * hand-rolled `status !== "skipped"` / `=== "failed"` checks silently scored
 * `interrupted` as a pass.
 *
 * `currentTestResultId` marks the result being viewed (result-detail only): its
 * bar is highlighted and doesn't self-link, but still shows its summary on
 * hover. The test-level page omits it, so every bar links to its result.
 */
export function buildTestHistoryView(
  rows: readonly TestHistoryRow[],
  opts: {
    base: string;
    teamSlug: string;
    projectSlug: string;
    currentTestResultId?: string;
  },
): TestHistoryView {
  const points: RunHistoryPoint[] = [...rows]
    .reverse()
    .map((h): RunHistoryPoint => {
      const isCurrent = h.testResultId === opts.currentTestResultId;
      return {
        id: h.testResultId,
        durationMs: h.durationMs,
        status: h.status,
        current: isCurrent || undefined,
        href: isCurrent
          ? undefined
          : `${opts.base}/runs/${h.runId}/tests/${h.testResultId}`,
        // Current bar still hovers to its summary; only the self-link is dropped.
        hover: {
          kind: "testResult",
          teamSlug: opts.teamSlug,
          projectSlug: opts.projectSlug,
          runId: h.runId,
          testResultId: h.testResultId,
        },
        label: [
          h.status,
          formatDuration(h.durationMs),
          formatRelativeTime(h.createdAt),
          h.branch,
          h.commitSha ? h.commitSha.slice(0, 7) : null,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    });

  let ran = 0;
  let failed = 0;
  let flaky = 0;
  for (const h of rows) {
    const bucket = statusGroupKey(h.status);
    if (bucket === null || bucket === "skipped") continue;
    ran++;
    if (bucket === "failed") failed++;
    else if (bucket === "flaky") flaky++;
  }
  const passPct =
    ran === 0 ? 100 : Math.round(((ran - failed - flaky) / ran) * 100);

  return { points, stats: { ran, failed, flaky, passPct } };
}
