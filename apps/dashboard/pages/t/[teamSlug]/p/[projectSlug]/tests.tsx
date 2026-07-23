import { Link, PREFETCH_STABLE } from "@/components/ui/link";
import { RowLink } from "@/components/row-link";
import { ChevronsUpDown, ChevronDown, ChevronUp } from "lucide-react";
import { Fragment, use } from "react";
import { AnalyticsButtonGroup } from "@/components/analytics/button-group";
import { DeferredSection } from "@/components/defer-error-boundary";
import { NavBusyGuard } from "@/components/nav-busy-guard";
import { OutcomeBar } from "@/components/outcome-bar";
import { PageHeader } from "@/components/page-header";
import { PageToolbar } from "@/components/page-toolbar";
import { RunHistoryBranchFilter } from "@/components/run/history-branch-filter";
import { ALL_BRANCHES } from "@/components/run/history-branch-filter.shared";
import { SearchFilterInput } from "@/components/search-filter-input";
import { TablePaginationFooterSkeleton } from "@/components/skeletons";
import { TablePaginationFooter } from "@/components/table-pagination-footer";
import {
  Empty,
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
import { cn } from "@/lib/cn";
import { groupCatalogRows } from "@/lib/group-catalog-rows";
import { makeHrefBuilder } from "@/lib/page-links";
import { statusToken } from "@/lib/status";
import {
  defaultTestsSortDirection,
  type TestsSortDirection,
  type TestsSortKey,
} from "@/lib/tests-catalog-sort";
import { formatDuration, formatRelativeTime } from "@/lib/time-format";
import { useIsNavigating } from "@/lib/use-is-navigating";
import type { Props, TestsPageRow } from "./tests.server";

const GROUP_OPTIONS = ["none", "file", "suite"] as const;
type GroupOption = (typeof GROUP_OPTIONS)[number];
const GROUP_LABEL: Record<GroupOption, string> = {
  none: "Flat",
  file: "File",
  suite: "Suite",
};

const SKELETON_ROWS = 12;

/**
 * Test catalog page. Every distinct testId observed in the window, with
 * counters, average duration, and a tiny pass/flaky/fail outcome bar.
 *
 * The header, search, filters and tag chips paint immediately; the two-pass
 * catalog query (the page's primary content + its heaviest work) streams in
 * behind a table skeleton via `defer()`. See the server module for the split.
 */
export default function TestsPage({
  project,
  range,
  branchParam,
  branchFilter,
  branches,
  q,
  tagParam,
  tags,
  availableTags,
  group,
  sort,
  catalog,
  requestedPage,
  pathname,
  ranges,
}: Props) {
  const base = `/t/${project.teamSlug}/p/${project.slug}`;

  const { with: hrefWith, pageHref } = makeHrefBuilder(pathname, {
    range,
    branch: branchParam,
    q,
    tag: tagParam,
    group,
    sort: sort.key === "last-seen" ? null : sort.key,
    direction:
      sort.direction === defaultTestsSortDirection(sort.key)
        ? null
        : sort.direction,
    // The raw URL page (eager) preserves the current page across a group
    // toggle; the clamped page streams with the deferred slice.
    page: requestedPage > 1 ? String(requestedPage) : null,
  });

  const selectedTags = new Set(tags);
  // Toggle a tag in/out of the comma-list `tag` param (resets to page 1).
  const tagHref = (tag: string): string => {
    const next = selectedTags.has(tag)
      ? tags.filter((t) => t !== tag)
      : [...tags, tag];
    return hrefWith({
      tag: next.length > 0 ? next.join(",") : null,
      page: null,
    });
  };
  const groupValue: GroupOption = group ?? "none";
  const sortHref = (key: TestsSortKey): string => {
    const direction: TestsSortDirection =
      sort.key === key
        ? sort.direction === "asc"
          ? "desc"
          : "asc"
        : defaultTestsSortDirection(key);
    return hrefWith({ sort: key, direction, page: null });
  };

  // A deferred region that fails latches its error boundary; clear it when the
  // filters/page change so the SPA-nav re-fetch re-attempts the region.
  const resetKey = `${range}:${branchParam ?? ""}:${q}:${tagParam ?? ""}:${sort.key}:${sort.direction}:${requestedPage}`;

  return (
    <>
      <PageHeader title="Tests catalog" />

      <PageToolbar sticky>
        <form className="w-[240px]" method="get">
          <input name="range" type="hidden" value={range} />
          {branchParam ? (
            <input name="branch" type="hidden" value={branchParam} />
          ) : null}
          <input name="sort" type="hidden" value={sort.key} />
          <input name="direction" type="hidden" value={sort.direction} />
          <SearchFilterInput
            defaultValue={q}
            name="q"
            placeholder="Search tests…"
          />
        </form>
        <RunHistoryBranchFilter
          branches={branches}
          defaultValue={branchParam ?? ALL_BRANCHES}
        />
        <div className="flex-1" />
        <AnalyticsButtonGroup
          hrefFor={(g) => hrefWith({ group: g === "none" ? null : g })}
          labelFor={(g) => GROUP_LABEL[g]}
          options={GROUP_OPTIONS}
          value={groupValue}
        />
        <AnalyticsButtonGroup
          hrefFor={(r) => hrefWith({ range: r, page: null })}
          options={ranges as readonly ("7d" | "14d" | "30d")[]}
          value={range}
        />
      </PageToolbar>

      {availableTags.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line-1 bg-bg-0 px-6 py-2">
          <span className="mr-1 text-caption font-medium tracking-[0.1px] text-fg-3">
            Tags
          </span>
          <NavBusyGuard>
            {availableTags.map((tag) => {
              const active = selectedTags.has(tag);
              return (
                <Link
                  aria-label={`${active ? "Remove" : "Add"} tag filter: ${tag}`}
                  aria-pressed={active}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 font-mono text-micro transition-colors",
                    active
                      ? "border-bg-3 bg-accent-soft text-info"
                      : "border-line-1 text-fg-3 hover:text-fg-1",
                  )}
                  href={tagHref(tag)}
                  key={tag}
                >
                  {tag}
                </Link>
              );
            })}
          </NavBusyGuard>
        </div>
      )}

      <DeferredSection
        resetKey={resetKey}
        skeleton={<TestsCatalogSkeleton sort={sort} sortHref={sortHref} />}
      >
        <TestsCatalogRegion
          base={base}
          branchFilter={branchFilter}
          catalog={catalog}
          group={group}
          pageHref={pageHref}
          q={q}
          range={range}
          sort={sort}
          sortHref={sortHref}
        />
      </DeferredSection>
    </>
  );
}

/** The catalog table — Empty state or the (optionally grouped) rows +
 *  pagination footer. Reads the deferred `catalog` group; grouping is applied
 *  here from the eager `group` param over the resolved rows. */
function TestsCatalogRegion({
  catalog,
  base,
  group,
  pageHref,
  q,
  range,
  branchFilter,
  sort,
  sortHref,
}: {
  catalog: Props["catalog"];
  base: string;
  group: Props["group"];
  pageHref: (page: number) => string;
  q: string;
  range: string;
  branchFilter: string | null;
  sort: Props["sort"];
  sortHref: (key: TestsSortKey) => string;
}) {
  const { rows, totalUniqueTests, currentPage, totalPages, fromRow, toRow } =
    use(catalog);

  if (rows.length === 0) {
    return (
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
    );
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto min-h-0">
        <Table className="table-fixed" stickyHeader>
          <TestsCatalogHead sort={sort} sortHref={sortHref} />
          <TableBody>
            {group
              ? groupCatalogRows(rows, group).map((g) => (
                  <Fragment key={g.key}>
                    <TableRow className="bg-muted/40">
                      <TableCell className="w-10 px-4 py-2" />
                      <TableCell className="px-4 py-2 align-middle">
                        <span
                          className="truncate font-mono text-micro font-semibold text-fg-1"
                          title={g.key}
                        >
                          {g.key}
                        </span>
                        <span className="ml-2 text-micro text-fg-3">
                          {g.testCount} test{g.testCount === 1 ? "" : "s"}
                        </span>
                      </TableCell>
                      <TableCell className="w-[90px]" />
                      <TableCell className="w-[200px] px-4 py-2 align-middle">
                        <OutcomeBar
                          emptyDash
                          failed={g.failCount}
                          flaky={g.flakyCount}
                          height={6}
                          maxWidth={180}
                          minWidth={0}
                          passed={g.passedCount}
                          skipped={g.skippedCount}
                        />
                      </TableCell>
                      <TableCell className="w-[110px]" />
                      <TableCell className="w-[100px]" />
                    </TableRow>
                    {g.rows.map((row) => (
                      <TestRow base={base} key={row.testId} row={row} />
                    ))}
                  </Fragment>
                ))
              : rows.map((row) => (
                  <TestRow base={base} key={row.testId} row={row} />
                ))}
          </TableBody>
        </Table>
      </div>
      <TablePaginationFooter
        currentPage={currentPage}
        fromRow={fromRow}
        itemNoun="test"
        pageHref={pageHref}
        toRow={toRow}
        totalCount={totalUniqueTests}
        totalPages={totalPages}
      />
    </>
  );
}

/** Shared 6-column header used by the live table and its skeleton so the
 *  fixed column widths can't drift between states. */
function TestsCatalogHead({
  sort,
  sortHref,
}: {
  sort: Props["sort"];
  sortHref: (key: TestsSortKey) => string;
}) {
  // Disable the sort links while a navigation is in flight (this head renders
  // in both the live table and the streaming skeleton, so both are covered):
  // re-sorting before the current visit's deferred props resolve would dispose
  // it and reject them (see `useIsNavigating`).
  const busy = useIsNavigating();
  return (
    <TableHeader
      className="sticky top-0 z-20 bg-bg-0/95 backdrop-blur-sm"
      inert={busy}
    >
      <TableRow>
        <TableHead className="w-10 px-4" />
        <SortableHead
          href={sortHref("test")}
          label="Test"
          sort={sort}
          sortKey="test"
        />
        <SortableHead
          align="right"
          className="w-[90px]"
          href={sortHref("runs")}
          label="Total runs"
          sort={sort}
          sortKey="runs"
        />
        <TableHead className="w-[200px] px-4">Mix</TableHead>
        <SortableHead
          align="right"
          className="w-[110px]"
          href={sortHref("duration")}
          label="Avg duration"
          sort={sort}
          sortKey="duration"
        />
        <SortableHead
          align="right"
          className="w-[100px]"
          href={sortHref("last-seen")}
          label="Last seen"
          sort={sort}
          sortKey="last-seen"
        />
      </TableRow>
    </TableHeader>
  );
}

// Deliberately separate from the trace viewer's SortableHead
// (src/trace-viewer/components/network-tab.tsx): that one is a client
// button-onClick tri-state (asc→desc→natural) toggle over an in-memory array;
// this one is a server-driven two-state Link that navigates the URL to re-run
// the loader's SQL sort. Unifying them would need a button-vs-link + tri-vs-two
// mode flag that hides more than it shares.
function SortableHead({
  label,
  sortKey,
  sort,
  href,
  align = "left",
  className,
}: {
  label: string;
  sortKey: TestsSortKey;
  sort: Props["sort"];
  href: string;
  align?: "left" | "right";
  className?: string;
}) {
  const active = sort.key === sortKey;
  const nextDirection = active
    ? sort.direction === "asc"
      ? "descending"
      : "ascending"
    : defaultTestsSortDirection(sortKey) === "asc"
      ? "ascending"
      : "descending";
  return (
    <TableHead
      aria-sort={
        active
          ? sort.direction === "asc"
            ? "ascending"
            : "descending"
          : undefined
      }
      className={cn("p-0", className)}
    >
      <Link
        aria-label={`Sort by ${label}, ${nextDirection}`}
        className={cn(
          "flex h-10 w-full items-center gap-1 px-4 text-fg-3 transition-colors hover:text-fg-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          align === "right" && "justify-end",
        )}
        href={href}
      >
        {label}
        <span
          aria-hidden
          className="inline-flex size-3 items-center justify-center"
        >
          {active ? (
            sort.direction === "asc" ? (
              <ChevronUp className="size-3" />
            ) : (
              <ChevronDown className="size-3" />
            )
          ) : (
            <ChevronsUpDown className="size-3 opacity-45" />
          )}
        </span>
      </Link>
    </TableHead>
  );
}

/** Fallback matching the catalog table (fixed columns + a footer). Rows are
 *  single-line under `leading-none` (`h-[13px]` ≈ 38px row). Row count is a
 *  fixed placeholder — the real count only exists post-query; the table is the
 *  terminal region, so it resizes in place without shifting anything above. */
function TestsCatalogSkeleton({
  sort,
  sortHref,
}: {
  sort: Props["sort"];
  sortHref: (key: TestsSortKey) => string;
}) {
  return (
    <>
      <div className="flex-1 overflow-y-auto min-h-0">
        <Table className="table-fixed" stickyHeader>
          <TestsCatalogHead sort={sort} sortHref={sortHref} />
          <TableBody>
            {Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <TableRow key={i}>
                <TableCell className="w-10 px-4 py-3 align-middle">
                  <Skeleton className="mx-auto size-2 rounded-full" />
                </TableCell>
                <TableCell className="px-4 py-3 align-middle">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-[13px] w-1/3" />
                    <Skeleton className="h-[11px] w-1/4" />
                  </div>
                </TableCell>
                <TableCell className="w-[90px] px-4 py-3 align-middle">
                  <Skeleton className="ml-auto h-3 w-10" />
                </TableCell>
                <TableCell className="w-[200px] px-4 py-3 align-middle">
                  <Skeleton className="h-1.5 w-[180px]" />
                </TableCell>
                <TableCell className="w-[110px] px-4 py-3 align-middle">
                  <Skeleton className="ml-auto h-3 w-14" />
                </TableCell>
                <TableCell className="w-[100px] px-4 py-3 align-middle">
                  <Skeleton className="ml-auto h-3 w-14" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <TablePaginationFooterSkeleton showPager />
    </>
  );
}

/** One catalog row — shared by the flat list and the grouped sections. */
function TestRow({ row, base }: { row: TestsPageRow; base: string }) {
  const dotColor = mixToneColor(row);
  const title = row.title || row.testId;
  // Link to the test-level history page (keyed by the stable testId), not the
  // latest run's result — a test's history is independent of any one run.
  const href = `${base}/tests/${row.testId}`;
  return (
    <TableRow>
      <TableCell className="w-10 px-4 py-3 align-middle">
        <RowLink cacheFor={PREFETCH_STABLE} href={href}>
          <span className="sr-only">View {title}</span>
          <span
            aria-hidden
            className="inline-block size-2 rounded-full"
            style={{ backgroundColor: dotColor }}
          />
        </RowLink>
      </TableCell>
      <TableCell className="px-4 py-3 align-middle">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-body text-fg-1" title={title}>
            {title}
          </span>
          <span
            className="truncate font-mono text-micro text-fg-3"
            title={row.file}
          >
            {row.file}
          </span>
        </div>
      </TableCell>
      <TableCell className="w-[90px] px-4 py-3 text-right align-middle font-mono text-caption tabular-nums text-fg-3">
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
      <TableCell className="w-[110px] px-4 py-3 text-right align-middle font-mono text-caption tabular-nums text-fg-1">
        {row.avgDurationMs === null
          ? "—"
          : formatDuration(Math.round(row.avgDurationMs))}
      </TableCell>
      <TableCell className="w-[100px] px-4 py-3 text-right align-middle text-caption text-fg-3">
        {formatRelativeTime(row.lastSeen)}
      </TableCell>
    </TableRow>
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
