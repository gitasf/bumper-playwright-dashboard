import { defer, defineHandler, type InferProps } from "void";
import { and, db, desc, eq, gte, sql } from "void/db";
import { runs, testResults, testTags } from "@schema";
import {
  alignBuckets,
  DAY_SEC,
  parseSegment,
  SEGMENTS,
  type Segment,
} from "@/lib/analytics/bucketing";
import { bucketExpr } from "@/lib/analytics/bucketing-sql";
import {
  branchFragment,
  ciRunsJoinFragment,
  ciRunsJoinOn,
} from "@/lib/analytics/filters";
import { intAggExpr, numericSql } from "@/lib/db/sql-ops";
import { runRow } from "@/lib/db-run";
import {
  normalizeBranchFilter,
  resolveAnalyticsWindow,
} from "@/lib/analytics/params";
import { makeRangeParser } from "@/lib/analytics/range";
import { loadProjectBranches } from "@/lib/branches-query";
import { rate } from "@/lib/rate";
import { childProjectScopeWhere, ciRunsScopeWhere } from "@/lib/scope";
import { requireTenantContext } from "@/lib/tenant-context";

export type Props = InferProps<typeof loader>;

/** One peak-suite-size sample per segment bucket. */
export interface TrendRow {
  bucket: number | string;
  peak: number;
}

/** The finished "suite size" KPI shape the page presents: the populated-bucket
 *  peak series for the sparkline, plus first/last/net-change/growth derived
 *  from it. PURE over the trend rows + alignment window. */
export interface SuiteSizeKpis {
  /** Per-bucket peaks for the "Total tests" sparkline — populated buckets only,
   *  in bucket order. */
  peakSpark: number[];
  firstPeak: number;
  lastPeak: number;
  netChange: number;
  /** Growth from first→last populated peak, as a 0..100 percentage. */
  growthPct: number;
}

/**
 * Roll the per-bucket peak trend into the "Total tests" KPI numbers. Lives in
 * the loader (not the page body) so the metric definition — net change and
 * growth across the populated buckets in the window — is computed once, in one
 * testable place, and the page is a pure presenter. The peak series is the
 * window's populated buckets in order (empty buckets dropped, mirroring the
 * sparkline), and the divide-by-zero policy is owned by `rate()`.
 */
export function summarizeSuiteSizeKpis(
  segment: Segment,
  windowStartSec: number,
  nowSec: number,
  trendRows: readonly TrendRow[],
): SuiteSizeKpis {
  // Per-bucket peak series for the sparkline. Align onto the window skeleton,
  // then drop empty buckets so the series only plots populated ones.
  const peakSpark = alignBuckets(segment, windowStartSec, nowSec, trendRows)
    .map((s) => s.row?.peak)
    .filter((v): v is number => v != null);
  const firstPeak = peakSpark[0] ?? 0;
  const lastPeak = peakSpark.at(-1) ?? firstPeak;
  const netChange = lastPeak - firstPeak;
  const growthPct = rate(netChange, firstPeak);
  return { peakSpark, firstPeak, lastPeak, netChange, growthPct };
}

type RangeKey = "7d" | "14d" | "30d" | "90d";
const RANGES: readonly RangeKey[] = ["7d", "14d", "30d", "90d"];
const parseRange = makeRangeParser<RangeKey>(RANGES, "30d");

const DISTRIBUTION_LIMIT = 10;
const TAG_LIMIT = 12;
const ADDED_LOOKBACK_DAYS = 30;

function defaultSegmentForRange(range: RangeKey): Segment {
  if (range === "7d") return "day";
  if (range === "30d") return "day";
  if (range === "90d") return "week";
  return "month";
}

/**
 * Suite size loader. Four query passes:
 *   1. Peak suite size per bucket — max(totalTests) grouped by segment.
 *   2. Earliest run timestamp (for "all" range shells).
 *   3. Tests Added (last N days) — distinct testIds with first-ever run in window.
 *   4. Distribution by spec file + top tags.
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

  const { nowSec, windowStartSec, rangeSec } = resolveAnalyticsWindow(range);
  // This page's ranges are all bounded (7d/14d/30d/90d) — never "all" — so the
  // window always has a concrete lower bound and there is no earliest-run
  // lookup to run. `resolveAnalyticsWindow` documents this invariant.
  const shellStartSec = windowStartSec;
  const expr = bucketExpr(segment);

  // ciRunsScopeWhere: tenant pair + `origin <> 'synthetic'` — suite-size
  // trends CI history only; monitor runs (whose totalTests reflects the
  // monitor's own suite) must not set the per-bucket peak.
  const trendConditions = [
    ciRunsScopeWhere(scope),
    gte(runs.createdAt, windowStartSec),
  ];
  if (branchFilter) trendConditions.push(eq(runs.branch, branchFilter));

  const trendQuery = db
    .select({
      bucket: expr,
      peak: sql<number>`max(${runs.totalTests})`,
    })
    .from(runs)
    .where(and(...trendConditions))
    .groupBy(expr);

  const addedLookbackSec = nowSec - ADDED_LOOKBACK_DAYS * DAY_SEC;
  // "Tests added in the lookback" = tests that appear in the window AND never
  // appeared before it. Equivalent to the old `min(createdAt) >= lookback` over
  // ALL history, but bounded: the recent set is scanned via the
  // (projectId, createdAt) index and each first-seen check is an index seek on
  // (testId, createdAt) — instead of grouping the project's entire testResults
  // history on every render. The recent set joins `runs` unconditionally via
  // ciRunsJoinFragment so monitor-run results never count as "added"; the
  // branch filter scopes it further (which branch the test appeared on),
  // mirroring the trend query. The NOT EXISTS first-seen check stays
  // project-wide (all origins) so "added" still means brand-new.
  const testsAddedQuery = runRow<{ added?: number }>(sql`
    select ${intAggExpr("count(*)", { alias: "added" })}
    from (
      select distinct tr."testId" as "testId"
      from "testResults" tr
      ${ciRunsJoinFragment()}
      where tr."projectId" = ${scope.projectId}
        and tr."createdAt" >= ${addedLookbackSec}
        ${branchFragment(branchFilter)}
    ) recent
    where not exists (
      select 1
      from "testResults" prev
      where prev."projectId" = ${scope.projectId}
        and prev."testId" = recent."testId"
        and prev."createdAt" < ${addedLookbackSec}
    )
  `);

  // File / tag distributions join `runs` unconditionally via ciRunsJoinOn —
  // the synthetic exclusion lives in the ON clause, so monitor-run results
  // can't enter the distributions even with no branch filter active. (The old
  // conditional join skipped the per-row PK probe when no branch was set; that
  // perf nicety is gone because the join is now load-bearing for correctness.)
  const distributionConditions = [
    childProjectScopeWhere(testResults.projectId, scope),
    gte(testResults.createdAt, windowStartSec),
  ];
  if (branchFilter) distributionConditions.push(eq(runs.branch, branchFilter));

  const fileQuery = db
    .select({
      file: testResults.file,
      tests: numericSql(sql`count(distinct ${testResults.testId})`),
    })
    .from(testResults)
    .innerJoin(runs, ciRunsJoinOn())
    .where(and(...distributionConditions))
    .groupBy(testResults.file)
    .orderBy(desc(sql`count(distinct ${testResults.testId})`))
    .limit(DISTRIBUTION_LIMIT);

  const tagQuery = db
    .select({
      tag: testTags.tag,
      tests: numericSql(sql`count(distinct ${testResults.testId})`),
    })
    .from(testTags)
    .innerJoin(testResults, eq(testResults.id, testTags.testResultId))
    .innerJoin(runs, ciRunsJoinOn())
    .where(and(...distributionConditions))
    .groupBy(testTags.tag)
    .orderBy(desc(sql`count(distinct ${testResults.testId})`))
    .limit(TAG_LIMIT);

  // Shell data: the branch filter list is cheap (index-covered DISTINCT) and
  // drives the always-visible header control, so it stays eager. Every heavy
  // pass below is deferred behind its own Suspense boundary on the page, so the
  // header/tabs/filters paint immediately and each region streams in.
  const branches = await loadProjectBranches(scope);

  // A deferred loader streams its body — NDJSON on SPA nav, chunked HTML on a
  // document load — and Void keys the two variants with `Vary: X-VoidPages`.
  // SWR/max-age caching of that streamed, variant-specific response lets the
  // browser replay the wrong variant: a cached NDJSON payload served for a
  // top-level navigation downloads as a file instead of rendering. Deferred
  // pages must not be stored; the perceived-load win now comes from streaming,
  // not from the cache. (Was `private, max-age=300, stale-while-revalidate=900`
  // when this loader returned a single non-streamed response — see worklog §4.)
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
    rangeSec,
    nowSec,
    shellStartSec,
    branchParam,
    branches,
    addedLookbackDays: ADDED_LOOKBACK_DAYS,
    pathname: url.pathname,
    segments: SEGMENTS as readonly string[],
    ranges: RANGES,

    // Trend cluster (chart + "Total tests" / "Net change" KPIs) — one query,
    // grouped so the derived KPI shape can't tear from the rows it summarizes.
    // KPI assembly stays server-side (as before) so the metric definition lives
    // in one testable place; the page just renders the resolved shape.
    trend: defer(async () => {
      const rows = await trendQuery;
      const trendRows: TrendRow[] = rows.map((r) => ({
        bucket: r.bucket,
        peak: r.peak ?? 0,
      }));
      const peakOverall = Math.max(0, ...trendRows.map((r) => r.peak));
      const kpis = summarizeSuiteSizeKpis(
        segment,
        shellStartSec,
        nowSec,
        trendRows,
      );
      return { trendRows, peakOverall, kpis };
    }),

    // "Tests added" — the heaviest pass (distinct scan + project-wide
    // NOT EXISTS). Its own boundary so it never gates the lighter trend cluster.
    testsAdded: defer(async () => (await testsAddedQuery)?.added ?? 0),

    // Bottom-of-page distribution cards — grouped: two independent counts run
    // in parallel inside one resolver, one skeleton for the whole section.
    distribution: defer(async () => {
      const [fileRows, tagRows] = await Promise.all([fileQuery, tagQuery]);
      const fileTotal = fileRows.reduce((acc, r) => acc + r.tests, 0);
      return { fileRows, tagRows, fileTotal };
    }),
  };
});
