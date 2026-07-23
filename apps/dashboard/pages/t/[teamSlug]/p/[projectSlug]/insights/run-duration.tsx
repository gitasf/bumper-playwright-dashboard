import { use } from "react";
import { AnalyticsButtonGroup } from "@/components/analytics/button-group";
import { InsightsTabs } from "@/components/analytics/insights-tabs";
import { AnalyticsKpiCard } from "@/components/analytics/kpi-card";
import {
  AnalyticsLineChart,
  type LineChartBucket,
  type LineChartSeries,
} from "@/components/analytics/line-chart";
import { DeferredSection } from "@/components/defer-error-boundary";
import { PageHeader } from "@/components/page-header";
import { RunHistoryBranchFilter } from "@/components/run/history-branch-filter";
import { ALL_BRANCHES } from "@/components/run/history-branch-filter.shared";
import { ChartSkeleton, KpiCardSkeleton } from "@/components/skeletons";
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

const SERIES: LineChartSeries[] = [
  { key: "p50", label: "p50", color: SERIES_COLORS.p50 },
  { key: "p90", label: "p90", color: SERIES_COLORS.p90 },
  { key: "p95", label: "p95", color: SERIES_COLORS.p95 },
];

/**
 * Run Duration analytics page. The header, tabs, filters and chart chrome paint
 * immediately from the cheap eager shell; the two percentile passes stream in
 * behind skeletons via one grouped `defer()` — the KPI cards (overall values +
 * per-bucket sparklines) and the p50/p90/p95 line chart. See the server module.
 */
export default function RunDurationPage({
  project,
  range,
  segment,
  nowSec,
  windowStartSec,
  branchParam,
  branches,
  duration,
  pathname,
  ranges,
}: Props) {
  const { with: hrefWith } = makeHrefBuilder(pathname, {
    range,
    segment,
    branch: branchParam,
  });

  // A deferred region that fails latches its error boundary; clear it when the
  // filters change so the SPA-nav re-fetch re-attempts the region.
  const resetKey = `${range}:${branchParam ?? ""}:${segment}`;

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
          <DeferredSection
            resetKey={resetKey}
            skeleton={
              <>
                <KpiCardSkeleton />
                <KpiCardSkeleton />
                <KpiCardSkeleton />
              </>
            }
          >
            <DurationKpis
              duration={duration}
              nowSec={nowSec}
              segment={segment}
              windowStartSec={windowStartSec}
            />
          </DeferredSection>
        </div>

        <Card className="overflow-hidden rounded-[9px] border-line-1">
          <div className="border-b border-line-1 px-[18px] py-3">
            <h2 className="text-body font-semibold tracking-tight">
              Duration percentiles
            </h2>
            <p className="mt-0.5 text-caption text-fg-3">
              Per {segment} — p50, p90, p95 of run duration.
            </p>
          </div>
          <CardPanel className="px-[18px] py-4">
            <DeferredSection
              resetKey={resetKey}
              skeleton={<ChartSkeleton height={320} />}
            >
              <DurationChart
                duration={duration}
                nowSec={nowSec}
                segment={segment}
                windowStartSec={windowStartSec}
              />
            </DeferredSection>
            {/* Legend is static (derived from SERIES, no data) — kept eager so
             * it reserves its space in both states and paints immediately. */}
            <div className="mt-3.5 flex items-center gap-3.5 text-caption text-fg-3">
              {SERIES.map((s) => (
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

/** p50/p90/p95 KPI cards. Values come from `overall`; the per-bucket sparklines
 *  are derived from `perBucket` (both in the grouped `duration` resolver). */
function DurationKpis({
  duration,
  segment,
  windowStartSec,
  nowSec,
}: {
  duration: Props["duration"];
  segment: Props["segment"];
  windowStartSec: number;
  nowSec: number;
}) {
  const { overall, perBucket } = use(duration);
  const overallCnt = overall.cnt ?? 0;

  // Per-bucket sparkline data for each percentile. Align onto the window
  // skeleton, then drop null buckets so the line stays meaningful.
  const aligned = alignBuckets(segment, windowStartSec, nowSec, perBucket);
  const p50Spark = aligned
    .map((s) => s.row?.p50)
    .filter((v): v is number => v != null);
  const p90Spark = aligned
    .map((s) => s.row?.p90)
    .filter((v): v is number => v != null);
  const p95Spark = aligned
    .map((s) => s.row?.p95)
    .filter((v): v is number => v != null);

  return (
    <>
      <AnalyticsKpiCard
        footnote={
          overallCnt === 0
            ? "No runs in window"
            : `Across ${overallCnt.toLocaleString()} runs`
        }
        label="Median duration (p50)"
        spark={p50Spark}
        value={formatOrDash(overall.p50)}
      />
      <AnalyticsKpiCard
        label="P90 threshold"
        spark={p90Spark}
        value={formatOrDash(overall.p90)}
      />
      <AnalyticsKpiCard
        label="P95 wall-clock time"
        spark={p95Spark}
        value={formatOrDash(overall.p95)}
      />
    </>
  );
}

/** The p50/p90/p95 duration line chart. Builds buckets + tooltips (JSX, so it
 *  lives here, not the serializable resolver) from the deferred `perBucket`. */
function DurationChart({
  duration,
  segment,
  windowStartSec,
  nowSec,
}: {
  duration: Props["duration"];
  segment: Props["segment"];
  windowStartSec: number;
  nowSec: number;
}) {
  const { perBucket } = use(duration);
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
          <div className="mb-2 border-b border-line-1/50 pb-1 font-mono text-micro text-fg-3">
            {s.label} · {cnt} run{cnt === 1 ? "" : "s"}
          </div>
          {cnt === 0 ? (
            <div className="font-mono text-micro text-fg-3">No runs</div>
          ) : (
            <div className="space-y-1 font-mono text-micro">
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

  return (
    <AnalyticsLineChart
      ariaLabel={`Duration percentiles across ${buckets.length} buckets`}
      buckets={buckets}
      emptyState="No runs in this window."
      formatYTick={(ms) => formatDuration(Math.round(ms))}
      height={320}
      series={SERIES}
    />
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
        <span className="text-fg-1">{label}</span>
      </span>
      <span className="text-fg-1">{formatOrDash(value)}</span>
    </div>
  );
}
