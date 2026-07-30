import { defer, defineHandler, type InferProps } from "void";
import { sql } from "void/db";
import { loadProjectBranches } from "@/lib/branches-query";
import { runRow, runRows } from "@/lib/runs/db";
import { intAggExpr, numAggExpr } from "@/lib/db/sql-ops";
import { DAY_SEC } from "@/lib/analytics/bucketing";
import { bucketExpr, percentilePick } from "@/lib/analytics/bucketing-sql";
import {
  branchFragment,
  searchFragment,
  testResultsScopeJoin,
} from "@/lib/analytics/filters";
import {
  normalizeBranchFilter,
  resolveAnalyticsWindow,
} from "@/lib/analytics/params";
import {
  latestPerTestRn,
  latestPerTestValue,
  statusCounter,
} from "@/lib/analytics/per-test";
import { makeRangeParser } from "@/lib/analytics/range";
import { resolveOffsetPage } from "@/lib/page-window";
import { deferredNoStore, pageProjectFields } from "@/lib/page-loader";
import { parsePage } from "@/lib/runs/filters";
import { requireTenantContext } from "@/lib/tenant-context";
import type { TenantScope } from "@/lib/scope";

export type Props = InferProps<typeof loader>;

type RangeKey = "7d" | "14d" | "30d" | "90d";
const RANGES: readonly RangeKey[] = ["7d", "14d", "30d", "90d"];
const parseRange = makeRangeParser<RangeKey>(RANGES, "30d");

const HIST_BINS = 20;
const PAGE_SIZE = 20;
const SPARKLINE_DAYS = 7;

export interface HistogramRow {
  bin: number;
  cnt: number;
}

export interface BottleneckRow {
  testId: string;
  n: number;
  avgDur: number | null;
  p95: number | null;
  title: string | null;
  file: string | null;
  failCount: number;
  flakyCount: number;
}

export interface SparklinePoint {
  day: number;
  avg: number;
}

export interface SlowestKpis {
  slowestTitle: string | null;
  slowestP95: number | null;
  averageP95: number | null;
}

export interface SlowestRankedPage {
  kpis: SlowestKpis;
  bottlenecks: BottleneckRow[];
}

interface SlowestRankedQueryRow extends SlowestKpis {
  testId: string | null;
  n: number | null;
  avgDur: number | null;
  p95: number | null;
  title: string | null;
  file: string | null;
  failCount: number | null;
  flakyCount: number | null;
}

interface TotalsRow {
  totalResults: number;
  maxDurationMs: number;
  totalUniqueTests: number;
}

function pickBinWidthMs(maxDurationMs: number): number {
  if (maxDurationMs <= 0) return 100;
  const raw = Math.ceil(maxDurationMs / HIST_BINS);
  const nice = [
    100, 200, 250, 500, 1_000, 2_000, 2_500, 5_000, 10_000, 15_000, 30_000,
    60_000, 120_000, 300_000, 600_000,
  ];
  for (const n of nice) if (raw <= n) return n;
  return 600_000;
}

/**
 * Rank the full filtered window once, deriving both the whole-window KPI
 * summary and one paginated table slice from the same `per_test` CTE.
 */
export async function loadSlowestRankedPage(
  scope: TenantScope,
  windowStartSec: number,
  branchFilter: string | null,
  query: string | null,
  offset: number,
): Promise<SlowestRankedPage> {
  const branchSql = branchFragment(branchFilter);
  const querySql = searchFragment(query, scope.projectId);
  const rows = await runRows<SlowestRankedQueryRow>(sql`
    with filtered as (
      select
        tr."testId" as "testId",
        tr."durationMs" as "durationMs",
        tr.title as title,
        tr.file as file,
        tr.status as status,
        tr."createdAt" as "createdAt"
      from "testResults" tr
      ${testResultsScopeJoin(scope)}
        and tr."createdAt" >= ${windowStartSec}
        and tr.status != 'skipped'
        ${branchSql}
        ${querySql}
    ),
    ranked as (
      select *,
        row_number() over (
          partition by "testId"
          order by "durationMs"
        ) as "rnDur",
        ${latestPerTestRn(`"rnTime"`, {
          testIdCol: `"testId"`,
          orderByCol: `"createdAt"`,
        })},
        count(*) over (partition by "testId") as cnt
      from filtered
    ),
    per_test as (
      select
        "testId",
        cast(max(cnt) as integer) as n,
        ${numAggExpr(`avg("durationMs")`, { alias: `"avgDur"` })},
        ${percentilePick(0.95, {
          rn: `"rnDur"`,
          cnt: "cnt",
          value: `"durationMs"`,
        })} as p95,
        ${latestPerTestValue("title", { alias: "title" })},
        ${latestPerTestValue("file", { alias: "file" })},
        ${statusCounter("fail", { alias: `"failCount"` })},
        ${statusCounter("flaky", { alias: `"flakyCount"` })}
      from ranked
      group by "testId"
    ),
    summary as (
      select
        ${numAggExpr("max(p95)", { alias: `"slowestP95"` })},
        ${numAggExpr("avg(p95)", { alias: `"averageP95"` })},
        (
          select title
          from per_test
          where p95 is not null
          order by p95 desc, "testId"
          limit 1
        ) as "slowestTitle"
      from per_test
    ),
    page as (
      select *
      from per_test
      order by p95 desc, "testId"
      limit ${PAGE_SIZE}
      offset ${offset}
    )
    select
      summary."slowestTitle",
      summary."slowestP95",
      summary."averageP95",
      page."testId",
      page.n,
      page."avgDur",
      page.p95,
      page.title,
      page.file,
      page."failCount",
      page."flakyCount"
    from summary
    left join page on true
    order by page.p95 desc, page."testId"
  `);
  const first = rows[0];
  const kpis: SlowestKpis = first
    ? {
        slowestTitle: first.slowestTitle,
        slowestP95: first.slowestP95,
        averageP95: first.averageP95,
      }
    : {
        slowestTitle: null,
        slowestP95: null,
        averageP95: null,
      };
  const bottlenecks: BottleneckRow[] = rows.flatMap((row) =>
    row.testId === null
      ? []
      : [
          {
            testId: row.testId,
            n: row.n ?? 0,
            avgDur: row.avgDur,
            p95: row.p95,
            title: row.title,
            file: row.file,
            failCount: row.failCount ?? 0,
            flakyCount: row.flakyCount ?? 0,
          },
        ],
  );
  return { kpis, bottlenecks };
}

/**
 * Slowest tests loader.
 *
 * - Totals: count + max(durationMs) + count(distinct testId) over the window.
 * - Histogram: 20 bins of durationMs.
 * - Bottlenecks: window-function ranked p95 per testId, paginated.
 * - Sparklines: daily-avg duration over the trailing 7 days for the page slice.
 */
export const loader = defineHandler(async (c) => {
  const { project, scope } = requireTenantContext(c);

  const url = new URL(c.req.url);
  const range = parseRange(url.searchParams.get("range"));
  const { branchParam, branchFilter } = normalizeBranchFilter(
    url.searchParams.get("branch"),
  );
  const q = (url.searchParams.get("q") ?? "").trim();
  const requestedPage = parsePage(url.searchParams.get("page"));

  const { nowSec, windowStartSec } = resolveAnalyticsWindow(range);

  const branchSql = branchFragment(branchFilter);
  const qSql = searchFragment(q || null, scope.projectId);

  // Branch list is independent of the totals — run the two in parallel.
  // Totals: max duration + count of non-skipped + distinct testIds.
  const [branches, totalsRowRaw] = await Promise.all([
    loadProjectBranches(scope),
    runRow<{
      maxDur?: number | null;
      n?: number;
      unique?: number;
    }>(sql`
    select
      max(tr."durationMs") as "maxDur",
      ${intAggExpr("count(*)", { alias: "n" })},
      ${intAggExpr(`count(distinct tr."testId")`, { alias: `"unique"` })}
    from "testResults" tr
    ${testResultsScopeJoin(scope)}
      and tr."createdAt" >= ${windowStartSec}
      and tr.status != 'skipped'
      ${branchSql}
      ${qSql}
  `),
  ]);
  const totalsRow = totalsRowRaw ?? {};
  const totals: TotalsRow = {
    totalResults: totalsRow.n ?? 0,
    maxDurationMs: totalsRow.maxDur ?? 0,
    totalUniqueTests: totalsRow.unique ?? 0,
  };

  const bucketMs = pickBinWidthMs(totals.maxDurationMs);
  const topBin = HIST_BINS - 1;

  // Pagination shell: derived purely from the eager totals so the footer's
  // "Showing 1–N of M" and page links paint immediately. `toRow` is left at
  // `offset` here (no `rowCount`) and re-derived against the real slice length
  // inside the deferred bottlenecks region once its rows resolve.
  const { currentPage, totalPages, offset, fromRow } = resolveOffsetPage({
    total: totals.totalUniqueTests,
    pageSize: PAGE_SIZE,
    requestedPage,
  });
  const rankedPagePromise =
    totals.totalUniqueTests > 0
      ? loadSlowestRankedPage(
          scope,
          windowStartSec,
          branchFilter,
          q || null,
          offset,
        )
      : Promise.resolve<SlowestRankedPage>({
          kpis: {
            slowestTitle: null,
            slowestP95: null,
            averageP95: null,
          },
          bottlenecks: [],
        });

  // Shell data: the branch list is cheap (index-covered DISTINCT) and drives
  // the always-visible header control; the totals above are the cheap
  // count/max pass that feeds bin width, pagination and the "Tests tracked"
  // KPI. Both stay eager. The two heavy regions below — the duration histogram
  // and the ranked-bottlenecks table (+ its 7-day sparklines) — each stream in
  // behind their own Suspense boundary.

  deferredNoStore(c);
  return {
    project: pageProjectFields(project),
    range,
    branchParam,
    branches,
    branchFilter,
    q,
    currentPage,
    totalPages,
    fromRow,
    // `offset` + `pageSize` let the page reserve the exact skeleton row count
    // for the deferred bottlenecks table (page size clamped to the rows left on
    // the last page) without re-deriving PAGE_SIZE or importing this module's
    // constants into the client bundle.
    offset,
    pageSize: PAGE_SIZE,
    totals,
    bucketMs,
    pathname: url.pathname,
    ranges: RANGES,

    // Duration-distribution histogram — its own boundary so the slower ranking
    // query never gates it. Depends only on the eager totals (bin width) + scope.
    histogram: defer<HistogramRow[]>(async () =>
      totals.totalResults > 0
        ? runRows<HistogramRow>(sql`
      select
        cast(
          case
            when tr."durationMs" >= ${bucketMs * HIST_BINS} then ${topBin}
            else tr."durationMs" / ${bucketMs}
          end as integer
        ) as bin,
        -- count(*) is int8: a raw runRows read bypasses Drizzle's decoders, so
        -- node-postgres returns it as a STRING (pglite returns a number, hiding
        -- it). intAggExpr casts to integer so cnt is a JS number on real pg.
        ${intAggExpr("count(*)", { alias: "cnt" })}
      from "testResults" tr
      ${testResultsScopeJoin(scope)}
        and tr."createdAt" >= ${windowStartSec}
        and tr.status != 'skipped'
        ${branchSql}
        ${qSql}
      group by bin
    `)
        : [],
    ),

    // The KPI region and paginated table share one full-window ranking promise:
    // page 2 cannot relabel rank 21 as "slowest", and p95 is not computed twice.
    kpis: defer<SlowestKpis>(async () => (await rankedPagePromise).kpis),

    // Ranked bottlenecks + their 7-day sparklines. The sparklines depend on the
    // bottleneck rows' testIds (a dependency chain), so they resolve together in
    // ONE boundary: fetch the ranked slice, then its sparklines, then fold the
    // slice-relative `toRow` in. Returns plain serializable JSON (rows + a
    // testId→points map); all JSX (icons, tooltips, sparkline SVGs) is built in
    // the client component that reads this via `use()`.
    slowest: defer(async () => {
      const { bottlenecks } = await rankedPagePromise;

      const pageTestIds = bottlenecks.map((r) => r.testId);
      const sparklinesEntries: [string, SparklinePoint[]][] = [];
      if (pageTestIds.length > 0) {
        const sparkStart = nowSec - SPARKLINE_DAYS * DAY_SEC;
        const branchSparkSql = branchFragment(branchFilter);
        const sparkRows = await runRows<{
          testId: string;
          day: number;
          avg: number;
        }>(sql`
      select
        tr."testId" as "testId",
        cast(${bucketExpr("day", sql`tr."createdAt"`)} as integer) as day,
        ${numAggExpr(`avg(tr."durationMs")`, { alias: "avg" })}
      from "testResults" tr
      ${testResultsScopeJoin(scope)}
        and tr."createdAt" >= ${sparkStart}
        and tr.status != 'skipped'
        and tr."testId" in (${sql.join(
          pageTestIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        ${branchSparkSql}
      group by tr."testId", day
      order by tr."testId" asc, day asc
    `);
        const sparkMap = new Map<string, SparklinePoint[]>();
        for (const r of sparkRows) {
          const list = sparkMap.get(r.testId) ?? [];
          list.push({ day: r.day, avg: r.avg });
          sparkMap.set(r.testId, list);
        }
        sparklinesEntries.push(...sparkMap.entries());
      }

      return {
        bottlenecks,
        sparklines: Object.fromEntries(sparklinesEntries),
        toRow: offset + bottlenecks.length,
      };
    }),
  };
});
