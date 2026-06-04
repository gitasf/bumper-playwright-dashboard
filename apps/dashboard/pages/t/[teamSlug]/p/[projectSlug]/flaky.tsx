import { AnalyticsButtonGroup } from "@/components/analytics/button-group";
import { FlakyTestRow } from "@/components/flaky-test-row";
import { KpiInline } from "@/components/kpi-inline";
import { PageHeader } from "@/components/page-header";
import { RunHistoryBranchFilter } from "@/components/run-history-branch-filter";
import { ALL_BRANCHES } from "@/components/run-history-branch-filter.shared";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { makeHrefBuilder } from "@/lib/page-links";
import type { Props } from "./flaky.server";

/**
 * Flaky tests page. Mirrors the design bundle's `FlakyScreen` (see
 * `wrightful/project/screen-flaky-tests.jsx:4-65`):
 *   PageHeader → KPI strip + range controls → sticky search → table.
 */
export default function FlakyTestsPage({
  project,
  range,
  branchParam,
  branchAll,
  branchFilter,
  branches,
  rangeDays,
  totalFlakyTests,
  truncated,
  ranked,
  sparkByTest,
  failsByTest,
  pathname,
  ranges,
}: Props) {
  const base = `/t/${project.teamSlug}/p/${project.slug}`;
  const { with: hrefWith } = makeHrefBuilder(pathname, {
    range,
    branch: branchParam,
  });
  const rangeHref = (r: string): string => hrefWith({ range: r });

  const totalFailures = ranked.reduce((sum, r) => sum + r.flakyCount, 0);
  const avgFlakeRate =
    ranked.length === 0
      ? 0
      : ranked.reduce((sum, r) => sum + r.pct, 0) / ranked.length;

  return (
    <>
      <PageHeader
        subtitle={
          <>
            <span className="font-mono">{project.slug}</span> ·{" "}
            {totalFlakyTests} test{totalFlakyTests === 1 ? "" : "s"} with at
            least one retry in the last {rangeDays} days
            {truncated ? ` — showing top ${ranked.length}` : ""}
          </>
        }
        title="Flaky tests"
      />

      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-6 py-3.5">
        <KpiInline label="Tracked tests" value={totalFlakyTests} />
        <KpiInline
          accent="var(--flaky)"
          label="Avg flake rate"
          value={`${avgFlakeRate.toFixed(1)}%`}
        />
        <KpiInline label="Total failures" value={totalFailures} />
        <div className="flex-1" />
        <RunHistoryBranchFilter
          branches={branches}
          defaultValue={branchParam ?? ALL_BRANCHES}
        />
        <AnalyticsButtonGroup
          hrefFor={rangeHref}
          options={ranges as readonly ("7d" | "14d" | "30d")[]}
          value={range}
        />
      </div>

      {ranked.length === 0 ? (
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="flex items-center justify-center h-full p-10">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No flaky tests in this window</EmptyTitle>
                <EmptyDescription>
                  Nothing failed on retry in the last {rangeDays} days
                  {branchAll ? "" : ` on ${branchFilter}`}. Try a wider window
                  or a different branch.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <span className="text-xs text-muted-foreground font-mono">
                  {branches.length > 0 && (
                    <>
                      Branches: {branches.slice(0, 3).join(", ")}
                      {branches.length > 3 ? "…" : ""}
                    </>
                  )}
                </span>
              </EmptyContent>
            </Empty>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto min-h-0">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 px-4" />
                <TableHead className="px-4 text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                  Test
                </TableHead>
                <TableHead className="w-[110px] px-4 text-right text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                  Flake rate
                </TableHead>
                <TableHead className="w-[180px] px-4 text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                  {rangeDays}d trend
                </TableHead>
                <TableHead className="w-[280px] px-4 text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                  Last failure
                </TableHead>
                <TableHead className="w-[120px] px-4 text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                  Owner
                </TableHead>
                <TableHead className="w-[90px] px-4 text-right text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                  Last seen
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ranked.map((row) => {
                const meta = sparkByTest[row.testId];
                const fails = failsByTest[row.testId] ?? [];
                const latest = fails[0];
                const rowHref = latest
                  ? `${base}/runs/${latest.runId}/tests/${latest.testResultId}?attempt=0`
                  : base;
                return (
                  <FlakyTestRow
                    file={meta?.file ?? ""}
                    key={row.testId}
                    pct={row.pct}
                    rangeDays={rangeDays}
                    recentFailures={fails}
                    rowHref={rowHref}
                    sparklinePoints={meta?.sparkline ?? []}
                    tags={meta?.tags ?? []}
                    testId={row.testId}
                    title={meta?.title ?? row.testId}
                  />
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
