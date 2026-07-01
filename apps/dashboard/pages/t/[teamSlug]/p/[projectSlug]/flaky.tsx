import { AnalyticsButtonGroup } from "@/components/analytics/button-group";
import { FlakyTestRow } from "@/components/flaky-test-row";
import { KpiInline } from "@/components/kpi-inline";
import { PageHeader } from "@/components/page-header";
import { PageToolbar } from "@/components/page-toolbar";
import { RunHistoryBranchFilter } from "@/components/run-history-branch-filter";
import { ALL_BRANCHES } from "@/components/run-history-branch-filter.shared";
import { TablePaginationFooter } from "@/components/table-pagination-footer";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  ranked,
  kpis,
  sparkByTest,
  failsByTest,
  ownersByTestId,
  ownerError,
  pathname,
  fullPath,
  ranges,
}: Props) {
  const base = `/t/${project.teamSlug}/p/${project.slug}`;
  const ownerActionPath = `/api/t/${project.teamSlug}/p/${project.slug}/owners`;
  const { with: hrefWith } = makeHrefBuilder(pathname, {
    range,
    branch: branchParam,
  });
  const rangeHref = (r: string): string => hrefWith({ range: r });

  const { totalFailures, avgFlakeRate } = kpis;

  return (
    <>
      <PageHeader title="Flaky tests" />

      <PageToolbar>
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
      </PageToolbar>

      {ownerError && (
        <div className="shrink-0 px-6 pt-3">
          <Alert variant="error">
            <AlertDescription>{ownerError}</AlertDescription>
          </Alert>
        </div>
      )}

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
        <>
          <div className="flex-1 overflow-y-auto min-h-0">
            <Table className="table-fixed">
              <TableHeader className="sticky top-0 z-10 bg-bg-0/95 backdrop-blur-sm">
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
                  <TableHead className="w-[210px] px-4 text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
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
                      canManageOwners={project.canManageOwners}
                      file={meta?.file ?? ""}
                      key={row.testId}
                      ownerActionPath={ownerActionPath}
                      ownerRedirectTo={fullPath}
                      owners={ownersByTestId[row.testId] ?? []}
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
          <TablePaginationFooter
            currentPage={1}
            fromRow={1}
            itemNoun="flaky test"
            pageHref={() => pathname}
            toRow={ranked.length}
            totalCount={totalFlakyTests}
            totalPages={1}
          />
        </>
      )}
    </>
  );
}
