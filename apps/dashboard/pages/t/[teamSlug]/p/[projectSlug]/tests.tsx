import { Link } from "@void/react";
import { AnalyticsButtonGroup } from "@/components/analytics/button-group";
import { OutcomeBar } from "@/components/outcome-bar";
import { PageHeader } from "@/components/page-header";
import { RunHistoryBranchFilter } from "@/components/run-history-branch-filter";
import { ALL_BRANCHES } from "@/components/run-history-branch-filter.shared";
import { SearchFilterInput } from "@/components/search-filter-input";
import { TablePaginationFooter } from "@/components/table-pagination-footer";
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
import { makeHrefBuilder } from "@/lib/page-links";
import { statusToken } from "@/lib/status";
import { formatDuration, formatRelativeTime } from "@/lib/time-format";
import type { Props } from "./tests.server";

/**
 * Test catalog page. Every distinct testId observed in the window, with
 * counters, average duration, and a tiny pass/flaky/fail outcome bar.
 * Layout mirrors the design bundle's `TestsCatalogScreen` (see
 * `wrightful/project/screen-flaky-tests.jsx:134-189`).
 */
export default function TestsPage({
  project,
  range,
  branchParam,
  branchFilter,
  branches,
  q,
  rows,
  totalUniqueTests,
  currentPage,
  totalPages,
  fromRow,
  toRow,
  pathname,
  ranges,
}: Props) {
  const base = `/t/${project.teamSlug}/p/${project.slug}`;

  const { with: hrefWith, pageHref } = makeHrefBuilder(pathname, {
    range,
    branch: branchParam,
    q,
    page: currentPage > 1 ? String(currentPage) : null,
  });

  return (
    <>
      <PageHeader
        title="Tests catalog"
        subtitle={
          <>
            <span className="font-mono">{project.slug}</span> ·{" "}
            {totalUniqueTests.toLocaleString()} unique test
            {totalUniqueTests === 1 ? "" : "s"} across{" "}
            {branchParam ? branchFilter : "all branches"}
          </>
        }
      />

      <div className="sticky top-0 z-[4] flex shrink-0 flex-wrap items-center gap-2.5 border-b border-border bg-background px-6 py-2.5">
        <form className="max-w-[360px] flex-1" method="get">
          <input name="range" type="hidden" value={range} />
          {branchParam ? (
            <input name="branch" type="hidden" value={branchParam} />
          ) : null}
          <SearchFilterInput
            defaultValue={q}
            name="q"
            placeholder="Search by test name or path…"
          />
        </form>
        <RunHistoryBranchFilter
          branches={branches}
          defaultValue={branchParam ?? ALL_BRANCHES}
        />
        <div className="flex-1" />
        <AnalyticsButtonGroup
          hrefFor={(r) => hrefWith({ range: r, page: null })}
          options={ranges as readonly ("7d" | "14d" | "30d")[]}
          value={range}
        />
      </div>

      {rows.length === 0 ? (
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="flex items-center justify-center h-full p-10">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No tests in this window</EmptyTitle>
                <EmptyDescription>
                  {q
                    ? `No tests match "${q}". Try a wider window or clear the filter.`
                    : `No runs recorded in the last ${range}${
                        branchFilter ? ` on ${branchFilter}` : ""
                      }.`}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto min-h-0">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 px-4" />
                  <TableHead className="px-4 text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                    Test
                  </TableHead>
                  <TableHead className="w-[90px] px-4 text-right text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                    Total runs
                  </TableHead>
                  <TableHead className="w-[200px] px-4 text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                    Mix
                  </TableHead>
                  <TableHead className="w-[110px] px-4 text-right text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                    Avg duration
                  </TableHead>
                  <TableHead className="w-[100px] px-4 text-right text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                    Last seen
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const dotColor = mixToneColor(row);
                  const title = row.title || row.testId;
                  const href =
                    row.latestRunId && row.latestTestResultId
                      ? `${base}/runs/${row.latestRunId}/tests/${row.latestTestResultId}?attempt=0`
                      : base;
                  return (
                    <TableRow key={row.testId}>
                      <TableCell className="w-10 px-4 py-3 align-middle">
                        {/* Stretched-link pattern — the `<Link>` is
                         * position: static so its `after:inset-0` pseudo
                         * fills the nearest positioned ancestor (the
                         * TableRow with `relative`). Whole row becomes
                         * the click target. */}
                        <Link
                          className="flex items-center justify-center focus-visible:outline-none after:absolute after:inset-0 after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring"
                          href={href}
                        >
                          <span className="sr-only">View {title}</span>
                          <span
                            aria-hidden
                            className="inline-block size-2 rounded-full"
                            style={{ backgroundColor: dotColor }}
                          />
                        </Link>
                      </TableCell>
                      <TableCell className="px-4 py-3 align-middle">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="truncate text-[13px] text-foreground"
                            title={title}
                          >
                            {title}
                          </span>
                          <span
                            className="truncate font-mono text-[11px] text-muted-foreground"
                            title={row.file}
                          >
                            {row.file}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="w-[90px] px-4 py-3 text-right align-middle font-mono text-[12px] tabular-nums text-muted-foreground">
                        {row.n.toLocaleString()}
                      </TableCell>
                      <TableCell className="w-[200px] px-4 py-3 align-middle">
                        <OutcomeBar
                          emptyDash
                          failed={row.failCount}
                          flaky={row.flakyCount}
                          height={6}
                          maxWidth={180}
                          minWidth={0}
                          passed={row.passedCount}
                          skipped={row.skippedCount}
                        />
                      </TableCell>
                      <TableCell className="w-[110px] px-4 py-3 text-right align-middle font-mono text-[12px] tabular-nums text-foreground">
                        {row.avgDurationMs === null
                          ? "—"
                          : formatDuration(Math.round(row.avgDurationMs))}
                      </TableCell>
                      <TableCell className="w-[100px] px-4 py-3 text-right align-middle text-[12px] text-muted-foreground">
                        {formatRelativeTime(row.lastSeen)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {totalPages > 1 && (
            <TablePaginationFooter
              currentPage={currentPage}
              fromRow={fromRow}
              itemNoun="test"
              pageHref={pageHref}
              toRow={toRow}
              totalCount={totalUniqueTests}
              totalPages={totalPages}
            />
          )}
        </>
      )}
    </>
  );
}

/**
 * Worst-case status dot — failed > flaky > passed > skipped. Mirrors the
 * reference catalog row's single-color indicator.
 */
function mixToneColor(row: {
  failCount: number;
  flakyCount: number;
  passedCount: number;
}): string {
  if (row.failCount > 0) return statusToken("failed");
  if (row.flakyCount > 0) return statusToken("flaky");
  if (row.passedCount > 0) return statusToken("passed");
  return statusToken("skipped");
}
