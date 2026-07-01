import { AnalyticsButtonGroup } from "@/components/analytics/button-group";
import { InsightsTabs } from "@/components/analytics/insights-tabs";
import { AnalyticsKpiCard } from "@/components/analytics/kpi-card";
import {
  AnalyticsLineChart,
  type LineChartBucket,
  type LineChartSeries,
} from "@/components/analytics/line-chart";
import { PageHeader } from "@/components/page-header";
import { RunHistoryBranchFilter } from "@/components/run-history-branch-filter";
import { ALL_BRANCHES } from "@/components/run-history-branch-filter.shared";
import { Card, CardPanel } from "@/components/ui/card";
import { alignBuckets } from "@/lib/analytics/bucketing";
import { makeHrefBuilder } from "@/lib/page-links";
import { formatDuration } from "@/lib/time-format";
import type { Props } from "./run-duration.server";

// Theme tokens only (styles.css owns the resolved colours): higher percentiles
// escalate through the status palette — p90 amber (flaky), p95 red (fail) —
// and track light/dark for free.
const SERIES_COLORS = {
  p50: "var(--color-foreground)",
  p90: "var(--flaky)",
  p95: "var(--fail)",
} as const;

/**
 * Run Duration analytics page. Multi-series line chart of p50/p90/p95
 * durations per bucket plus the overall percentile KPI cards.
 */
export default function RunDurationPage({
  project,
  range,
  segment,
  nowSec,
  windowStartSec,
  perBucket,
  overall,
  branchParam,
  branches,
  pathname,
  ranges,
}: Props) {
  const series: LineChartSeries[] = [
    { key: "p50", label: "p50", color: SERIES_COLORS.p50 },
    { key: "p90", label: "p90", color: SERIES_COLORS.p90 },
    { key: "p95", label: "p95", color: SERIES_COLORS.p95 },
  ];

  const buckets: LineChartBucket[] = alignBuckets(
    segment,
    windowStartSec,
    nowSec,
    perBucket,
  ).map((s) => {
    const row = s.row;
    const p50 = row?.p50 ?? null;
    const p90 = row?.p90 ?? null;
    const p95 = row?.p95 ?? null;
    const cnt = row?.cnt ?? 0;
    return {
      key: s.key,
      label: s.label,
      values: [p50, p90, p95],
      tooltip: (
        <>
          <div className="mb-2 border-b border-border/50 pb-1 font-mono text-[10px] text-muted-foreground">
            {s.label} · {cnt} run{cnt === 1 ? "" : "s"}
          </div>
          {cnt === 0 ? (
            <div className="font-mono text-[11px] text-muted-foreground">
              No runs
            </div>
          ) : (
            <div className="space-y-1 font-mono text-[11px]">
              <PercentileRow
                label="p50"
                value={p50}
                color={SERIES_COLORS.p50}
              />
              <PercentileRow
                label="p90"
                value={p90}
                color={SERIES_COLORS.p90}
              />
              <PercentileRow
                label="p95"
                value={p95}
                color={SERIES_COLORS.p95}
              />
            </div>
          )}
        </>
      ),
    };
  });

  const overallCnt = overall.cnt ?? 0;
  const { p50: p50All, p90: p90All, p95: p95All } = overall;

  // Per-bucket sparkline data for each percentile. Skip null buckets so the
  // line stays meaningful — `MetricSparkline` will fall back gracefully.
  const p50Spark = buckets
    .map((b) => b.values[0])
    .filter((v): v is number => v != null);
  const p90Spark = buckets
    .map((b) => b.values[1])
    .filter((v): v is number => v != null);
  const p95Spark = buckets
    .map((b) => b.values[2])
    .filter((v): v is number => v != null);

  const { with: hrefWith } = makeHrefBuilder(pathname, {
    range,
    segment,
    branch: branchParam,
  });

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
              hrefFor={(r) => hrefWith({ range: r })}
              options={ranges}
              value={range}
            />
          </>
        }
        title="Insights"
      />

      <InsightsTabs
        active="run-duration"
        branch={branchParam}
        projectSlug={project.slug}
        range={range}
        teamSlug={project.teamSlug}
      />

      <div className="flex-1 overflow-y-auto min-h-0 px-6 py-6 pb-12 space-y-[18px]">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <AnalyticsKpiCard
            footnote={
              overallCnt === 0
                ? "No runs in window"
                : `Across ${overallCnt.toLocaleString()} runs`
            }
            label="Median duration (p50)"
            spark={p50Spark}
            value={formatOrDash(p50All)}
          />
          <AnalyticsKpiCard
            label="P90 threshold"
            spark={p90Spark}
            value={formatOrDash(p90All)}
          />
          <AnalyticsKpiCard
            label="P95 wall-clock time"
            spark={p95Spark}
            value={formatOrDash(p95All)}
          />
        </div>

        <Card className="overflow-hidden rounded-[9px] border-line-1">
          <div className="border-b border-line-1 px-[18px] py-3">
            <h2 className="text-[13px] font-semibold tracking-tight">
              Duration percentiles
            </h2>
            <p className="mt-0.5 text-[11.5px] text-fg-3">
              Per {segment} — p50, p90, p95 of run duration.
            </p>
          </div>
          <CardPanel className="px-[18px] py-4">
            <AnalyticsLineChart
              ariaLabel={`Duration percentiles across ${buckets.length} buckets`}
              buckets={buckets}
              emptyState="No runs in this window."
              formatYTick={(ms) => formatDuration(Math.round(ms))}
              height={320}
              series={series}
            />
            <div className="mt-3.5 flex items-center gap-3.5 text-[11.5px] text-fg-3">
              {series.map((s) => (
                <span className="inline-flex items-center gap-1.5" key={s.key}>
                  <span className="h-0.5 w-3" style={{ background: s.color }} />
                  {s.label}
                </span>
              ))}
            </div>
          </CardPanel>
        </Card>
      </div>
    </>
  );
}

function formatOrDash(ms: number | null): string {
  return ms === null ? "—" : formatDuration(Math.round(ms));
}

function PercentileRow({
  label,
  value,
  color,
}: {
  label: string;
  value: number | null;
  color: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: color }}
        />
        <span className="text-foreground">{label}</span>
      </span>
      <span className="text-foreground">{formatOrDash(value)}</span>
    </div>
  );
}
