import { defineHandler, type InferProps } from "void";
import { and, db, eq, gte, inArray, sql } from "void/db";
import { runs, testResults, testTags } from "@schema";
import {
  branchFragment,
  ciRunsJoinFragment,
  ciRunsJoinOn,
  testResultsScopeJoin,
} from "@/lib/analytics/filters";
import {
  normalizeBranchFilter,
  resolveAnalyticsWindow,
} from "@/lib/analytics/params";
import { latestPerTestRn } from "@/lib/analytics/per-test";
import { makeRangeParser } from "@/lib/analytics/range";
import { loadProjectBranches } from "@/lib/branches-query";
import { numericSql } from "@/lib/db/sql-ops";
import { runRows } from "@/lib/db-run";
import { rate } from "@/lib/rate";
import { type OwnerEntry, resolveTestOwners } from "@/lib/owners-repo";
import { childProjectScopeWhere, type TenantScope } from "@/lib/scope";
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

/** KPI strip numbers for the flaky page, computed over the displayed slice. */
export interface FlakyKpis {
  totalFailures: number;
  avgFlakeRate: number;
}

/**
 * Summarize the displayed flaky-test slice into the KPI strip numbers. Lives in
 * the loader so the flake-rate metric is defined in ONE place: the per-test
 * `pct` (flaky / executed) and the average across the shown rows are both here,
 * not split across the loader/page boundary. `avgFlakeRate` is the mean of the
 * per-test `pct` values (already 0..100) over the rows the page renders. PURE.
 */
export function summarizeFlakyKpis(ranked: readonly RankedTest[]): FlakyKpis {
  const totalFailures = ranked.reduce((sum, r) => sum + r.flakyCount, 0);
  const avgFlakeRate =
    ranked.length === 0
      ? 0
      : ranked.reduce((sum, r) => sum + r.pct, 0) / ranked.length;
  return { totalFailures, avgFlakeRate };
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

  // 1. Aggregates (in parallel with the independent branch-list query).
  const aggConditions = [
    childProjectScopeWhere(testResults.projectId, scope),
    gte(testResults.createdAt, windowStartSec),
  ];
  if (branchFilter) aggConditions.push(eq(runs.branch, branchFilter));

  // Join `runs` unconditionally via ciRunsJoinOn: the ON clause carries the
  // `origin <> 'synthetic'` exclusion, so monitor tests can't rank on the
  // flaky page even with no branch filter active. (The join used to be
  // branch-conditional as a perf nicety — skipping a `runs` PK probe per
  // scanned row — but it's now load-bearing for correctness.)
  const [branches, aggRows] = await Promise.all([
    loadProjectBranches(scope),
    db
      .select({
        testId: testResults.testId,
        total: numericSql(
          sql`sum(case when ${testResults.status} != 'skipped' then 1 else 0 end)`,
        ),
        flakyCount: numericSql(
          sql`sum(case when ${testResults.status} = 'flaky' then 1 else 0 end)`,
        ),
        passedCount: numericSql(
          sql`sum(case when ${testResults.status} = 'passed' then 1 else 0 end)`,
        ),
      })
      .from(testResults)
      .innerJoin(runs, ciRunsJoinOn())
      .where(and(...aggConditions))
      .groupBy(testResults.testId)
      .having(
        sql`sum(case when ${testResults.status} = 'flaky' then 1 else 0 end) >= 1`,
      ),
  ]);

  const rankedAll: RankedTest[] = aggRows
    .map((r) => ({
      ...r,
      pct: rate(r.flakyCount, r.flakyCount + r.passedCount),
    }))
    .sort((a, b) => b.pct - a.pct || b.flakyCount - a.flakyCount);

  const totalFlakyTests = rankedAll.length;
  const ranked = rankedAll.slice(0, TOP_N);
  const truncated = totalFlakyTests > ranked.length;
  const testIds = ranked.map((r) => r.testId);
  const kpis = summarizeFlakyKpis(ranked);

  // 2 + 3 in parallel.
  const sparkByTest = new Map<string, FlakyTestMeta>();
  const failsByTest = new Map<string, RecentFailureRow[]>();
  // testId → its owners (manual + CODEOWNERS-derived, manual-wins). Only
  // testIds with at least one owner appear; absent → no owner.
  const ownersByTestId: Record<string, OwnerEntry[]> = {};

  if (testIds.length > 0) {
    const [sparkRows, failRows, tagRows, ownerMap] = await Promise.all([
      loadSparklinesAndMeta(scope, testIds, branchFilter, SPARKLINE_SIZE),
      loadRecentFailures(scope, testIds, branchFilter, RECENT_FAILURES),
      loadTagsByTestId(scope.projectId, testIds),
      resolveTestOwners(scope, testIds),
    ]);
    for (const [testId, owners] of ownerMap) {
      ownersByTestId[testId] = owners;
    }
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
      // Owner-gating for the manual test-ownership assign/remove controls; the
      // mutation is owner-gated server-side too, so non-owners just see chips.
      canManageOwners: project.role === "owner",
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
    kpis,
    // Convert maps to plain objects for serialization.
    sparkByTest: Object.fromEntries(sparkByTest),
    failsByTest: Object.fromEntries(failsByTest),
    // testId → resolved owners (manual + CODEOWNERS, manual-wins) for the
    // per-row owner chips + assign/remove control.
    ownersByTestId,
    // Set by the owner mutation route on a validation / conflict failure
    // (it redirects back here with ?ownerError=…). Surfaced as a banner.
    ownerError: url.searchParams.get("ownerError"),
    pathname: url.pathname,
    fullPath: url.pathname + url.search,
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
  // Unconditional runs join (ciRunsJoinFragment) so the sparkline reads CI
  // history only — its `origin <> 'synthetic'` ON clause keeps monitor results
  // out even when no branch filter is active. This query builds its own tenant
  // predicate rather than using testResultsScopeJoin (which bundles the WHERE);
  // the branded scope still bakes the auth-checked projectId in as a bound
  // param.
  const joinSql = ciRunsJoinFragment();

  return runRows<SparklineMetaRow>(sql`
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

  const rows = await runRows<RecentFailureSqlRow>(sql`
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

  return rows;
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
  // Plain join — no window functions or percentiles here, so the typed query
  // builder expresses it directly (and `inArray` replaces the manual `sql.join`
  // IN-list). Caller guards `testIds.length > 0`.
  return db
    .selectDistinct({ testId: testResults.testId, tag: testTags.tag })
    .from(testTags)
    .innerJoin(testResults, eq(testResults.id, testTags.testResultId))
    .where(
      and(
        eq(testResults.projectId, projectId),
        inArray(testResults.testId, [...testIds]),
      ),
    );
}
