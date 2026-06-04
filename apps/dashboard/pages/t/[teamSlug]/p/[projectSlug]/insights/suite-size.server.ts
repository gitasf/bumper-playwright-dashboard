import { defineHandler, type InferProps } from "void";
import { and, db, desc, eq, gte, sql } from "void/db";
import { runs, testResults, testTags } from "@schema";
import {
  DAY_SEC,
  parseSegment,
  SEGMENTS,
  type Segment,
} from "@/lib/analytics/bucketing";
import { bucketExpr } from "@/lib/analytics/bucketing-sql";
import {
  normalizeBranchFilter,
  resolveAnalyticsWindow,
} from "@/lib/analytics/params";
import { makeRangeParser } from "@/lib/analytics/range";
import { loadProjectBranches } from "@/lib/branches-query";
import { runScopeWhere } from "@/lib/scope";
import { requireTenantContext } from "@/lib/tenant-context";

export type Props = InferProps<typeof loader>;

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

  const branches = await loadProjectBranches(scope);

  const { nowSec, windowStartSec, rangeSec } = resolveAnalyticsWindow(range);
  const expr = bucketExpr(segment);

  const trendConditions = [
    runScopeWhere(scope),
    gte(runs.createdAt, windowStartSec),
  ];
  if (branchFilter) trendConditions.push(eq(runs.branch, branchFilter));

  const trendRows = await db
    .select({
      bucket: expr,
      peak: sql<number>`max(${runs.totalTests})`,
    })
    .from(runs)
    .where(and(...trendConditions))
    .groupBy(expr);

  // For "all", find the earliest run so shells don't stretch back to 1970.
  let shellStartSec = windowStartSec;
  if (rangeSec === null) {
    const earliest = await db
      .select({ first: sql<number | null>`min(${runs.createdAt})` })
      .from(runs)
      .where(runScopeWhere(scope));
    shellStartSec = earliest[0]?.first ?? nowSec;
  }

  const addedLookbackSec = nowSec - ADDED_LOOKBACK_DAYS * DAY_SEC;
  // "Tests added in the lookback" = tests that appear in the window AND never
  // appeared before it. Equivalent to the old `min(createdAt) >= lookback` over
  // ALL history, but bounded: the recent set is scanned via the
  // (projectId, createdAt) index and each first-seen check is an index seek on
  // (testId, createdAt) — instead of grouping the project's entire testResults
  // history on every render.
  const testsAddedRow = await db.run(sql`
    select count(*) as added
    from (
      select distinct tr."testId" as "testId"
      from "testResults" tr
      where tr."projectId" = ${scope.projectId}
        and tr."createdAt" >= ${addedLookbackSec}
    ) recent
    where not exists (
      select 1
      from "testResults" prev
      where prev."projectId" = ${scope.projectId}
        and prev."testId" = recent."testId"
        and prev."createdAt" < ${addedLookbackSec}
    )
  `);
  const testsAdded =
    (testsAddedRow.results?.[0] as { added?: number } | undefined)?.added ?? 0;

  const fileRows = await db
    .select({
      file: testResults.file,
      tests: sql<number>`count(distinct ${testResults.testId})`,
    })
    .from(testResults)
    .where(
      and(
        eq(testResults.projectId, scope.projectId),
        gte(testResults.createdAt, windowStartSec),
      ),
    )
    .groupBy(testResults.file)
    .orderBy(desc(sql`count(distinct ${testResults.testId})`))
    .limit(DISTRIBUTION_LIMIT);

  const tagRows = await db
    .select({
      tag: testTags.tag,
      tests: sql<number>`count(distinct ${testResults.testId})`,
    })
    .from(testTags)
    .innerJoin(testResults, eq(testResults.id, testTags.testResultId))
    .where(
      and(
        eq(testResults.projectId, scope.projectId),
        gte(testResults.createdAt, windowStartSec),
      ),
    )
    .groupBy(testTags.tag)
    .orderBy(desc(sql`count(distinct ${testResults.testId})`))
    .limit(TAG_LIMIT);

  const peakOverall = Math.max(0, ...trendRows.map((r) => r.peak ?? 0));

  // Staleness-tolerant analytics: cache privately with SWR (see worklog §4).
  // `private` keeps tenant-scoped data out of shared/edge caches.
  c.header("Cache-Control", "private, max-age=300, stale-while-revalidate=900");
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
    trendRows: trendRows.map((r) => ({
      bucket: r.bucket,
      peak: r.peak ?? 0,
    })),
    testsAdded,
    addedLookbackDays: ADDED_LOOKBACK_DAYS,
    peakOverall,
    fileRows,
    tagRows,
    pathname: url.pathname,
    segments: SEGMENTS as readonly string[],
    ranges: RANGES as readonly string[],
  };
});
