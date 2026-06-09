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
import { cn } from "@/lib/cn";
import { makeHrefBuilder } from "@/lib/page-links";
import type { Props } from "./suite-size.server";

const COUNT_SERIES: LineChartSeries[] = [
  { key: "count", label: "Tests", color: "var(--color-foreground)" },
];

/**
 * Suite Size analytics page. Trend chart (peak suite size per bucket) plus
 * KPIs (total tests, tests added in last 30d), distribution by spec file,
 * and top tags.
 */
export default function SuiteSizePage({
  project,
  range,
  segment,
  nowSec,
  shellStartSec,
  branchParam,
  branches,
  trendRows,
  testsAdded,
  addedLookbackDays,
  peakOverall,
  fileRows,
  tagRows,
  pathname,
  ranges,
}: Props) {
  const buckets: LineChartBucket[] = alignBuckets(
    segment,
    shellStartSec,
    nowSec,
    trendRows,
  ).map((s) => {
    // Empty buckets — bucket data hasn't been recorded — render as gaps in
    // the line. `null` skips that segment instead of pulling the line down
    // to zero, which would falsely imply "all tests were deleted".
    const peak = s.row?.peak;
    return {
      key: s.key,
      label: s.label,
      values: [peak ?? null],
      tooltip: (
        <>
          <div className="mb-1 border-b border-border/50 pb-1 font-mono text-[10px] text-muted-foreground">
            {s.label}
          </div>
          <div className="font-mono text-xs">
            {peak == null ? (
              <span className="text-muted-foreground">No data</span>
            ) : (
              <>
                <span className="text-foreground">{peak.toLocaleString()}</span>{" "}
                <span className="text-muted-foreground">tests</span>
              </>
            )}
          </div>
        </>
      ),
    };
  });

  const fileTotal = fileRows.reduce((acc, r) => acc + r.tests, 0);

  // Per-bucket peak series for the "Total tests" KPI sparkline. Drop null
  // entries so the sparkline only plots populated buckets.
  const peakSpark = buckets
    .map((b) => b.values[0])
    .filter((v): v is number => v != null);
  const firstPeak = peakSpark[0] ?? 0;
  const lastPeak = peakSpark.at(-1) ?? firstPeak;
  const netChange = lastPeak - firstPeak;
  const growthPct =
    firstPeak === 0 ? 0 : ((lastPeak - firstPeak) / firstPeak) * 100;

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
        subtitle={
          <>
            <span className="font-mono">{project.slug}</span> · test volume and
            distribution over the last {parseInt(range, 10)} days
          </>
        }
        title="Insights"
      />

      <InsightsTabs
        active="suite-size"
        branch={branchParam}
        projectSlug={project.slug}
        range={range}
        teamSlug={project.teamSlug}
      />

      <div className="flex-1 overflow-y-auto min-h-0 px-6 py-6 pb-12 space-y-[18px]">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <AnalyticsKpiCard
            footnote="Peak suite size observed in the window"
            label="Total tests"
            spark={peakSpark}
            value={peakOverall.toLocaleString()}
          />
          <AnalyticsKpiCard
            footnote="Tests whose first-ever run is in the window"
            label={`Tests added (${addedLookbackDays}d)`}
            value={testsAdded.toLocaleString()}
          />
          <AnalyticsKpiCard
            delta={Math.round(growthPct * 10) / 10}
            footnote={`From ${firstPeak.toLocaleString()} → ${lastPeak.toLocaleString()}`}
            label="Net change"
            value={`${netChange >= 0 ? "+" : ""}${netChange.toLocaleString()}`}
          />
        </div>

        <Card className="overflow-hidden rounded-[9px] border-line-1">
          <div className="border-b border-line-1 px-[18px] py-3">
            <h2 className="text-[13px] font-semibold tracking-tight">
              Test count over time
            </h2>
            <p className="mt-0.5 text-[11.5px] text-fg-3">
              Peak suite size per {segment}. Catches accidental deletions and
              big-bang additions.
            </p>
          </div>
          <CardPanel className="px-[18px] py-4">
            <AnalyticsLineChart
              ariaLabel={`Suite size trend across ${buckets.length} buckets`}
              buckets={buckets}
              emptyState="No runs in this window."
              formatYTick={(v) => Math.round(v).toLocaleString()}
              height={320}
              series={COUNT_SERIES}
            />
          </CardPanel>
        </Card>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <Card className="overflow-hidden rounded-[9px] border-line-1 lg:col-span-2">
            <div className="border-b border-line-1 px-[18px] py-3">
              <h2 className="text-[13px] font-semibold tracking-tight">
                Distribution by spec file
              </h2>
              <p className="mt-0.5 text-[11.5px] text-fg-3">
                Top {fileRows.length} files by distinct test count.
              </p>
            </div>
            <CardPanel className="px-[18px] py-3">
              {fileRows.length === 0 ? (
                <EmptyRow>No tests in this window.</EmptyRow>
              ) : (
                <ul className="space-y-2.5">
                  {fileRows.map((r) => (
                    <DistributionRow
                      key={r.file}
                      label={r.file}
                      total={fileTotal}
                      value={r.tests}
                    />
                  ))}
                </ul>
              )}
            </CardPanel>
          </Card>

          <Card className="overflow-hidden rounded-[9px] border-line-1">
            <div className="border-b border-line-1 px-[18px] py-3">
              <h2 className="text-[13px] font-semibold tracking-tight">
                Top tags
              </h2>
              <p className="mt-0.5 text-[11.5px] text-fg-3">
                Distinct tests per tag.
              </p>
            </div>
            <CardPanel className="px-[18px] py-3">
              {tagRows.length === 0 ? (
                <EmptyRow>No tagged tests.</EmptyRow>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {tagRows.map((r) => (
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full border border-line-1 bg-bg-2 px-2 py-px font-mono text-[11.5px] text-fg-2"
                      key={r.tag}
                      style={{ lineHeight: "18px" }}
                    >
                      <span style={{ color: "var(--running)" }}>{r.tag}</span>
                      <span className="text-fg-4">
                        {r.tests.toLocaleString()}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </CardPanel>
          </Card>
        </div>
      </div>
    </>
  );
}

function DistributionRow({
  label,
  value,
  total,
}: {
  label: string;
  value: number;
  total: number;
}) {
  const pct = total === 0 ? 0 : (value / total) * 100;
  return (
    <li className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-foreground">
          {label}
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full bg-foreground/80")}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <div className="w-16 text-right font-mono text-sm text-foreground">
        {value.toLocaleString()}
      </div>
      <div className="w-12 text-right font-mono text-[11px] text-muted-foreground">
        {pct.toFixed(0)}%
      </div>
    </li>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="py-6 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}
