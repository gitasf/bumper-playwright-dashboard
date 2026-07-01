import { CheckCircle2, TriangleAlert, XCircle } from "lucide-react";
import { Link } from "@void/react";
import { AnalyticsButtonGroup } from "@/components/analytics/button-group";
import {
  BucketBarChart,
  type BucketBarChartBucket,
} from "@/components/analytics/bucket-bar-chart";
import { InsightsTabs } from "@/components/analytics/insights-tabs";
import { AnalyticsKpiCard } from "@/components/analytics/kpi-card";
import { MetricSparkline } from "@/components/analytics/metric-sparkline";
import { PageHeader } from "@/components/page-header";
import { RunHistoryBranchFilter } from "@/components/run-history-branch-filter";
import { ALL_BRANCHES } from "@/components/run-history-branch-filter.shared";
import { TablePaginationFooter } from "@/components/table-pagination-footer";
import { Card, CardPanel } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
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
 * Slowest tests page. Two views composed:
 *   - Top: 20-bin histogram of test durations over the selected window.
 *   - Bottom: paginated table of testIds ranked by p95 (avg, runs, 7d trend).
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
  toRow,
  totals,
  bucketMs,
  histogram,
  bottlenecks,
  sparklines,
  pathname,
  ranges,
}: Props) {
  const base = `/t/${project.teamSlug}/p/${project.slug}`;
  const topBin = HIST_BINS - 1;

  const histByBin = new Map(histogram.map((r) => [r.bin, r.cnt]));
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
        segments: [{ count: cnt, color: "var(--color-primary)" }],
        total: cnt,
        tooltip: (
          <>
            <div className="mb-1 font-mono text-[10px] text-muted-foreground">
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

  const { with: hrefWith, pageHref } = makeHrefBuilder(pathname, {
    range,
    branch: branchParam,
    q,
    page: currentPage > 1 ? String(currentPage) : null,
  });

  // KPI summary across the ranked window.
  const topRow = bottlenecks[0];
  const p95Values = bottlenecks
    .map((b) => b.p95)
    .filter((v): v is number => v != null);
  const avgP95 =
    p95Values.length === 0
      ? null
      : p95Values.reduce((s, v) => s + v, 0) / p95Values.length;

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
          <AnalyticsKpiCard
            footnote={topRow?.title ?? "—"}
            label="Slowest test (p95)"
            value={
              topRow?.p95 == null ? "—" : formatDuration(Math.round(topRow.p95))
            }
          />
          <AnalyticsKpiCard
            footnote="Across the ranked window"
            label="Average p95"
            value={avgP95 == null ? "—" : formatDuration(Math.round(avgP95))}
          />
        </div>

        <Card className="overflow-hidden rounded-[9px] border-line-1">
          <div className="flex items-center justify-between gap-3 border-b border-line-1 px-[18px] py-3">
            <div className="min-w-0">
              <h2 className="text-[13px] font-semibold tracking-tight">
                Execution time distribution
              </h2>
              <p className="mt-0.5 text-[11.5px] text-fg-3">
                Count of test results per duration bin
                {totals.maxDurationMs > 0
                  ? ` · bin width ${formatDuration(bucketMs)}`
                  : ""}
                .
              </p>
            </div>
            <span className="shrink-0 font-mono text-[11.5px] text-fg-3">
              n={totals.totalResults.toLocaleString()}
            </span>
          </div>
          <CardPanel className="px-[18px] py-4">
            <BucketBarChart
              ariaLabel="Execution time distribution histogram"
              buckets={histBuckets}
              emptyState="No runs in this window."
              height={200}
            />
          </CardPanel>
        </Card>

        <Card className="overflow-hidden rounded-[9px] border-line-1">
          <div className="flex items-center justify-between gap-4 border-b border-line-1 px-[18px] py-3">
            <div className="min-w-0">
              <h2 className="text-[13px] font-semibold tracking-tight">
                Top {bottlenecks.length} slowest tests
              </h2>
              <p className="mt-0.5 text-[11.5px] text-fg-3">
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
                className="w-56 rounded-md border border-line-1 bg-card px-3 py-1 font-mono text-[12.5px] text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/24"
                defaultValue={q}
                name="q"
                placeholder="Filter path or name…"
                type="text"
              />
            </form>
          </div>
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
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10 px-4" />
                    <TableHead className="px-4 text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                      Test
                    </TableHead>
                    <TableHead className="w-[100px] px-4 text-right text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                      Avg
                    </TableHead>
                    <TableHead className="w-[100px] px-4 text-right text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                      P95
                    </TableHead>
                    <TableHead className="w-[120px] px-4 text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                      Trend
                    </TableHead>
                    <TableHead className="w-[80px] px-4 text-right text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                      Runs
                    </TableHead>
                  </TableRow>
                </TableHeader>
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
                          {/* Stretched-link pattern — `<Link>` is
                           * position: static so its `after:inset-0`
                           * pseudo fills the TableRow (which is
                           * `relative`). Whole row = click target. */}
                          <Link
                            className="flex items-center justify-center focus-visible:outline-none after:absolute after:inset-0 after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring"
                            href={href}
                          >
                            <span className="sr-only">
                              View {row.title ?? row.testId}
                            </span>
                            <tone.Icon
                              size={16}
                              style={{ color: tone.iconColor }}
                            />
                          </Link>
                        </TableCell>
                        <TableCell className="px-4 py-3 align-middle">
                          <div className="min-w-0">
                            <div
                              className="truncate text-[13px] text-foreground"
                              title={row.title ?? row.testId}
                            >
                              {row.title ?? row.testId}
                            </div>
                            <div
                              className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
                              title={row.file ?? ""}
                            >
                              {row.file ?? ""}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="w-[100px] px-4 py-3 text-right align-middle font-mono text-[12px] tabular-nums text-foreground">
                          {row.avgDur === null
                            ? "—"
                            : formatDuration(Math.round(row.avgDur))}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "w-[100px] px-4 py-3 text-right align-middle font-mono text-[12px] tabular-nums font-medium",
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
                        <TableCell className="w-[80px] px-4 py-3 text-right align-middle font-mono text-[12px] tabular-nums text-muted-foreground">
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
              fromRow={fromRow}
              toRow={toRow}
              totalCount={totals.totalUniqueTests}
              currentPage={currentPage}
              totalPages={totalPages}
              itemNoun="test"
              pageHref={pageHref}
              className="border-border/50"
            />
          )}
        </Card>
      </div>
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
    p95Text: "text-muted-foreground",
    sparkColor: statusToken("passed"),
  };
}
