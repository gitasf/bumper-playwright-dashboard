import { defineHandler, type InferProps } from "void";
import { sql } from "void/db";
import { loadProjectBranches } from "@/lib/branches-query";
import { runRow, runRows } from "@/lib/db-run";
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
import { requireTenantContext } from "@/lib/tenant-context";

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
  latestRunId: string | null;
  latestTestResultId: string | null;
  failCount: number;
  flakyCount: number;
}

export interface SparklinePoint {
  day: number;
  avg: number;
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
  const pageParam = parseInt(url.searchParams.get("page") ?? "1", 10);
  const requestedPage =
    Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const { nowSec, windowStartSec } = resolveAnalyticsWindow(range);
  const branches = await loadProjectBranches(scope);

  const branchSql = branchFragment(branchFilter);
  const qSql = searchFragment(q || null);

  // Totals: max duration + count of non-skipped + distinct testIds.
  const totalsRow =
    (await runRow<{
      maxDur?: number | null;
      n?: number;
      unique?: number;
    }>(sql`
    select
      max(tr."durationMs") as "maxDur",
      count(*) as n,
      count(distinct tr."testId") as "unique"
    from "testResults" tr
    ${testResultsScopeJoin(scope)}
      and tr."createdAt" >= ${windowStartSec}
      and tr.status != 'skipped'
      ${branchSql}
      ${qSql}
  `)) ?? {};
  const totals: TotalsRow = {
    totalResults: totalsRow.n ?? 0,
    maxDurationMs: totalsRow.maxDur ?? 0,
    totalUniqueTests: totalsRow.unique ?? 0,
  };

  const bucketMs = pickBinWidthMs(totals.maxDurationMs);
  const topBin = HIST_BINS - 1;

  let histogram: HistogramRow[] = [];
  if (totals.totalResults > 0) {
    histogram = await runRows<HistogramRow>(sql`
      select
        cast(
          case
            when tr."durationMs" >= ${bucketMs * HIST_BINS} then ${topBin}
            else tr."durationMs" / ${bucketMs}
          end as integer
        ) as bin,
        count(*) as cnt
      from "testResults" tr
      ${testResultsScopeJoin(scope)}
        and tr."createdAt" >= ${windowStartSec}
        and tr.status != 'skipped'
        ${branchSql}
        ${qSql}
      group by bin
    `);
  }

  const totalPages = Math.max(
    1,
    Math.ceil(totals.totalUniqueTests / PAGE_SIZE),
  );
  const currentPage = Math.min(requestedPage, totalPages);
  const offset = (currentPage - 1) * PAGE_SIZE;

  let bottlenecks: BottleneckRow[] = [];
  if (totals.totalUniqueTests > 0) {
    bottlenecks = await runRows<BottleneckRow>(sql`
      with filtered as (
        select
          tr."testId" as "testId",
          tr."durationMs" as "durationMs",
          tr.title as title,
          tr.file as file,
          tr.status as status,
          tr."createdAt" as "createdAt",
          tr."runId" as "runId",
          tr.id as "testResultId"
        from "testResults" tr
        ${testResultsScopeJoin(scope)}
          and tr."createdAt" >= ${windowStartSec}
          and tr.status != 'skipped'
          ${branchSql}
          ${qSql}
      ),
      ranked as (
        select *,
          row_number() over (partition by "testId" order by "durationMs") as "rnDur",
          ${latestPerTestRn(`"rnTime"`, {
            testIdCol: `"testId"`,
            orderByCol: `"createdAt"`,
          })},
          count(*) over (partition by "testId") as cnt
        from filtered
      )
      select
        "testId",
        max(cnt) as n,
        avg("durationMs") as "avgDur",
        ${percentilePick(0.95, { rn: `"rnDur"`, cnt: "cnt", value: `"durationMs"` })} as p95,
        ${latestPerTestValue("title", { alias: "title" })},
        ${latestPerTestValue("file", { alias: "file" })},
        ${latestPerTestValue(`"runId"`, { alias: `"latestRunId"` })},
        ${latestPerTestValue(`"testResultId"`, { alias: `"latestTestResultId"` })},
        ${statusCounter("fail", { alias: `"failCount"` })},
        ${statusCounter("flaky", { alias: `"flakyCount"` })}
      from ranked
      group by "testId"
      order by p95 desc
      limit ${PAGE_SIZE}
      offset ${offset}
    `);
  }

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
        avg(tr."durationMs") as avg
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

  const fromRow = totals.totalUniqueTests === 0 ? 0 : offset + 1;
  const toRow = offset + bottlenecks.length;

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
    branches,
    branchFilter,
    q,
    currentPage,
    totalPages,
    fromRow,
    toRow,
    totals,
    bucketMs,
    histogram,
    bottlenecks,
    sparklines: Object.fromEntries(sparklinesEntries),
    pathname: url.pathname,
    ranges: RANGES,
  };
});
