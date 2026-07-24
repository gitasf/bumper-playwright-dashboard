import { use } from "react";
import {
  BucketBarChart,
  type BucketBarChartBucket,
} from "@/components/analytics/bucket-bar-chart";
import { AnalyticsButtonGroup } from "@/components/analytics/button-group";
import { InsightsTabs } from "@/components/analytics/insights-tabs";
import { AnalyticsKpiCard } from "@/components/analytics/kpi-card";
import { DeferredSection } from "@/components/defer-error-boundary";
import { PageHeader } from "@/components/page-header";
import { RunHistoryBranchFilter } from "@/components/run/history-branch-filter";
import { ALL_BRANCHES } from "@/components/run/history-branch-filter.shared";
import { ChartSkeleton, KpiCardSkeleton } from "@/components/skeletons";
import { Card, CardPanel } from "@/components/ui/card";
import { alignBuckets } from "@/lib/analytics/bucketing";
import { makeHrefBuilder } from "@/lib/page-links";
import { rate } from "@/lib/rate";
import { statusToken } from "@/lib/status";
import type { Props } from "./index.server";

const SEGMENT_NOUN: Record<string, string> = {
  day: "day",
  week: "week",
  month: "month",
};

/**
 * Insights → Run Status (default). The header, tabs, filters and chart chrome
 * paint immediately from the cheap eager shell; the outcomes cluster — three
 * KPI cards (pass rate, flakiness rate, total runs) and the stacked-bar bucket
 * chart — streams in behind skeletons via one grouped `defer()`. See the
 * server module for the aggregation.
 */
export default function InsightsPage({
  project,
  range,
  segment,
  days,
  nowSec,
  windowStartSec,
  branchParam,
  branches,
  pathname,
  outcomes,
  ranges,
}: Props) {
  const segmentNoun = SEGMENT_NOUN[segment] ?? segment;

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
        active="run-status"
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
            <RunStatusKpis
              days={days}
              nowSec={nowSec}
              outcomes={outcomes}
              segment={segment}
              windowStartSec={windowStartSec}
            />
          </DeferredSection>
        </div>

        <Card className="overflow-hidden rounded-[9px] border-line-1">
          <div className="border-b border-line-1 px-[18px] py-3">
            <h2 className="text-body font-semibold tracking-tight">
              {segmentNoun.charAt(0).toUpperCase()}
              {segmentNoun.slice(1)} outcomes
            </h2>
            <p className="mt-0.5 text-caption text-fg-3">
              One bar per {segmentNoun}. Stacked passed → flaky → failed →
              skipped.
            </p>
          </div>
          <CardPanel className="px-[18px] py-4">
            <DeferredSection
              resetKey={resetKey}
              skeleton={<ChartSkeleton height={320} />}
            >
              <OutcomesChart
                nowSec={nowSec}
                outcomes={outcomes}
                segment={segment}
                windowStartSec={windowStartSec}
              />
            </DeferredSection>
            {/* Legend is static (no data) — kept eager so it reserves its space
             * in both states and paints immediately. */}
            <div className="mt-3.5 flex items-center gap-3.5 text-caption text-fg-3">
              <LegendSwatch color={statusToken("passed")} label="Passed" />
              <LegendSwatch color={statusToken("flaky")} label="Flaky" />
              <LegendSwatch color={statusToken("failed")} label="Failed" />
              <LegendSwatch color={statusToken("skipped")} label="Skipped" />
            </div>
          </CardPanel>
        </Card>
      </div>
    </>
  );
}

/** Pass-rate / flakiness / total-runs KPI cards. Values come from the
 *  server-assembled `kpis`; the sparklines are derived per-bucket from
 *  `aggRows` (both in the grouped `outcomes` resolver). */
function RunStatusKpis({
  outcomes,
  segment,
  windowStartSec,
  nowSec,
  days,
}: {
  outcomes: Props["outcomes"];
  segment: Props["segment"];
  windowStartSec: number;
  nowSec: number;
  days: number;
}) {
  const { aggRows, kpis } = use(outcomes);
  const {
    totalFlaky,
    totalRuns,
    executed,
    passRate,
    flakyRate,
    avgRunsPerDay,
  } = kpis;

  // Per-bucket trend data for the sparklines. Iterate the aligned buckets in
  // chronological order (alignBuckets preserves shell order); empty buckets
  // fall back to 0 so the line stays continuous.
  const aligned = alignBuckets(segment, windowStartSec, nowSec, aggRows);
  const passRateSpark: number[] = [];
  const flakyRateSpark: number[] = [];
  const runsSpark: number[] = [];
  for (const s of aligned) {
    const row = s.row;
    const exec = (row?.passed ?? 0) + (row?.failed ?? 0) + (row?.flaky ?? 0);
    passRateSpark.push(rate(row?.passed ?? 0, exec));
    flakyRateSpark.push(rate(row?.flaky ?? 0, exec));
    runsSpark.push(row?.runs ?? 0);
  }

  return (
    <>
      <AnalyticsKpiCard
        footnote={
          executed === 0
            ? "No executions in window"
            : `Across ${executed.toLocaleString()} executions`
        }
        label="Overall pass rate"
        spark={passRateSpark}
        value={`${passRate.toFixed(1)}%`}
      />
      <AnalyticsKpiCard
        footnote={`${totalFlaky.toLocaleString()} flaky of ${executed.toLocaleString()} executed`}
        label="Flakiness rate"
        spark={flakyRateSpark}
        value={`${flakyRate.toFixed(1)}%`}
      />
      <AnalyticsKpiCard
        footnote={`~${avgRunsPerDay.toFixed(avgRunsPerDay < 10 ? 1 : 0)} runs / day avg`}
        label={`Total runs (${days}d)`}
        spark={runsSpark}
        value={totalRuns.toLocaleString()}
      />
    </>
  );
}

/** The stacked-bar outcomes chart. Builds buckets + tooltips (JSX, so it lives
 *  here, not the serializable resolver) from the deferred `aggRows`. */
function OutcomesChart({
  outcomes,
  segment,
  windowStartSec,
  nowSec,
}: {
  outcomes: Props["outcomes"];
  segment: Props["segment"];
  windowStartSec: number;
  nowSec: number;
}) {
  const { aggRows } = use(outcomes);
  const passedColor = statusToken("passed");
  const failedColor = statusToken("failed");
  const flakyColor = statusToken("flaky");
  const skippedColor = statusToken("skipped");

  const buckets: BucketBarChartBucket[] = alignBuckets(
    segment,
    windowStartSec,
    nowSec,
    aggRows,
  ).map((s) => {
    const row = s.row;
    const passed = row?.passed ?? 0;
    const failed = row?.failed ?? 0;
    const flaky = row?.flaky ?? 0;
    const skipped = row?.skipped ?? 0;
    const runs = row?.runs ?? 0;
    const total = passed + failed + flaky + skipped;
    return {
      key: s.key,
      label: s.label,
      total,
      segments: [
        { count: passed, color: passedColor },
        { count: failed, color: failedColor },
        { count: flaky, color: flakyColor },
        { count: skipped, color: skippedColor },
      ],
      tooltip: (
        <>
          <div className="mb-2 border-b border-line-1/50 pb-1 font-mono text-micro text-fg-3">
            {s.label}
          </div>
          <div className="space-y-1 font-mono text-micro">
            <TooltipRow label="Passed" value={passed} color={passedColor} />
            <TooltipRow label="Failed" value={failed} color={failedColor} />
            <TooltipRow label="Flaky" value={flaky} color={flakyColor} />
            <TooltipRow label="Skipped" value={skipped} color={skippedColor} />
            <div className="mt-1 flex justify-between border-t border-line-1/50 pt-1 text-fg-3">
              <span>Runs</span>
              <span>{runs.toLocaleString()}</span>
            </div>
          </div>
        </>
      ),
    };
  });

  return (
    <BucketBarChart
      ariaLabel={`Run outcomes across ${buckets.length} buckets`}
      buckets={buckets}
      height={320}
    />
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2.5 rounded-[2px]" style={{ background: color }} />
      {label}
    </span>
  );
}

function TooltipRow({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block h-2 w-2 rounded-sm"
          style={{ background: color }}
        />
        <span className="text-fg-1">{label}</span>
      </span>
      <span className="text-fg-1">{value.toLocaleString()}</span>
    </div>
  );
}
