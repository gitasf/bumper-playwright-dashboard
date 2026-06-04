import {
  BucketBarChart,
  type BucketBarChartBucket,
} from "@/components/analytics/bucket-bar-chart";
import { AnalyticsButtonGroup } from "@/components/analytics/button-group";
import { InsightsTabs } from "@/components/analytics/insights-tabs";
import { AnalyticsKpiCard } from "@/components/analytics/kpi-card";
import { PageHeader } from "@/components/page-header";
import { RunHistoryBranchFilter } from "@/components/run-history-branch-filter";
import { ALL_BRANCHES } from "@/components/run-history-branch-filter.shared";
import { Card, CardPanel } from "@/components/ui/card";
import { alignBuckets } from "@/lib/analytics/bucketing";
import { makeHrefBuilder } from "@/lib/page-links";
import { statusToken } from "@/lib/status";
import type { Props } from "./index.server";

const SEGMENT_NOUN: Record<string, string> = {
  day: "day",
  week: "week",
  month: "month",
};

/**
 * Insights → Run Status (default). Stacked-bar bucket chart of pass/fail/
 * flaky/skipped counts per segment, plus three KPI cards (pass rate,
 * flakiness rate, total runs).
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
  aggRows,
  ranges,
}: Props) {
  const aligned = alignBuckets(segment, windowStartSec, nowSec, aggRows);

  const passedColor = statusToken("passed");
  const failedColor = statusToken("failed");
  const flakyColor = statusToken("flaky");
  const skippedColor = statusToken("skipped");

  const buckets: BucketBarChartBucket[] = aligned.map((s) => {
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
          <div className="mb-2 border-b border-border/50 pb-1 font-mono text-[10px] text-muted-foreground">
            {s.label}
          </div>
          <div className="space-y-1 font-mono text-[11px]">
            <TooltipRow label="Passed" value={passed} color={passedColor} />
            <TooltipRow label="Failed" value={failed} color={failedColor} />
            <TooltipRow label="Flaky" value={flaky} color={flakyColor} />
            <TooltipRow label="Skipped" value={skipped} color={skippedColor} />
            <div className="mt-1 flex justify-between border-t border-border/50 pt-1 text-muted-foreground">
              <span>Runs</span>
              <span>{runs.toLocaleString()}</span>
            </div>
          </div>
        </>
      ),
    };
  });

  let totalPassed = 0;
  let totalFailed = 0;
  let totalFlaky = 0;
  let totalRuns = 0;
  for (const r of aggRows) {
    totalPassed += r.passed;
    totalFailed += r.failed;
    totalFlaky += r.flaky;
    totalRuns += r.runs;
  }
  const executed = totalPassed + totalFailed + totalFlaky;
  const passRate = executed === 0 ? 0 : (totalPassed / executed) * 100;
  const flakyRate = executed === 0 ? 0 : (totalFlaky / executed) * 100;
  const avgRunsPerDay = totalRuns / days;

  // Per-bucket trend data for the KPI sparklines. Iterates the aligned
  // buckets in chronological order (alignBuckets preserves shell order) and
  // computes the rate or count per bucket; falls back to 0 for empty
  // buckets so the line stays continuous.
  const passRateSpark: number[] = [];
  const flakyRateSpark: number[] = [];
  const runsSpark: number[] = [];
  for (const s of aligned) {
    const row = s.row;
    const exec = (row?.passed ?? 0) + (row?.failed ?? 0) + (row?.flaky ?? 0);
    passRateSpark.push(exec === 0 ? 0 : ((row?.passed ?? 0) / exec) * 100);
    flakyRateSpark.push(exec === 0 ? 0 : ((row?.flaky ?? 0) / exec) * 100);
    runsSpark.push(row?.runs ?? 0);
  }

  const segmentNoun = SEGMENT_NOUN[segment] ?? segment;

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
              options={ranges as readonly ("7d" | "14d" | "30d" | "90d")[]}
              value={range}
            />
          </>
        }
        subtitle={
          <>
            <span className="font-mono">{project.slug}</span> · trends across
            the last {days} days
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
        </div>

        <Card className="overflow-hidden rounded-[9px] border-line-1">
          <div className="border-b border-line-1 px-[18px] py-3">
            <h2 className="text-[13px] font-semibold tracking-tight">
              {segmentNoun.charAt(0).toUpperCase()}
              {segmentNoun.slice(1)} outcomes
            </h2>
            <p className="mt-0.5 text-[11.5px] text-fg-3">
              One bar per {segmentNoun}. Stacked passed → flaky → failed →
              skipped.
            </p>
          </div>
          <CardPanel className="px-[18px] py-4">
            <BucketBarChart
              ariaLabel={`Run outcomes across ${buckets.length} buckets`}
              buckets={buckets}
              height={320}
            />
            <div className="mt-3.5 flex items-center gap-3.5 text-[11.5px] text-fg-3">
              <LegendSwatch color={passedColor} label="Passed" />
              <LegendSwatch color={flakyColor} label="Flaky" />
              <LegendSwatch color={failedColor} label="Failed" />
              <LegendSwatch color={skippedColor} label="Skipped" />
            </div>
          </CardPanel>
        </Card>
      </div>
    </>
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
        <span className="text-foreground">{label}</span>
      </span>
      <span className="text-foreground">{value.toLocaleString()}</span>
    </div>
  );
}
