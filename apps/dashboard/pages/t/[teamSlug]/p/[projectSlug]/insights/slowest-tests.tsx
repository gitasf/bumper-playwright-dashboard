import { CheckCircle2, TriangleAlert, XCircle } from "lucide-react";
import { RowLink } from "@/components/row-link";
import { use } from "react";
import { PREFETCH_STABLE } from "@/components/ui/link";
import { AnalyticsButtonGroup } from "@/components/analytics/button-group";
import {
  BucketBarChart,
  type BucketBarChartBucket,
} from "@/components/analytics/bucket-bar-chart";
import { InsightsTabs } from "@/components/analytics/insights-tabs";
import { AnalyticsKpiCard } from "@/components/analytics/kpi-card";
import { MetricSparkline } from "@/components/analytics/metric-sparkline";
import { DeferredSection } from "@/components/defer-error-boundary";
import { PageHeader } from "@/components/page-header";
import { RunHistoryBranchFilter } from "@/components/run/history-branch-filter";
import { ALL_BRANCHES } from "@/components/run/history-branch-filter.shared";
import {
  ChartSkeleton,
  KpiCardSkeleton,
  TablePaginationFooterSkeleton,
} from "@/components/skeletons";
import { TablePaginationFooter } from "@/components/table-pagination-footer";
import { Card, CardPanel } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { makeHrefBuilder } from "@/lib/page-links";
import { statusToken } from "@/lib/status";
import { formatDuration } from "@/lib/time-format";
import type { BottleneckRow, Props } from "./slowest-tests.server";

const HIST_BINS = 20;

/**
 * Slowest tests page. The header, tabs, filters, the "Tests tracked" KPI and
 * the pagination shell paint immediately from the cheap eager `totals` +
 * `branches`. The two heavy regions — the duration histogram and the ranked
 * bottlenecks table (+ its p95 KPIs and 7-day sparklines) — each stream in
 * behind their own skeleton via `defer()`. See the server module for the split.
 */
export default function SlowestTestsPage({
  project,
  range,
  branchParam,
  branches,
  branchFilter,
  q,
  currentPage,
  totalPages,
  fromRow,
  offset,
  pageSize,
  totals,
  bucketMs,
  histogram,
  slowest,
  pathname,
  ranges,
}: Props) {
  const { with: hrefWith, pageHref } = makeHrefBuilder(pathname, {
    range,
    branch: branchParam,
    q,
    page: currentPage > 1 ? String(currentPage) : null,
  });

  // A deferred region that fails latches its error boundary; clear it when the
  // filters/page change so the SPA-nav re-fetch re-attempts the region.
  const resetKey = `${range}:${branchParam ?? ""}:${q}:${currentPage}`;

  // Reserve the exact number of skeleton rows the resolved bottlenecks table
  // will render — the page size, clamped to the rows left on the last page
  // (0 → the Empty state). `totals.totalUniqueTests` is eager and already
  // reflects the active branch/search filter, so the skeleton row count can't
  // drift from what streams in.
  const bottlenecksRowCount = Math.min(
    pageSize,
    Math.max(0, totals.totalUniqueTests - offset),
  );

  return (
    <>
      <PageHeader
        right={
          <>
            <RunHistoryBranchFilter
              branches={branches}
              defaultValue={branchParam ?? ALL_BRANCHES}
            />
            <AnalyticsButtonGroup
              hrefFor={(r) => hrefWith({ range: r, page: null })}
              options={ranges as readonly ("7d" | "14d" | "30d" | "90d")[]}
              value={range}
            />
          </>
        }
        title="Insights"
      />

      <InsightsTabs
        active="slowest-tests"
        branch={branchParam}
        projectSlug={project.slug}
        range={range}
        teamSlug={project.teamSlug}
      />

      <div className="flex-1 overflow-y-auto min-h-0 px-6 py-6 pb-12 space-y-[18px]">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <AnalyticsKpiCard
            footnote={`${totals.totalResults.toLocaleString()} test result${totals.totalResults === 1 ? "" : "s"} in window`}
            label="Tests tracked"
            value={totals.totalUniqueTests.toLocaleString()}
          />
          <DeferredSection resetKey={resetKey} skeleton={<KpiCardSkeleton />}>
            <SlowestTestKpi slowest={slowest} />
          </DeferredSection>
          <DeferredSection resetKey={resetKey} skeleton={<KpiCardSkeleton />}>
            <AverageP95Kpi slowest={slowest} />
          </DeferredSection>
        </div>

        <Card className="overflow-hidden rounded-[9px] border-line-1">
          <div className="flex items-center justify-between gap-3 border-b border-line-1 px-[18px] py-3">
            <div className="min-w-0">
              <h2 className="text-body font-semibold tracking-tight">
                Execution time distribution
              </h2>
              <p className="mt-0.5 text-caption text-fg-3">
                Count of test results per duration bin
                {totals.maxDurationMs > 0
                  ? ` · bin width ${formatDuration(bucketMs)}`
                  : ""}
                .
              </p>
            </div>
            <span className="shrink-0 font-mono text-caption text-fg-3">
              n={totals.totalResults.toLocaleString()}
            </span>
          </div>
          <CardPanel className="px-[18px] py-4">
            <DeferredSection
              resetKey={resetKey}
              skeleton={<ChartSkeleton height={200} />}
            >
              <HistogramChart bucketMs={bucketMs} histogram={histogram} />
            </DeferredSection>
          </CardPanel>
        </Card>

        <Card className="overflow-hidden rounded-[9px] border-line-1">
          <div className="flex items-center justify-between gap-4 border-b border-line-1 px-[18px] py-3">
            <div className="min-w-0">
              <h2 className="text-body font-semibold tracking-tight">
                Slowest tests
              </h2>
              <p className="mt-0.5 text-caption text-fg-3">
                {totals.totalUniqueTests.toLocaleString()} unique test
                {totals.totalUniqueTests === 1 ? "" : "s"} sorted by p95.
              </p>
            </div>
            <form className="relative" method="get">
              <input name="range" type="hidden" value={range} />
              {branchParam ? (
                <input name="branch" type="hidden" value={branchParam} />
              ) : null}
              <input
                className="w-56 rounded-md border border-line-1 bg-bg-1 px-3 py-1 font-mono text-body text-fg-1 placeholder:text-fg-3 focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/24"
                defaultValue={q}
                name="q"
                placeholder="Filter path or name…"
                type="text"
              />
            </form>
          </div>
          <DeferredSection
            resetKey={resetKey}
            skeleton={
              <BottlenecksSkeleton
                rowCount={bottlenecksRowCount}
                totalPages={totalPages}
              />
            }
          >
            <BottlenecksSection
              branchFilter={branchFilter}
              currentPage={currentPage}
              fromRow={fromRow}
              pageHref={pageHref}
              project={project}
              q={q}
              slowest={slowest}
              totalPages={totalPages}
              totals={totals}
            />
          </DeferredSection>
        </Card>
      </div>
    </>
  );
}

function SlowestTestKpi({ slowest }: { slowest: Props["slowest"] }) {
  const { bottlenecks } = use(slowest);
  const topRow = bottlenecks[0];
  return (
    <AnalyticsKpiCard
      footnote={topRow?.title ?? "—"}
      label="Slowest test (p95)"
      value={topRow?.p95 == null ? "—" : formatDuration(Math.round(topRow.p95))}
    />
  );
}

function AverageP95Kpi({ slowest }: { slowest: Props["slowest"] }) {
  const { bottlenecks } = use(slowest);
  const p95Values = bottlenecks
    .map((b) => b.p95)
    .filter((v): v is number => v != null);
  const avgP95 =
    p95Values.length === 0
      ? null
      : p95Values.reduce((s, v) => s + v, 0) / p95Values.length;
  return (
    <AnalyticsKpiCard
      footnote="Across the ranked window"
      label="Average p95"
      value={avgP95 == null ? "—" : formatDuration(Math.round(avgP95))}
    />
  );
}

function HistogramChart({
  histogram,
  bucketMs,
}: {
  histogram: Props["histogram"];
  bucketMs: number;
}) {
  const rows = use(histogram);
  const topBin = HIST_BINS - 1;
  const histByBin = new Map(rows.map((r) => [r.bin, r.cnt]));
  const histBuckets: BucketBarChartBucket[] = Array.from(
    { length: HIST_BINS },
    (_, i) => {
      const cnt = histByBin.get(i) ?? 0;
      const loMs = i * bucketMs;
      const hiMs = (i + 1) * bucketMs;
      const label =
        i === topBin ? `${formatDuration(loMs)}+` : formatDuration(loMs);
      return {
        key: String(i),
        label,
        segments: [{ count: cnt, color: "var(--color-chart-4)" }],
        total: cnt,
        tooltip: (
          <>
            <div className="mb-1 font-mono text-micro text-fg-3">
              {i === topBin
                ? `${formatDuration(loMs)}+`
                : `${formatDuration(loMs)} – ${formatDuration(hiMs)}`}
            </div>
            <div className="font-mono text-xs">
              {cnt.toLocaleString()} test{cnt === 1 ? "" : "s"}
            </div>
          </>
        ),
      };
    },
  );

  return (
    <BucketBarChart
      ariaLabel="Execution time distribution histogram"
      buckets={histBuckets}
      emptyState="No runs in this window."
      height={200}
    />
  );
}

/** Shared 6-column header used by the bottlenecks table and its skeleton, so
 *  the fixed column widths can't drift between states. */
function BottlenecksTableHead() {
  return (
    <TableHeader>
      <TableRow>
        <TableHead className="w-10 px-4" />
        <TableHead className="px-4">Test</TableHead>
        <TableHead className="w-[100px] px-4 text-right">Avg</TableHead>
        <TableHead className="w-[100px] px-4 text-right">P95</TableHead>
        <TableHead className="w-[120px] px-4">Trend</TableHead>
        <TableHead className="w-[80px] px-4 text-right">Runs</TableHead>
      </TableRow>
    </TableHeader>
  );
}

function BottlenecksSection({
  slowest,
  project,
  totals,
  branchFilter,
  q,
  currentPage,
  totalPages,
  fromRow,
  pageHref,
}: {
  slowest: Props["slowest"];
  project: Props["project"];
  totals: Props["totals"];
  branchFilter: Props["branchFilter"];
  q: string;
  currentPage: number;
  totalPages: number;
  fromRow: number;
  pageHref: (page: number) => string;
}) {
  const { bottlenecks, sparklines, toRow } = use(slowest);
  const base = `/t/${project.teamSlug}/p/${project.slug}`;

  return (
    <>
      <CardPanel className="pt-0">
        {bottlenecks.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No tests in this window</EmptyTitle>
              <EmptyDescription>
                {q
                  ? `No tests match "${q}". Try a wider window or clear the filter.`
                  : `No runs with recorded durations in the selected window${
                      branchFilter ? ` on ${branchFilter}` : ""
                    }.`}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table className="table-fixed">
            <BottlenecksTableHead />
            <TableBody>
              {bottlenecks.map((row) => {
                const tone = rowTone(row);
                // Link to the test-level history page (stable testId), not
                // the latest run's result — mirrors the tests catalog.
                const href = `${base}/tests/${row.testId}`;
                const spark = sparklines[row.testId] ?? [];
                return (
                  <TableRow key={row.testId}>
                    <TableCell className="w-10 px-4 py-3 align-middle">
                      <RowLink cacheFor={PREFETCH_STABLE} href={href}>
                        <span className="sr-only">
                          View {row.title ?? row.testId}
                        </span>
                        <tone.Icon
                          size={16}
                          style={{ color: tone.iconColor }}
                        />
                      </RowLink>
                    </TableCell>
                    <TableCell className="px-4 py-3 align-middle">
                      <div className="min-w-0">
                        <div
                          className="truncate text-body text-fg-1"
                          title={row.title ?? row.testId}
                        >
                          {row.title ?? row.testId}
                        </div>
                        <div
                          className="mt-0.5 truncate font-mono text-micro text-fg-3"
                          title={row.file ?? ""}
                        >
                          {row.file ?? ""}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="w-[100px] px-4 py-3 text-right align-middle font-mono text-caption tabular-nums text-fg-1">
                      {row.avgDur === null
                        ? "—"
                        : formatDuration(Math.round(row.avgDur))}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "w-[100px] px-4 py-3 text-right align-middle font-mono text-caption tabular-nums font-medium",
                        tone.p95Text,
                      )}
                    >
                      {row.p95 === null
                        ? "—"
                        : formatDuration(Math.round(row.p95))}
                    </TableCell>
                    <TableCell className="w-[120px] px-4 py-3 align-middle">
                      <MetricSparkline
                        area={false}
                        ariaLabel="7-day duration trend"
                        className="mx-auto"
                        color={tone.sparkColor}
                        height={20}
                        points={spark.map((p) => ({
                          x: p.day,
                          y: p.avg,
                        }))}
                        width={80}
                      />
                    </TableCell>
                    <TableCell className="w-[80px] px-4 py-3 text-right align-middle font-mono text-caption tabular-nums text-fg-3">
                      {row.n.toLocaleString()}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardPanel>
      {bottlenecks.length > 0 && (
        <TablePaginationFooter
          className="border-line-1/50"
          currentPage={currentPage}
          fromRow={fromRow}
          itemNoun="test"
          pageHref={pageHref}
          toRow={toRow}
          totalCount={totals.totalUniqueTests}
          totalPages={totalPages}
        />
      )}
    </>
  );
}

/**
 * Suspense fallback matching the bottlenecks table. `rowCount` is the exact
 * number of rows the resolved page will show (page size clamped to the last
 * page), so the table doesn't grow or collapse on resolve; `rowCount === 0`
 * mirrors `BottlenecksSection`'s Empty branch (no table, no footer). Table
 * cells inherit `leading-none` (line-height 1) from `TableCell`, so the Test
 * cell reserves `h-[13px]` + `h-[11px]` (its `text-body`/`text-micro` lines,
 * NOT their 1.5× line boxes) for a 26px content stack, matching the real row.
 * The footer placeholder reserves `TablePaginationFooter`'s box, which the old
 * skeleton omitted entirely (the footer popped in below the table on resolve).
 */
function BottlenecksSkeleton({
  rowCount,
  totalPages,
}: {
  rowCount: number;
  totalPages: number;
}) {
  if (rowCount === 0) {
    // Matches BottlenecksSection's Empty branch: no table, no footer.
    return (
      <CardPanel className="pt-0">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              <Skeleton className="h-7 w-44" />
            </EmptyTitle>
            <EmptyDescription>
              <Skeleton className="mt-1 h-5 w-64" />
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </CardPanel>
    );
  }

  return (
    <>
      <CardPanel className="pt-0">
        <Table className="table-fixed">
          <BottlenecksTableHead />
          <TableBody>
            {Array.from({ length: rowCount }, (_, i) => (
              <TableRow key={i}>
                <TableCell className="w-10 px-4 py-3 align-middle">
                  <Skeleton className="mx-auto h-4 w-4 rounded-full" />
                </TableCell>
                <TableCell className="px-4 py-3 align-middle">
                  {/* leading-none: text-body + mt-0.5 + text-micro = 26px */}
                  <div className="min-w-0">
                    <Skeleton className="h-[13px] w-2/3" />
                    <Skeleton className="mt-0.5 h-[11px] w-1/2" />
                  </div>
                </TableCell>
                <TableCell className="w-[100px] px-4 py-3 align-middle">
                  <Skeleton className="ml-auto h-3 w-12" />
                </TableCell>
                <TableCell className="w-[100px] px-4 py-3 align-middle">
                  <Skeleton className="ml-auto h-3 w-12" />
                </TableCell>
                <TableCell className="w-[120px] px-4 py-3 align-middle">
                  <Skeleton className="mx-auto h-5 w-20" />
                </TableCell>
                <TableCell className="w-[80px] px-4 py-3 align-middle">
                  <Skeleton className="ml-auto h-3 w-8" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardPanel>
      {/* Mirrors the real footer (which passes className="border-line-1/50");
       * the page-number strip only appears when totalPages > 1, so this lands at
       * ~57px (multi-page) / ~41px (single page), same as the resolved footer. */}
      <TablePaginationFooterSkeleton
        className="border-line-1/50"
        showPager={totalPages > 1}
      />
    </>
  );
}

interface RowTone {
  Icon: typeof CheckCircle2;
  iconColor: string;
  border: string;
  p95Text: string;
  sparkColor: string;
}

function rowTone(row: BottleneckRow): RowTone {
  if (row.failCount > 0) {
    return {
      Icon: XCircle,
      iconColor: statusToken("failed"),
      border: "border-l-destructive",
      p95Text: "text-destructive",
      sparkColor: statusToken("failed"),
    };
  }
  if (row.flakyCount > 0) {
    return {
      Icon: TriangleAlert,
      iconColor: statusToken("flaky"),
      border: "border-l-warning",
      p95Text: "text-warning",
      sparkColor: statusToken("flaky"),
    };
  }
  return {
    Icon: CheckCircle2,
    iconColor: statusToken("passed"),
    border: "border-l-border",
    p95Text: "text-fg-3",
    sparkColor: statusToken("passed"),
  };
}
