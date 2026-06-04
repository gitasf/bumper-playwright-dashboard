import { defineHandler, type InferProps } from "void";
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
import { runScopeWhere } from "@/lib/scope";
import { requireTenantContext } from "@/lib/tenant-context";

export type Props = InferProps<typeof loader>;

const RANGES = ["7d", "14d", "30d", "90d"] as const;
const parseRange = makeRangeParser(RANGES, "30d");

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

  const aggConditions = [
    runScopeWhere(scope),
    gte(runs.createdAt, windowStartSec),
  ];
  if (branchFilter) aggConditions.push(eq(runs.branch, branchFilter));

  // Drizzle's groupBy accepts an SQL fragment; we reuse the same `expr`
  // both in the SELECT (aliased "bucket") and the GROUP BY.
  const aggRows = await db
    .select({
      bucket: expr,
      passed: sql<number>`sum(passed)`,
      failed: sql<number>`sum(failed)`,
      flaky: sql<number>`sum(flaky)`,
      skipped: sql<number>`sum(skipped)`,
      runs: sql<number>`count(*)`,
    })
    .from(runs)
    .where(and(...aggConditions))
    .groupBy(expr);

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
    days,
    nowSec,
    windowStartSec,
    branchParam,
    branches,
    pathname: url.pathname,
    aggRows,
    segments: SEGMENTS as readonly string[],
    ranges: RANGES as readonly string[],
  };
});
