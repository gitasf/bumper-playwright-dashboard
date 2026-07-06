import { use } from "react";
import { AnalyticsButtonGroup } from "@/components/analytics/button-group";
import { DeferredSection } from "@/components/defer-error-boundary";
import { FlakyTestRow } from "@/components/flaky-test-row";
import { KpiInline } from "@/components/kpi-inline";
import { PageHeader } from "@/components/page-header";
import { PageToolbar } from "@/components/page-toolbar";
import { RunHistoryBranchFilter } from "@/components/run-history-branch-filter";
import { ALL_BRANCHES } from "@/components/run-history-branch-filter.shared";
import { TablePaginationFooterSkeleton } from "@/components/skeletons";
import { TablePaginationFooter } from "@/components/table-pagination-footer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Empty,
  EmptyContent,
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
import { makeHrefBuilder } from "@/lib/page-links";
import type { Props } from "./flaky.server";

// Skeleton row count while the table streams. The real count (ranked.length,
// ≤ TOP_N) isn't known until PASS 1 resolves; the table is the terminal region
// on the page, so a differing resolved count resizes it in place without
// shifting anything above it.
const SKELETON_ROWS = 8;

/**
 * Flaky tests page. Mirrors the design bundle's `FlakyScreen` (see
 * `wrightful/project/screen-flaky-tests.jsx:4-65`):
 *   PageHeader → KPI strip + range controls → sticky search → table.
 *
 * The whole flaky payload (aggregate + per-test fan-out — the heaviest reads in
 * the app) streams in via one grouped `defer()`: the header, branch filter and
 * range controls paint immediately, while the KPI strip and the table stream
 * behind skeletons. Both regions read the same deferred `flaky` prop.
 */
export default function FlakyTestsPage({
  project,
  range,
  branchParam,
  branchAll,
  branchFilter,
  branches,
  rangeDays,
  flaky,
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

  // A deferred region that fails latches its error boundary; clear it when the
  // filters change so the SPA-nav re-fetch re-attempts the region.
  const resetKey = `${range}:${branchParam ?? ""}`;

  return (
    <>
      <PageHeader title="Flaky tests" />

      <PageToolbar>
        {/* KPI values come from PASS 1 (deferred). On the rare resolver
         * rejection, hide the strip rather than inject an error card into the
         * fixed-height toolbar — the table's error card carries the message. */}
        <DeferredSection
          errorFallback={<></>}
          resetKey={resetKey}
          skeleton={<FlakyKpiSkeleton />}
        >
          <FlakyKpiStrip flaky={flaky} />
        </DeferredSection>
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

      <DeferredSection
        resetKey={resetKey}
        skeleton={<FlakyTableSkeleton rangeDays={rangeDays} />}
      >
        <FlakyTableRegion
          base={base}
          branchAll={branchAll}
          branchFilter={branchFilter}
          branches={branches}
          canManageOwners={project.canManageOwners}
          flaky={flaky}
          fullPath={fullPath}
          ownerActionPath={ownerActionPath}
          pathname={pathname}
          rangeDays={rangeDays}
        />
      </DeferredSection>
    </>
  );
}

/** The three toolbar KPI stats (tracked tests / avg flake rate / total
 *  failures). All derive from PASS 1, so they read the deferred `flaky`. */
function FlakyKpiStrip({ flaky }: { flaky: Props["flaky"] }) {
  const { totalFlakyTests, kpis } = use(flaky);
  return (
    <>
      <KpiInline label="Tracked tests" value={totalFlakyTests} />
      <KpiInline
        accent="var(--flaky)"
        label="Avg flake rate"
        value={`${kpis.avgFlakeRate.toFixed(1)}%`}
      />
      <KpiInline label="Total failures" value={kpis.totalFailures} />
    </>
  );
}

/** Fallback for the KPI strip — three `KpiInline`-shaped placeholders (label +
 *  value + the same right divider). The toolbar is a fixed `min-h-13`, so the
 *  bars' exact height can't shift it; the dividers keep the horizontal rhythm. */
function FlakyKpiSkeleton() {
  const widths = ["w-8", "w-12", "w-8"];
  return (
    <>
      {widths.map((valueW, i) => (
        <div
          className="flex items-baseline gap-1.5 border-r border-border pr-3 mr-1"
          key={i}
        >
          <Skeleton className="h-[10.5px] w-20" />
          <Skeleton className={`h-[13px] ${valueW}`} />
        </div>
      ))}
    </>
  );
}

/** The flaky table — Empty state or the ranked rows + pagination footer. Reads
 *  the deferred `flaky` payload; every field here (ranked, spark/fails/owners,
 *  total) comes from the same grouped resolver. */
function FlakyTableRegion({
  flaky,
  base,
  ownerActionPath,
  fullPath,
  rangeDays,
  branchAll,
  branchFilter,
  branches,
  canManageOwners,
  pathname,
}: {
  flaky: Props["flaky"];
  base: string;
  ownerActionPath: string;
  fullPath: string;
  rangeDays: number;
  branchAll: boolean;
  branchFilter: string | null;
  branches: string[];
  canManageOwners: boolean;
  pathname: string;
}) {
  const { totalFlakyTests, ranked, sparkByTest, failsByTest, ownersByTestId } =
    use(flaky);

  if (ranked.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="flex items-center justify-center h-full p-10">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No flaky tests in this window</EmptyTitle>
              <EmptyDescription>
                Nothing failed on retry in the last {rangeDays} days
                {branchAll ? "" : ` on ${branchFilter}`}. Try a wider window or
                a different branch.
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
    );
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto min-h-0">
        <Table className="table-fixed">
          <FlakyTableHead rangeDays={rangeDays} />
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
                  canManageOwners={canManageOwners}
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
  );
}

/** Shared table header (7 columns) used by both the live table and its
 *  skeleton so the column widths can't drift between states. */
function FlakyTableHead({ rangeDays }: { rangeDays: number }) {
  return (
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
  );
}

/** Fallback matching the flaky table. Cells inherit `leading-none`, so the
 *  two-line Test cell reserves raw `h-[13px]` + `h-[11px]` (= 26px content,
 *  a 51px row) — same shape as `FlakyTestRow`. Terminal region, so a differing
 *  resolved row count/Empty state resizes it in place without shifting above. */
function FlakyTableSkeleton({ rangeDays }: { rangeDays: number }) {
  return (
    <>
      <div className="flex-1 overflow-y-auto min-h-0">
        <Table className="table-fixed">
          <FlakyTableHead rangeDays={rangeDays} />
          <TableBody>
            {Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <TableRow key={i}>
                <TableCell className="w-10 px-4 align-middle">
                  <Skeleton className="mx-auto h-3.5 w-3.5 rounded-full" />
                </TableCell>
                <TableCell className="px-4 py-3 align-middle">
                  {/* leading-none: text-[13px] + mt-0.5 + text-[11px] = 26px */}
                  <div className="min-w-0">
                    <Skeleton className="h-[13px] w-2/3" />
                    <Skeleton className="mt-0.5 h-[11px] w-1/2" />
                  </div>
                </TableCell>
                <TableCell className="w-[110px] px-4 py-3 align-middle">
                  <Skeleton className="ml-auto h-[13px] w-10" />
                  <Skeleton className="mt-0.5 ml-auto h-[10.5px] w-12" />
                </TableCell>
                <TableCell className="w-[180px] px-4 py-3 align-middle">
                  <Skeleton className="h-[22px] w-40" />
                </TableCell>
                <TableCell className="w-[280px] max-w-[280px] px-4 py-3 align-middle">
                  <Skeleton className="h-[11.5px] w-full" />
                </TableCell>
                <TableCell className="w-[210px] px-4 py-3 align-middle">
                  <Skeleton className="h-5 w-24 rounded-full" />
                </TableCell>
                <TableCell className="w-[90px] px-4 py-3 text-right align-middle">
                  <Skeleton className="ml-auto h-3 w-12" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {/* The flaky footer is always single-page (no pager), so showPager stays
       * false — just the "Showing …" line. */}
      <TablePaginationFooterSkeleton />
    </>
  );
}
