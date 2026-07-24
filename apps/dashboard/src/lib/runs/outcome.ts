/**
 * The Outcome column's denominator math, extracted from `<RunListRow>` so the
 * clamp rules are unit-testable without rendering.
 *
 * `total` — the bar denominator / `/N` figure — is the full declared suite
 * size, not just what has reported so far:
 *   - `expectedTotalTests` is the reporter's `onBegin` count. For a sharded
 *     run ingest re-derives it as the sum over per-shard counts
 *     (`runs.shardExpectedTests`) as each shard opens, so it converges on the
 *     exact suite total.
 *   - `totalTests` backstops legacy runs (null column) and a mixed-version
 *     fleet whose opener predates shard-aware opens (its slice is missing
 *     from the map, so the sum undercounts).
 *   - the reported-buckets floor keeps the bar sane if a run over-reports.
 *
 * `pending` is the not-yet-reported remainder — tests still queued behind a
 * streaming run, or never run at all on an interrupted one.
 */
export interface RunOutcomeCounts {
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  totalTests: number;
  expectedTotalTests: number | null;
}

export function runOutcomeTotals(run: RunOutcomeCounts): {
  reported: number;
  total: number;
  pending: number;
} {
  const reported = run.passed + run.failed + run.flaky + run.skipped;
  const total = Math.max(run.expectedTotalTests ?? 0, run.totalTests, reported);
  return { reported, total, pending: total - reported };
}
