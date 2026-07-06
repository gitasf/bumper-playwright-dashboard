import { defer, defineHandler, type InferProps } from "void";
import { and, db, eq, gte, sql } from "void/db";
import { runs } from "@schema";
import { parseSegment, SEGMENTS } from "@/lib/analytics/bucketing";
import { bucketExpr } from "@/lib/analytics/bucketing-sql";
import {
  normalizeBranchFilter,
  resolveAnalyticsWindow,
} from "@/lib/analytics/params";
import { makeRangeParser } from "@/lib/analytics/range";
import { loadProjectBranches } from "@/lib/branches-query";
import { numericSql } from "@/lib/db/sql-ops";
import { rate } from "@/lib/rate";
import { ciRunsScopeWhere } from "@/lib/scope";
import { requireTenantContext } from "@/lib/tenant-context";

export type Props = InferProps<typeof loader>;

const RANGES = ["7d", "14d", "30d", "90d"] as const;
const parseRange = makeRangeParser(RANGES, "30d");

/** One aggregated outcome bucket as the SELECT returns it (counts coerced to
 *  numbers via `numericSql`). */
export interface OutcomeAggRow {
  bucket: number | string;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  runs: number;
}

/** The finished KPI shape the page presents — pass/flake rate (0..100) plus
 *  the totals behind them. PURE over the agg rows + window length. */
export interface InsightsKpis {
  totalPassed: number;
  totalFailed: number;
  totalFlaky: number;
  totalRuns: number;
  executed: number;
  passRate: number;
  flakyRate: number;
  avgRunsPerDay: number;
}

/**
 * Roll the per-bucket outcome rows up into the landing KPI numbers. Lives in
 * the loader (not the page body) so the metric definitions — pass rate over
 * executions, flake rate over executions, avg runs over the window — are
 * computed once, in one testable place, and the page is a pure presenter. The
 * divide-by-zero policy is owned by `rate()`.
 */
export function summarizeInsightsKpis(
  rows: readonly OutcomeAggRow[],
  days: number,
): InsightsKpis {
  let totalPassed = 0;
  let totalFailed = 0;
  let totalFlaky = 0;
  let totalRuns = 0;
  for (const r of rows) {
    totalPassed += r.passed;
    totalFailed += r.failed;
    totalFlaky += r.flaky;
    totalRuns += r.runs;
  }
  const executed = totalPassed + totalFailed + totalFlaky;
  return {
    totalPassed,
    totalFailed,
    totalFlaky,
    totalRuns,
    executed,
    passRate: rate(totalPassed, executed),
    flakyRate: rate(totalFlaky, executed),
    avgRunsPerDay: days <= 0 ? 0 : totalRuns / days,
  };
}

/**
 * Insights / Run Status loader. Groups runs by the chosen segment (day /
 * week / month) and aggregates pass/fail/flaky/skipped counters per bucket
 * plus the totals row for the KPI cards.
 */
export const loader = defineHandler(async (c) => {
  const { project, scope } = requireTenantContext(c);

  const url = new URL(c.req.url);
  const range = parseRange(url.searchParams.get("range"));
  const segment = parseSegment(url.searchParams.get("segment"), "day");
  const { branchParam, branchFilter } = normalizeBranchFilter(
    url.searchParams.get("branch"),
  );
  const {
    nowSec,
    windowStartSec,
    days: windowDays,
  } = resolveAnalyticsWindow(range);
  const days = windowDays ?? 30;

  const branches = await loadProjectBranches(scope);

  const expr = bucketExpr(segment);

  // ciRunsScopeWhere: tenant pair + `origin <> 'synthetic'` — the landing-page
  // KPIs/buckets aggregate CI history only, so a 1-minute monitor's 1,440
  // runs/day can't dominate the counts.
  const aggConditions = [
    ciRunsScopeWhere(scope),
    gte(runs.createdAt, windowStartSec),
  ];
  if (branchFilter) aggConditions.push(eq(runs.branch, branchFilter));

  // Drizzle's groupBy accepts an SQL fragment; we reuse the same `expr`
  // both in the SELECT (aliased "bucket") and the GROUP BY.
  // A deferred loader streams a variant-specific body (NDJSON on SPA nav /
  // chunked HTML on document load, keyed by `Vary: X-VoidPages`); SWR/max-age
  // caching would let the browser replay the wrong variant. Deferred pages must
  // not be stored — the perceived-load win comes from streaming, not the cache.
  // (Was `private, max-age=300, stale-while-revalidate=900`.)
  c.header("Cache-Control", "private, no-store");
  return {
    project: {
      id: project.id,
      teamId: project.teamId,
      slug: project.slug,
      name: project.name,
      teamSlug: project.teamSlug,
    },
    range,
    segment,
    days,
    nowSec,
    windowStartSec,
    branchParam,
    branches,
    pathname: url.pathname,
    segments: SEGMENTS as readonly string[],
    ranges: RANGES,

    // Outcomes cluster (3 KPI cards + stacked bar chart) — one GROUP BY pass,
    // deferred as a group so the KPI numbers can't tear from the chart they
    // summarize. `kpis` assembly stays server-side (one testable place); the
    // chart builds its bucket JSX + tooltips in the client child. Plain data only.
    outcomes: defer(async () => {
      const aggRows: OutcomeAggRow[] = await db
        .select({
          bucket: expr,
          passed: numericSql(sql`sum(passed)`),
          failed: numericSql(sql`sum(failed)`),
          flaky: numericSql(sql`sum(flaky)`),
          skipped: numericSql(sql`sum(skipped)`),
          runs: numericSql(sql`count(*)`),
        })
        .from(runs)
        .where(and(...aggConditions))
        .groupBy(expr);
      const kpis = summarizeInsightsKpis(aggRows, days);
      return { aggRows, kpis };
    }),
  };
});
