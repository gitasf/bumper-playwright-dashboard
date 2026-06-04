import { defineHandler, type InferProps } from "void";
import { and, db, eq, gte, inArray, sql } from "void/db";
import { runs, testResults, testTags } from "@schema";
import {
  branchFragment,
  branchJoinFragment,
  testResultsScopeJoin,
} from "@/lib/analytics/filters";
import {
  normalizeBranchFilter,
  resolveAnalyticsWindow,
} from "@/lib/analytics/params";
import { latestPerTestRn } from "@/lib/analytics/per-test";
import { makeRangeParser } from "@/lib/analytics/range";
import { loadProjectBranches } from "@/lib/branches-query";
import type { TenantScope } from "@/lib/scope";
import { requireTenantContext } from "@/lib/tenant-context";

export type Props = InferProps<typeof loader>;

const TOP_N = 50;
const SPARKLINE_SIZE = 20;
const RECENT_FAILURES = 3;

type RangeKey = "7d" | "14d" | "30d";
const RANGES: readonly RangeKey[] = ["7d", "14d", "30d"];
const parseRange = makeRangeParser<RangeKey>(RANGES, "14d");

export interface RankedTest {
  testId: string;
  total: number;
  flakyCount: number;
  passedCount: number;
  pct: number;
}

export interface FlakyTestMeta {
  title: string;
  file: string;
  tags: string[];
  sparkline: { status: string }[];
}

export interface RecentFailureRow {
  testResultId: string;
  runId: string;
  commitSha: string | null;
  branch: string | null;
  actor: string | null;
  createdAt: number;
  errorMessage: string | null;
  errorStack: string | null;
}

/**
 * Flaky tests loader. Three serial passes:
 *  1. Aggregate per testId across the window — flakyCount / passedCount /
 *     total. Filter to tests that have at least one flaky result.
 *  2. Sparkline (last 20 statuses) + latest title/file for the page slice.
 *  3. Recent failures (last 3 flaky/failed/timedout) per testId.
 */
export const loader = defineHandler(async (c) => {
  const { project, scope } = requireTenantContext(c);

  const url = new URL(c.req.url);
  const range = parseRange(url.searchParams.get("range"));
  const { branchParam, branchFilter, branchAll } = normalizeBranchFilter(
    url.searchParams.get("branch"),
  );

  const { windowStartSec, days } = resolveAnalyticsWindow(range);
  const rangeDays = days ?? 0;

  const branches = await loadProjectBranches(scope);

  // 1. Aggregates.
  const aggConditions = [
    eq(testResults.projectId, scope.projectId),
    gte(testResults.createdAt, windowStartSec),
  ];
  if (branchFilter) aggConditions.push(eq(runs.branch, branchFilter));

  // Join `runs` only when a branch filter needs `runs.branch`. Otherwise the
  // join is a no-op (`runId` is a NOT NULL FK) that adds a `runs` PK probe per
  // scanned testResults row; `(projectId, createdAt)` already prunes the window
  // and `(testId, createdAt)` serves the GROUP BY without a sort.
  const aggBase = db
    .select({
      testId: testResults.testId,
      total: sql<number>`sum(case when ${testResults.status} != 'skipped' then 1 else 0 end)`,
      flakyCount: sql<number>`sum(case when ${testResults.status} = 'flaky' then 1 else 0 end)`,
      passedCount: sql<number>`sum(case when ${testResults.status} = 'passed' then 1 else 0 end)`,
    })
    .from(testResults)
    .$dynamic();

  const aggRows = await (
    branchFilter
      ? aggBase.innerJoin(runs, eq(runs.id, testResults.runId))
      : aggBase
  )
    .where(and(...aggConditions))
    .groupBy(testResults.testId)
    .having(
      sql`sum(case when ${testResults.status} = 'flaky' then 1 else 0 end) >= 1`,
    );

  const rankedAll: RankedTest[] = aggRows
    .map((r) => {
      const denom = r.flakyCount + r.passedCount;
      const pct = denom === 0 ? 0 : (r.flakyCount / denom) * 100;
      return { ...r, pct };
    })
    .sort((a, b) => b.pct - a.pct || b.flakyCount - a.flakyCount);

  const totalFlakyTests = rankedAll.length;
  const ranked = rankedAll.slice(0, TOP_N);
  const truncated = totalFlakyTests > ranked.length;
  const testIds = ranked.map((r) => r.testId);

  // 2 + 3 in parallel.
  const sparkByTest = new Map<string, FlakyTestMeta>();
  const failsByTest = new Map<string, RecentFailureRow[]>();

  if (testIds.length > 0) {
    const [sparkRows, failRows, tagRows] = await Promise.all([
      loadSparklinesAndMeta(scope, testIds, branchFilter, SPARKLINE_SIZE),
      loadRecentFailures(scope, testIds, branchFilter, RECENT_FAILURES),
      loadTagsByTestId(scope.projectId, testIds),
    ]);
    for (const r of sparkRows) {
      let entry = sparkByTest.get(r.testId);
      if (!entry) {
        entry = { sparkline: [], title: r.title, file: r.file, tags: [] };
        sparkByTest.set(r.testId, entry);
      }
      if (r.rn === 1) {
        entry.title = r.title;
        entry.file = r.file;
      }
      entry.sparkline.push({ status: r.status });
    }
    for (const r of tagRows) {
      const entry = sparkByTest.get(r.testId);
      if (entry && !entry.tags.includes(r.tag)) {
        entry.tags.push(r.tag);
      }
    }
    for (const r of failRows) {
      let entry = failsByTest.get(r.testId);
      if (!entry) {
        entry = [];
        failsByTest.set(r.testId, entry);
      }
      entry.push({
        testResultId: r.testResultId,
        runId: r.runId,
        commitSha: r.commitSha,
        branch: r.branch,
        actor: r.actor,
        createdAt: r.createdAt,
        errorMessage: r.errorMessage,
        errorStack: r.errorStack,
      });
    }
  }

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
    branchParam,
    branchAll,
    branchFilter,
    branches,
    rangeDays,
    totalFlakyTests,
    truncated,
    ranked,
    // Convert maps to plain objects for serialization.
    sparkByTest: Object.fromEntries(sparkByTest),
    failsByTest: Object.fromEntries(failsByTest),
    pathname: url.pathname,
    ranges: RANGES,
  };
});

interface SparklineMetaRow {
  testId: string;
  status: string;
  title: string;
  file: string;
  rn: number;
}

/**
 * Per-test sparkline + latest title/file using a row_number() CTE.
 * Drizzle doesn't have a typed CTE builder, so this is a single raw-SQL
 * query that returns the same shape the rwsdk version produced.
 */
async function loadSparklinesAndMeta(
  scope: TenantScope,
  testIds: readonly string[],
  branch: string | null,
  sparklineSize: number,
): Promise<SparklineMetaRow[]> {
  const branchSql = branchFragment(branch);
  // The runs join is conditional here (only needed when a branch filter is
  // active), so this query keeps its own branchJoinFragment + tenant predicate
  // pairing rather than testResultsScopeJoin (whose join is unconditional). The
  // branded scope still bakes the auth-checked projectId in as a bound param.
  const joinSql = branchJoinFragment(branch);

  const result = await db.run(sql`
    with ranked as (
      select
        tr."testId" as "testId",
        tr.status as status,
        tr.title as title,
        tr.file as file,
        ${latestPerTestRn("rn")}
      from "testResults" tr
      ${joinSql}
      where tr."projectId" = ${scope.projectId}
        and tr."testId" in (${sql.join(
          testIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        ${branchSql}
    )
    select "testId", status, title, file, rn
    from ranked
    where rn <= ${sparklineSize}
    order by "testId" asc, rn desc
  `);

  return (result.results as SparklineMetaRow[]) ?? [];
}

interface RecentFailureSqlRow {
  testId: string;
  testResultId: string;
  runId: string;
  createdAt: number;
  errorMessage: string | null;
  errorStack: string | null;
  commitSha: string | null;
  branch: string | null;
  actor: string | null;
  rn: number;
}

async function loadRecentFailures(
  scope: TenantScope,
  testIds: readonly string[],
  branch: string | null,
  count: number,
): Promise<RecentFailureSqlRow[]> {
  const branchSql = branchFragment(branch);

  const result = await db.run(sql`
    with ranked as (
      select
        tr."testId" as "testId",
        tr.id as "testResultId",
        tr."runId" as "runId",
        tr."createdAt" as "createdAt",
        tr."errorMessage" as "errorMessage",
        tr."errorStack" as "errorStack",
        runs."commitSha" as "commitSha",
        runs.branch as branch,
        runs.actor as actor,
        ${latestPerTestRn("rn")}
      from "testResults" tr
      ${testResultsScopeJoin(scope)}
        and tr."testId" in (${sql.join(
          testIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        and tr.status in ('flaky', 'failed', 'timedout')
        ${branchSql}
    )
    select "testId", "testResultId", "runId", "createdAt",
           "errorMessage", "errorStack", "commitSha", branch, actor, rn
    from ranked
    where rn <= ${count}
    order by "testId" asc, rn asc
  `);

  // Silence unused-import warnings — `inArray` would be the Drizzle equivalent
  // of the `testId in (...)` clause if we weren't going through `sql.join`.
  void inArray;

  return (result.results as RecentFailureSqlRow[]) ?? [];
}

interface TagRow {
  testId: string;
  tag: string;
}

/**
 * Distinct (testId, tag) pairs for the requested testIds. Tags hang off
 * `testResults` rows (one row per attempt) but are stable per testId in
 * practice, so we dedupe across all attempts and surface the set.
 */
async function loadTagsByTestId(
  projectId: string,
  testIds: readonly string[],
): Promise<TagRow[]> {
  const result = await db.run(sql`
    select distinct tr."testId" as "testId", tt.tag as tag
    from ${testTags} tt
    inner join ${testResults} tr on tr.id = tt."testResultId"
    where tr."projectId" = ${projectId}
      and tr."testId" in (${sql.join(
        testIds.map((id) => sql`${id}`),
        sql`, `,
      )})
  `);

  return (result.results as TagRow[]) ?? [];
}
