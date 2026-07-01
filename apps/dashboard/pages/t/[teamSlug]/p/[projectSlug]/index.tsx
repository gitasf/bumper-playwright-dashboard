import { PageHeader } from "@/components/page-header";
import { PageToolbar } from "@/components/page-toolbar";
import { RunListRow } from "@/components/run-list-row";
import { RunsFilterBar } from "@/components/runs-filter-bar";
import { TablePaginationFooter } from "@/components/table-pagination-footer";
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
import { useProjectRoom } from "@/realtime/use-project-room";
import {
  DEFAULT_ORIGIN_FILTER,
  hasAnyFilter,
  toSearchParams,
} from "@/lib/runs-filters";
import type { Props } from "./index.server";

/**
 * Runs list page. Layout mirrors the design bundle's `RunsScreen` (see
 * `wrightful/project/screen-runs.jsx`): filter bar at the top, then a
 * four-column row layout — status glyph (shape varies by status for
 * colorblind safety), commit + chip meta, outcome bar with mono counts,
 * duration, relative time. The popovers over each count are a deepening
 * over the pure design — engineers can peek at the failed/flaky test list
 * without leaving the page.
 *
 * The list subscribes to the project's `void/ws` room (`useProjectRoom`) over a
 * single WebSocket: in-flight rows fill in / flip status + counts
 * + duration live, and a brand-new run prepends its row without a refresh
 * (default first page only — see `acceptNewRuns`). Terminal runs render
 * straight from the SSR data.
 */
export default function RunsListPage({
  project,
  runs,
  totalRuns,
  currentPage,
  totalPages,
  offset,
  filters,
  options,
  pathname,
}: Props) {
  const base = `/t/${project.teamSlug}/p/${project.slug}`;

  // Live run feed for the whole list over ONE shared connection: in-flight rows
  // stream in place and brand-new runs prepend without a refresh. New runs are
  // accepted only on the first page with no filters, so a filtered or paginated
  // view isn't injected with rows that don't belong to it. The origin
  // SegmentedControl is a VIEW, not a disqualifying filter: the server
  // broadcasts run-created for all origins and the reducer prepends only runs
  // matching `filters.origin`, so the CI, Synthetic, and All views each stay
  // live with exactly their own provenance.
  const nonOriginFiltersActive = hasAnyFilter({
    ...filters,
    origin: DEFAULT_ORIGIN_FILTER,
  });
  const liveRows = useProjectRoom(project.id, runs, {
    acceptNewRuns: currentPage === 1 && !nonOriginFiltersActive,
    origin: filters.origin,
  });
  // Rows the feed prepended beyond the SSR page — shifts #N and the footer.
  const newCount = liveRows.length - runs.length;

  const fromRow = totalRuns + newCount === 0 ? 0 : offset + 1;
  const toRow = offset + liveRows.length;

  const pageHref = (page: number): string => {
    const qs = toSearchParams({ ...filters, page }).toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  return (
    <>
      <PageHeader title="Runs" />
      <PageToolbar>
        <RunsFilterBar filters={filters} options={options} pathname={base} />
      </PageToolbar>

      <div className="flex-1 overflow-y-auto min-h-0">
        {liveRows.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No test runs yet</EmptyTitle>
                <EmptyDescription>
                  Wire the reporter into your playwright.config.ts and set
                  WRIGHTFUL_URL + WRIGHTFUL_TOKEN in CI.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <code className="rounded-md bg-muted px-3 py-1.5 font-mono text-xs">
                  reporter: [[&apos;@wrightful/reporter&apos;]]
                </code>
              </EmptyContent>
            </Empty>
          </div>
        ) : (
          <Table className="table-fixed">
            <TableHeader className="sticky top-0 z-10 bg-bg-0/95 backdrop-blur-sm">
              <TableRow>
                <TableHead className="w-10 px-4" />
                <TableHead className="px-4 text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                  Commit
                </TableHead>
                <TableHead className="w-[220px] px-4 text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                  Outcome
                </TableHead>
                <TableHead className="w-[90px] px-4 text-right text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                  Duration
                </TableHead>
                <TableHead className="w-[100px] px-4 text-right text-[10.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                  When
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {liveRows.map((run, i) => {
                // #N counts down from the (live-adjusted) total across the page.
                const runNum = totalRuns + newCount - offset - i;
                return (
                  <RunListRow
                    key={run.id}
                    projectSlug={project.slug}
                    run={run}
                    runNum={runNum}
                    teamSlug={project.teamSlug}
                  />
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {liveRows.length > 0 && (
        <TablePaginationFooter
          className="bg-background"
          currentPage={currentPage}
          fromRow={fromRow}
          itemNoun="run"
          pageHref={pageHref}
          toRow={toRow}
          totalCount={totalRuns + newCount}
          totalPages={totalPages}
        />
      )}
    </>
  );
}
