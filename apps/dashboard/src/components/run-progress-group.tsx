"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { fetch } from "void/client";
import { useMemo } from "react";
import { GroupRowsSkeleton } from "@/components/run-progress-skeletons";
import { GroupStatusCount, TestRow } from "@/components/run-progress-row";
import { StatusGlyph } from "@/components/status-glyph";
import {
  type GroupByAxis,
  groupKeyId,
  groupLabel,
  mergeGroupRows,
  type StatusFilter,
  worstStatusInGroup,
} from "@/lib/group-tests-by-file";
import { useInfiniteScrollSentinel } from "@/lib/hooks/use-infinite-scroll-sentinel";
import type { RunGroupHeader } from "@/lib/run-groups-page";
import type { RunResultsResponse } from "@/lib/run-results-page";
import type { RunProgressTest } from "@/realtime/run-progress";

/** How long a running run's per-group row page stays fresh (matches the skeleton). */
const LIVE_STALE_MS = 5_000;

/**
 * One expandable group in the Tests tab: a header (worst-status glyph, label,
 * per-bucket counts from the server skeleton) plus, when open, its rows —
 * fetched lazily via `useInfiniteQuery` and merged on top of the live `byId`
 * overlay (see {@link mergeGroupRows}). Collapsed groups cost only their header.
 */
export function TestGroup({
  header,
  groupBy,
  open,
  onToggle,
  teamSlug,
  projectSlug,
  runId,
  statusFilter,
  debouncedSearch,
  liveRows,
  isRunning,
}: {
  header: RunGroupHeader;
  groupBy: GroupByAxis;
  open: boolean;
  onToggle: () => void;
  teamSlug: string;
  projectSlug: string;
  runId: string;
  statusFilter: StatusFilter;
  debouncedSearch: string;
  liveRows: readonly RunProgressTest[];
  isRunning: boolean;
}) {
  const rawKey = header.key;
  const id = groupKeyId(rawKey);

  const rowsQuery = useInfiniteQuery({
    queryKey: [
      "run-group-rows",
      runId,
      groupBy,
      id,
      statusFilter,
      debouncedSearch,
    ],
    queryFn: ({ pageParam, signal }): Promise<RunResultsResponse> =>
      fetch("/api/t/:teamSlug/p/:projectSlug/runs/:runId/results", {
        params: { teamSlug, projectSlug, runId },
        query: {
          groupBy,
          ...(rawKey !== null ? { groupKey: rawKey } : {}),
          ...(statusFilter !== "all" ? { statusBucket: statusFilter } : {}),
          ...(debouncedSearch ? { search: debouncedSearch } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: open,
    staleTime: isRunning ? LIVE_STALE_MS : Number.POSITIVE_INFINITY,
  });

  // Merge the paginated server rows with the live overlay and order them to
  // match the server's page order (see `mergeGroupRows`) so an infinite-scroll
  // page never reorders rows above the viewport.
  const rows = useMemo(
    () =>
      mergeGroupRows(
        (rowsQuery.data?.pages ?? []).flatMap((p) => p.results),
        liveRows,
        { search: debouncedSearch, statusFilter },
      ),
    [rowsQuery.data, liveRows, debouncedSearch, statusFilter],
  );

  const sentinelRef = useInfiniteScrollSentinel(rowsQuery, open);

  const label = groupLabel(groupBy, rawKey);
  // Single-glyph rollup of the group's worst status; null when all in-flight.
  // Derived from the server-computed header counts (the paginated group no
  // longer holds the full test list client-side).
  const worst = worstStatusInGroup(header);

  return (
    <div className="border-b border-line-1">
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-6 py-2 text-left hover:bg-bg-1"
        data-testid="run-test-group"
        onClick={onToggle}
        type="button"
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0 text-fg-3" strokeWidth={2} />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-fg-3" strokeWidth={2} />
        )}
        {worst ? (
          <span className="flex shrink-0 items-center justify-center">
            <StatusGlyph size={13} status={worst} />
          </span>
        ) : null}
        {groupBy === "file" ? (
          <span className="min-w-0 truncate font-mono text-[12.5px] text-foreground">
            {label}
          </span>
        ) : (
          <span className="truncate text-[13px] font-medium text-foreground">
            {label}
          </span>
        )}
        <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-fg-3">
          {header.total}
        </span>
        <div className="flex-1" />
        <div className="flex shrink-0 items-center gap-2.5 font-mono text-[11px] tabular-nums">
          {header.failed > 0 ? (
            <GroupStatusCount n={header.failed} status="failed" />
          ) : null}
          {header.flaky > 0 ? (
            <GroupStatusCount n={header.flaky} status="flaky" />
          ) : null}
          {header.skipped > 0 ? (
            <GroupStatusCount n={header.skipped} status="skipped" />
          ) : null}
          <GroupStatusCount n={header.passed} status="passed" />
        </div>
      </button>

      {open ? (
        <div>
          {rows.map((t) => (
            <TestRow
              groupBy={groupBy}
              key={t.id}
              projectSlug={projectSlug}
              runId={runId}
              teamSlug={teamSlug}
              test={t}
            />
          ))}
          {rowsQuery.isPending && rows.length === 0 ? (
            <GroupRowsSkeleton />
          ) : null}
          {rowsQuery.hasNextPage ? (
            <div ref={sentinelRef}>
              <GroupRowsSkeleton rows={1} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
