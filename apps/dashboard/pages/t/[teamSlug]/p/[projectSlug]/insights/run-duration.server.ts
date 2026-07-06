import { defer, defineHandler, type InferProps } from "void";
import { sql } from "void/db";
import {
  parseSegment,
  SEGMENTS,
  type Segment,
} from "@/lib/analytics/bucketing";
import { bucketExpr, percentilePick } from "@/lib/analytics/bucketing-sql";
import { branchFragment, ciRunsScopeRawWhere } from "@/lib/analytics/filters";
import {
  normalizeBranchFilter,
  resolveAnalyticsWindow,
} from "@/lib/analytics/params";
import { makeRangeParser } from "@/lib/analytics/range";
import { loadProjectBranches } from "@/lib/branches-query";
import { runRow, runRows } from "@/lib/db-run";
import { requireTenantContext } from "@/lib/tenant-context";

export type Props = InferProps<typeof loader>;

type RangeKey = "7d" | "14d" | "30d" | "90d";
const RANGES: readonly RangeKey[] = ["7d", "14d", "30d", "90d"];
const parseRange = makeRangeParser<RangeKey>(RANGES, "30d");

function defaultSegmentForRange(range: RangeKey): Segment {
  return range === "90d" ? "week" : "day";
}

export interface PerBucketDurationRow {
  bucket: number | string;
  cnt: number;
  p50: number | null;
  p90: number | null;
  p95: number | null;
}

export interface OverallDurationStats {
  cnt: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
}

/**
 * Run duration loader. Two CTE queries:
 *   - perBucket: discrete-percentile picks by bucket (p50/p90/p95).
 *   - overall: same picks across the entire window (KPI cards).
 *
 * Discrete percentile picker: `MIN(CASE WHEN rn = MAX(1, ROUND(cnt * q)) ...)`
 * — keeps the target rank in [1..cnt] so a single-run bucket still resolves.
 */
export const loader = defineHandler(async (c) => {
  const { project, scope } = requireTenantContext(c);

  const url = new URL(c.req.url);
  const range = parseRange(url.searchParams.get("range"));
  const segment = parseSegment(
    url.searchParams.get("segment"),
    defaultSegmentForRange(range),
  );
  const { branchParam, branchFilter } = normalizeBranchFilter(
    url.searchParams.get("branch"),
  );
  const {
    nowSec,
    windowStartSec,
    days: windowDays,
  } = resolveAnalyticsWindow(range);
  const days = windowDays ?? 30;
  const expr = bucketExpr(segment);

  const branches = await loadProjectBranches(scope);
  const branchSql = branchFragment(branchFilter);

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

    // Both percentile passes stream behind skeletons. Grouped in ONE resolver
    // so the KPI values (`overall`) and their per-bucket sparklines + the chart
    // (`perBucket`) can't tear. Returns plain rows only — the chart builds its
    // JSX (buckets + tooltips) in the client child that reads this via `use()`.
    duration: defer(async () => {
      const perBucket = await runRows<PerBucketDurationRow>(sql`
        with ranked as (
          select
            ${expr} as bucket,
            runs."durationMs" as duration,
            row_number() over (partition by ${expr} order by runs."durationMs") as rn,
            count(*) over (partition by ${expr}) as cnt
          from runs
          ${ciRunsScopeRawWhere(scope)}
            and runs."durationMs" > 0
            and runs."createdAt" >= ${windowStartSec}
            ${branchSql}
        )
        select
          bucket,
          cast(max(cnt) as integer) as cnt,
          ${percentilePick(0.5)} as p50,
          ${percentilePick(0.9)} as p90,
          ${percentilePick(0.95)} as p95
        from ranked
        group by bucket
      `);

      const overall: OverallDurationStats =
        (await runRow<OverallDurationStats>(sql`
        with ranked as (
          select
            runs."durationMs" as duration,
            row_number() over (order by runs."durationMs") as rn,
            count(*) over () as cnt
          from runs
          ${ciRunsScopeRawWhere(scope)}
            and runs."durationMs" > 0
            and runs."createdAt" >= ${windowStartSec}
            ${branchSql}
        )
        select
          cast(max(cnt) as integer) as cnt,
          ${percentilePick(0.5)} as p50,
          ${percentilePick(0.9)} as p90,
          ${percentilePick(0.95)} as p95
        from ranked
      `)) ?? { cnt: 0, p50: null, p90: null, p95: null };

      return { perBucket, overall };
    }),
  };
});
