import { defer, defineHandler, type InferProps } from "void";
import { and, db, eq, inArray, sql } from "void/db";
import { testResults, testTags } from "@schema";
import {
  branchFragment,
  ciRunsJoinFragment,
  testResultsScopeJoin,
} from "@/lib/analytics/filters";
import { rankFlakyTests } from "@/lib/analytics/flaky-ranking";
import {
  normalizeBranchFilter,
  resolveAnalyticsWindow,
} from "@/lib/analytics/params";
import { latestPerTestRn } from "@/lib/analytics/per-test";
import { makeRangeParser } from "@/lib/analytics/range";
import { loadProjectBranches } from "@/lib/branches-query";
import { runRows } from "@/lib/runs/db";
import { type OwnerEntry, resolveTestOwners } from "@/lib/owners-repo";
import { deferredNoStore, pageProjectFields } from "@/lib/page-loader";
import { type TenantScope } from "@/lib/scope";
import { requireTenantContext } from "@/lib/tenant-context";

export type Props = InferProps<typeof loader>;

const TOP_N = 50;
const SPARKLINE_SIZE = 20;
// Only the latest failure per test is ever rendered (flaky-test-row.tsx reads
// recentFailures[0]), so this fetches exactly 1 row per testId.
const RECENT_FAILURES = 1;

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
}

/**
 * Flaky tests loader. Three serial passes:
 *  1. Aggregate per testId across the window — flakyCount / passedCount /
 *     total. Filter to tests that have at least one flaky result.
 *  2. Sparkline (last 20 statuses) + latest title/file for the page slice.
 *  3. Recent failures (latest flaky/failed/timedout) per testId.
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

  // The branch list is a cheap index-covered DISTINCT that drives the eager
  // toolbar filter, so it stays eager. Every heavy pass (the aggregate + the
  // per-test fan-out) defers together below.
  const branches = await loadProjectBranches(scope);

  deferredNoStore(c);
  return {
    project: pageProjectFields(project),
    range,
    branchParam,
    branchAll,
    branchFilter,
    branches,
    rangeDays,
    pathname: url.pathname,
    ranges: RANGES,

    // The whole flaky payload streams as ONE grouped resolver behind the KPI
    // strip + table skeletons: PASS 1 aggregates per testId (→ ranked slice +
    // KPI numbers + total), then PASS 2 fans out sparklines / recent failures /
    // tags / owners for that slice. The KPI values, the empty-vs-table branch
    // and the footer total all derive from PASS 1, so they live in here too.
    // These are the heaviest reads in the app — keeping them eager would defeat
    // the conversion. Returns plain serializable JSON (maps → objects).
    flaky: defer(async () => {
      // PASS 1: the flakiest-tests ranking, shared verbatim with the MCP
      // `list_flaky_tests` tool via `rankFlakyTests` so the page and an agent
      // can't disagree about "the flakiest tests" for the same window. It joins
      // `runs` unconditionally (ciRunsJoinOn) so its `origin <> 'synthetic'`
      // exclusion keeps monitor tests from ranking even with no branch filter.
      const rankedAll: RankedTest[] = (
        await rankFlakyTests(scope, { windowStartSec, branch: branchFilter })
      ).map((r) => ({
        testId: r.testId,
        total: r.total,
        flakyCount: r.flakyCount,
        passedCount: r.passedCount,
        pct: r.flakeRatePct,
      }));

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
          });
        }
      }

      return {
        totalFlakyTests,
        truncated,
        ranked,
        kpis,
        // Convert maps to plain objects for serialization.
        sparkByTest: Object.fromEntries(sparkByTest),
        failsByTest: Object.fromEntries(failsByTest),
        // testId → resolved owners (manual + CODEOWNERS, manual-wins).
        ownersByTestId,
      };
    }),
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
        -- createdAt is int8: this raw runRows read bypasses Drizzle's decoders,
        -- so node-postgres returns it as a STRING (pglite returns a number,
        -- hiding it). Cast to double precision so createdAt is a JS number on
        -- real pg -- RecentFailureRow.createdAt is typed number and feeds
        -- formatRelativeTime, which does arithmetic on it.
        cast(tr."createdAt" as double precision) as "createdAt",
        tr."errorMessage" as "errorMessage",
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
           "errorMessage", "commitSha", branch, actor, rn
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
