"use client";

import {
  keepPreviousData,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { fetch } from "void/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { TestGroup } from "@/components/run-progress-group";
import {
  GroupHeaderSkeleton,
  TestsListSkeleton,
} from "@/components/run-progress-skeletons";
import { SearchFilterInput } from "@/components/search-filter-input";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/segmented-control";
import { cn } from "@/lib/cn";
import {
  dedupeGroups,
  type GroupByAxis,
  groupKeyId,
  rawGroupKey,
  type StatusFilter,
} from "@/lib/group-tests-by-file";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useInfiniteScrollSentinel } from "@/lib/hooks/use-infinite-scroll-sentinel";
import type { RunGroupHeader, RunGroupSkeleton } from "@/lib/run-groups-page";
import {
  currentSummary,
  type RunProgressSummary,
  type RunProgressTest,
} from "@/realtime/run-progress";
import { useRunRoom } from "@/realtime/use-run-room";

interface RunProgressProps {
  /** Run id used as the `void/ws` run-room key (`run:<runId>`). */
  runId: string;
  /** Team slug — used to build test-detail hrefs + the API paths. */
  teamSlug: string;
  /** Project slug — same as above. */
  projectSlug: string;
  /** SSR run aggregate — seeds the live filter-chip counts (whole-run, exact). */
  initialSummary: RunProgressSummary;
  /** Whether the run is sharded — gates the "Shard" group-by option. */
  isSharded: boolean;
}

/** A running run's skeleton stays fresh this long; live events refresh it at most this often. */
const LIVE_STALE_MS = 5_000;
/** Debounce for the search box before it drives the (server) queries. */
const SEARCH_DEBOUNCE_MS = 300;
/** Default group-by axis for the Tests tab's first paint. */
const DEFAULT_GROUP_BY: GroupByAxis = "file";

const EMPTY_ROWS: readonly RunProgressTest[] = [];

/** The group keys the server flagged to auto-expand on first paint. */
function defaultExpandedIds(headers: readonly RunGroupHeader[]): Set<string> {
  const ids = new Set<string>();
  for (const g of headers) {
    if (g.expandedByDefault) ids.add(groupKeyId(g.key));
  }
  return ids;
}

/**
 * Run-detail Tests tab. Two-level, paginated-by-group and loaded on demand:
 *
 *   - Filter chips (All/Failed/Flaky/Passed/Skipped) read the **whole-run**
 *     aggregate from the live `void/ws` summary (`useRunRoom`), so they are
 *     instant + correct + live without loading a single row. These render
 *     eagerly — they are the point of the tab.
 *   - The grouped list is a server-built **skeleton** (worst-first headers with
 *     per-bucket counts) fetched client-side via TanStack `useInfiniteQuery` and
 *     **paginated by group**: page 1 carries every failing group + the top
 *     passing ones, and more groups load as the user scrolls the group list. It
 *     shows a skeleton on first load (nothing is SSR-seeded — the section loads
 *     deferred like the rest of the page); changing axis / status / search
 *     re-queries server-side, keeping the previous list visible during the swap.
 *   - Each group's ROWS are fetched lazily on expand via `useInfiniteQuery`
 *     (infinite-scroll for a huge group), merged on top of the live `byId`
 *     overlay — see `<TestGroup>`.
 *
 * Three count surfaces coexist by design and are only eventually-consistent on
 * a live run: the CHIPS read the whole-run WS `summary` (authoritative for the
 * run total); the group HEADERS read the skeleton snapshot (may lag by up to
 * ~LIVE_STALE_MS while running); the ROWS in an expanded group are what's
 * paginated in plus the live `byId` overlay. At rest all three agree — they
 * derive their buckets from the same `STATUS_BUCKET_MEMBERS`.
 */
export function RunProgress({
  runId,
  teamSlug,
  projectSlug,
  initialSummary,
  isSharded,
}: RunProgressProps) {
  const state = useRunRoom(runId, { initialSummary });
  const summary = currentSummary(state, initialSummary);
  const byId = state.byId;
  const isRunning = summary.status === "running";

  const [search, setSearch] = useState("");
  // The input stays responsive while the (server) skeleton + row queries key off
  // the settled value.
  const debouncedSearch = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);
  // Default to the action-oriented "Recommended" view when there's something to
  // review (failed/flaky); otherwise "All", so an all-green run doesn't open on
  // an empty tab. One-shot from the SSR summary — the user's later chip clicks
  // stick.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() =>
    initialSummary.failed + initialSummary.flaky > 0 ? "recommended" : "all",
  );
  const [groupBy, setGroupBy] = useState<GroupByAxis>(DEFAULT_GROUP_BY);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const didAutoExpand = useRef(false);

  const queryClient = useQueryClient();

  // Group SKELETON — paginated by group. Loaded client-side (no SSR seed) so the
  // section loads deferred behind a skeleton; `keepPreviousData` keeps the
  // current list visible (dimmed) while a filter/axis/search change re-queries,
  // instead of flashing empty.
  const skeletonQuery = useInfiniteQuery({
    queryKey: ["run-groups", runId, groupBy, statusFilter, debouncedSearch],
    queryFn: ({ pageParam, signal }): Promise<RunGroupSkeleton> =>
      fetch("/api/t/:teamSlug/p/:projectSlug/runs/:runId/groups", {
        params: { teamSlug, projectSlug, runId },
        query: {
          groupBy,
          ...(statusFilter !== "all" ? { status: statusFilter } : {}),
          ...(debouncedSearch ? { search: debouncedSearch } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    staleTime: isRunning ? LIVE_STALE_MS : Number.POSITIVE_INFINITY,
  });

  // Flatten the group pages, deduping by key (a live run's severity ordering
  // mutates, so a group can momentarily land on two pages across refetches).
  const groups = useMemo(
    () => dedupeGroups(skeletonQuery.data?.pages ?? []),
    [skeletonQuery.data],
  );

  // Live skeleton refresh — THROTTLED to at most once per LIVE_STALE_MS and
  // driven by actual `byId` events. A plain trailing debounce starves under
  // sustained streaming (the timer keeps resetting and never fires); a fixed
  // interval would poll forever if a terminal event were missed (isRunning stuck
  // true). Keying off events means no events ⇒ no refetch. The mount pass is
  // skipped so a just-fetched page isn't discarded. Terminal runs skip this
  // (counts frozen); expanded groups update via the `byId` overlay regardless.
  const lastSkeletonRefresh = useRef(0);
  const skeletonMountSkipped = useRef(false);
  useEffect(() => {
    if (!isRunning) return;
    if (!skeletonMountSkipped.current) {
      skeletonMountSkipped.current = true;
      lastSkeletonRefresh.current = Date.now();
      return;
    }
    const refresh = () => {
      lastSkeletonRefresh.current = Date.now();
      void queryClient.invalidateQueries({ queryKey: ["run-groups", runId] });
    };
    const since = Date.now() - lastSkeletonRefresh.current;
    if (since >= LIVE_STALE_MS) {
      refresh();
      return;
    }
    const t = setTimeout(refresh, LIVE_STALE_MS - since);
    return () => clearTimeout(t);
  }, [byId, isRunning, runId, queryClient]);

  // One final skeleton refresh when the run finishes, so the headers reflect the
  // terminal state even if the last batch landed inside the throttle window.
  const wasRunning = useRef(isRunning);
  useEffect(() => {
    if (wasRunning.current && !isRunning) {
      void queryClient.invalidateQueries({ queryKey: ["run-groups", runId] });
    }
    wasRunning.current = isRunning;
  }, [isRunning, runId, queryClient]);

  // On a WS reconnect, useRunRoom's reseed resets the live `byId` overlay and the
  // loader re-runs with a fresh `initialSummary` identity — but TanStack caches
  // aren't touched by that loader refresh, so re-hydrate the skeleton +
  // open-group rows the reset overlay dropped. Skips the mount pass.
  const seededSummary = useRef(initialSummary);
  useEffect(() => {
    if (seededSummary.current === initialSummary) return;
    seededSummary.current = initialSummary;
    void queryClient.invalidateQueries({ queryKey: ["run-groups", runId] });
    void queryClient.invalidateQueries({ queryKey: ["run-group-rows", runId] });
  }, [initialSummary, runId, queryClient]);

  // One-shot auto-expand of the worst groups (server-flagged `expandedByDefault`
  // on the first page). A terminal run latches on first paint (incl. the passing
  // fallback so the list is never fully collapsed); a run watched live from empty
  // must NOT consume the latch on a passing fallback — wait for a real
  // failed/flaky group (the server's page-level `hasFailingGroup`), or later
  // failing groups would never auto-expand. Re-runs per axis (onGroupBy resets).
  useEffect(() => {
    if (didAutoExpand.current) return;
    // Don't latch on `keepPreviousData` placeholder (the prior axis/filter's
    // data shown during a swap) — that would consume the one-shot latch on
    // stale groups and the new axis would never auto-expand.
    if (skeletonQuery.isPlaceholderData) return;
    const firstPage = skeletonQuery.data?.pages[0];
    if (!firstPage) return;
    const def = defaultExpandedIds(firstPage.groups);
    if (def.size === 0) return;
    if (isRunning && !firstPage.hasFailingGroup) return;
    setExpanded(def);
    didAutoExpand.current = true;
  }, [skeletonQuery.data, skeletonQuery.isPlaceholderData, isRunning, groupBy]);

  // Group the live overlay once per event (O(byId)), so each group reads its
  // own slice instead of re-scanning all of `byId`.
  const liveByGroup = useMemo(() => {
    const m = new Map<string, RunProgressTest[]>();
    for (const t of Object.values(byId)) {
      const id = groupKeyId(rawGroupKey(t, groupBy));
      const arr = m.get(id);
      if (arr) arr.push(t);
      else m.set(id, [t]);
    }
    return m;
  }, [byId, groupBy]);

  // Load more group headers when the bottom of the group list scrolls into view.
  const groupSentinelRef = useInfiniteScrollSentinel(skeletonQuery);

  function onGroupBy(next: GroupByAxis) {
    if (next === groupBy) return;
    setGroupBy(next);
    // Re-auto-expand for the new axis: its keys differ, so drop manual state.
    didAutoExpand.current = false;
    setExpanded(new Set());
  }

  function toggleGroup(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const statusOptions: SegmentedOption<StatusFilter>[] = [
    {
      value: "recommended",
      label: "Recommended",
      count: summary.failed + summary.flaky,
    },
    { value: "all", label: "All", count: summary.totalTests },
    { value: "failed", label: "Failed", count: summary.failed, dot: "failed" },
    { value: "flaky", label: "Flaky", count: summary.flaky, dot: "flaky" },
    { value: "passed", label: "Passed", count: summary.passed, dot: "passed" },
    {
      value: "skipped",
      label: "Skipped",
      count: summary.skipped,
      dot: "skipped",
    },
  ];

  // First load (no data yet) shows the skeleton; a filter/axis/search change
  // keeps the previous list visible (dimmed) while the new one loads.
  const showSkeleton = skeletonQuery.isPending;
  const isRefetching = skeletonQuery.isPlaceholderData;

  return (
    <div className="flex flex-col">
      <div className="sticky top-[84px] z-10 flex flex-wrap items-center gap-2 border-b border-line-1 bg-background px-6 py-2.5">
        <SearchFilterInput
          aria-label="Filter tests"
          className="w-[260px]"
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter tests…"
          value={search}
        />

        <SegmentedControl
          onChange={setStatusFilter}
          options={statusOptions}
          value={statusFilter}
        />

        <div className="flex-1" />

        <span className="text-[12px] text-fg-3">Group by</span>
        <SegmentedControl
          compact
          onChange={onGroupBy}
          options={[
            { value: "file", label: "File" },
            { value: "project", label: "Playwright project" },
            ...(isSharded ? [{ value: "shard" as const, label: "Shard" }] : []),
          ]}
          value={groupBy}
        />
      </div>

      {showSkeleton ? (
        <TestsListSkeleton />
      ) : groups.length === 0 ? (
        <div className="px-6 py-10 text-center text-[12.5px] text-muted-foreground">
          {summary.totalTests === 0
            ? "No tests recorded for this run."
            : statusFilter === "recommended"
              ? "No failing or flaky tests — nothing needs review."
              : "No tests match the current filters."}
        </div>
      ) : (
        <div className={cn("transition-opacity", isRefetching && "opacity-60")}>
          {groups.map((header) => {
            const id = groupKeyId(header.key);
            return (
              <TestGroup
                debouncedSearch={debouncedSearch}
                groupBy={groupBy}
                header={header}
                isRunning={isRunning}
                key={id}
                liveRows={liveByGroup.get(id) ?? EMPTY_ROWS}
                onToggle={() => toggleGroup(id)}
                open={expanded.has(id)}
                projectSlug={projectSlug}
                runId={runId}
                statusFilter={statusFilter}
                teamSlug={teamSlug}
              />
            );
          })}
          {skeletonQuery.hasNextPage ? (
            <div ref={groupSentinelRef}>
              <GroupHeaderSkeleton />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
