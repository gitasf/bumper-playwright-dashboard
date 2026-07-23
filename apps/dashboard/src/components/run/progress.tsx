"use client";

import {
  keepPreviousData,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { fetch } from "void/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TestGroup } from "@/components/run/progress-group";
import {
  GroupHeaderSkeleton,
  TestsListSkeleton,
} from "@/components/run/progress-skeletons";
import { ReplayModalHost } from "@/components/trace-viewer-dialog";
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
import type { RunGroupHeader, RunGroupSkeleton } from "@/lib/runs/groups-page";
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

/**
 * Cached grouping snapshot behind the identity-stable `liveByGroup` memo. `byId`
 * / `groupBy` are the inputs it was built from (the next render compares its own
 * `byId` per-id by reference); `groupOf` is the reverse index (`testId →
 * groupId`) that pulls a changed/removed row out of its old group without
 * rescanning every group's array.
 */
interface LiveGroupCache {
  byId: Record<string, RunProgressTest>;
  groupBy: GroupByAxis;
  groupOf: Map<string, string>;
  groups: Map<string, RunProgressTest[]>;
}

/** Full grouping pass — every row assigned to its group from scratch. Used on
 * first paint and whenever `groupBy` changes (the previous `groupOf` mapping
 * is keyed on the OLD axis and can't be reused for a new one). */
function buildLiveGroups(
  byId: Record<string, RunProgressTest>,
  groupBy: GroupByAxis,
): LiveGroupCache {
  const groupOf = new Map<string, string>();
  const groups = new Map<string, RunProgressTest[]>();
  for (const t of Object.values(byId)) {
    const id = groupKeyId(rawGroupKey(t, groupBy));
    groupOf.set(t.id, id);
    const arr = groups.get(id);
    if (arr) arr.push(t);
    else groups.set(id, [t]);
  }
  return { byId, groupBy, groupOf, groups };
}

/**
 * Incremental grouping pass: reuses `cache.groups` and only replaces the arrays
 * for groups a changed/added/removed row touched. Relies on the reducer's
 * per-row identity guarantee (`applyRunProgressEvent` rule 4 makes new
 * references only for `changedTests`), so a `===` per id finds the moved rows
 * without a deep comparison.
 */
function updateLiveGroups(
  cache: LiveGroupCache,
  byId: Record<string, RunProgressTest>,
  groupBy: GroupByAxis,
): LiveGroupCache {
  // An empty `byId` means "start over" (a WS-reconnect reseed drops the whole
  // accumulator at once); rebuild from scratch rather than findIndex+splice
  // every cached row out one by one (quadratic per group — stalls at a few
  // thousand live rows).
  if (Object.keys(byId).length === 0) return buildLiveGroups(byId, groupBy);

  const groupOf = new Map(cache.groupOf);
  const groups = new Map(cache.groups);
  // Groups already cloned this pass, so repeated edits to one group (two changed
  // rows in a file) mutate one copy instead of re-cloning the original each time.
  const cloned = new Set<string>();

  function mutableArrayFor(groupId: string): RunProgressTest[] {
    if (cloned.has(groupId)) {
      // Cloned earlier this pass. Usually still in `groups`, but a prior id may
      // have emptied and deleted this group before a later id adds back into it
      // (e.g. by shard, a row moving `null` → real shard the same event another
      // unsharded row streams into "Unsharded"). Re-materialize so the push
      // lands in `groups`, not a detached array.
      const existing = groups.get(groupId);
      if (existing) return existing;
      const created: RunProgressTest[] = [];
      groups.set(groupId, created);
      return created;
    }
    const next = [...(groups.get(groupId) ?? [])];
    groups.set(groupId, next);
    cloned.add(groupId);
    return next;
  }

  for (const id of Object.keys(byId)) {
    const t = byId[id];
    if (cache.byId[id] === t) continue; // untouched row — same object, skip

    const newGroupId = groupKeyId(rawGroupKey(t, groupBy));
    const oldGroupId = groupOf.get(id); // undefined for a brand-new id

    if (oldGroupId !== undefined && oldGroupId !== newGroupId) {
      const oldArr = mutableArrayFor(oldGroupId);
      const idx = oldArr.findIndex((r) => r.id === id);
      if (idx !== -1) oldArr.splice(idx, 1);
      if (oldArr.length === 0) groups.delete(oldGroupId);
    }

    const newArr = mutableArrayFor(newGroupId);
    if (oldGroupId === newGroupId) {
      const idx = newArr.findIndex((r) => r.id === id);
      if (idx !== -1) newArr[idx] = t;
      else newArr.push(t);
    } else {
      newArr.push(t);
    }
    groupOf.set(id, newGroupId);
  }

  // Ids the cache knew about that are gone from `byId`. Today only a
  // WS-reconnect reseed removes ids (and it drops them all at once); handled
  // generically so any future partial-removal event is covered too.
  for (const id of cache.groupOf.keys()) {
    if (id in byId) continue;
    const oldGroupId = groupOf.get(id);
    if (oldGroupId !== undefined) {
      const arr = mutableArrayFor(oldGroupId);
      const idx = arr.findIndex((r) => r.id === id);
      if (idx !== -1) arr.splice(idx, 1);
      if (arr.length === 0) groups.delete(oldGroupId);
    }
    groupOf.delete(id);
  }

  return { byId, groupBy, groupOf, groups };
}

/** The group keys the server flagged to auto-expand on first paint. */
function defaultExpandedIds(headers: readonly RunGroupHeader[]): Set<string> {
  const ids = new Set<string>();
  for (const g of headers) {
    if (g.expandedByDefault) ids.add(groupKeyId(g.key));
  }
  return ids;
}

/**
 * Owns the set of open group ids for the Tests accordion, seeding the
 * server-flagged default-open groups ONCE per group-by axis.
 *
 * The seed is a render-phase state update (not an effect) on purpose, and it's
 * genuinely required — both flash-free first paint AND freeze-once semantics
 * can't be met any other way:
 *   - An **effect** runs after the browser paints, so it commits one collapsed
 *     frame and then pops the defaults open — the flash we're removing.
 *   - **Pure derivation** (`expanded = override ?? computeDefaults(...)`) has no
 *     flash but no freeze: a live run's background refetch would re-expand every
 *     newly-failing group and could reopen groups the user just collapsed.
 * Writing state during the first render that has real data gives both: React
 * discards the in-progress (collapsed) render and re-renders before committing,
 * so the collapsed tree never reaches the DOM, and the latch stops it repeating.
 * The latch is state (not a ref) so it's safe under StrictMode / concurrent
 * re-render — a replayed `ref.current = true` could consume the one-shot without
 * committing the paired `setExpanded`.
 *
 * A live run watched from empty defers the seed until a real failing group
 * appears (`hasFailingGroup`), so it doesn't burn the latch on an all-passing
 * fallback page. `resetForAxis()` (called on group-by change) re-arms it and
 * drops manual toggles, since the new axis's keys differ.
 */
function useAutoExpandedGroups(seed: {
  firstPage: RunGroupSkeleton | undefined;
  isPlaceholder: boolean;
  isRunning: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [seeded, setSeeded] = useState(false);

  // Skip the `keepPreviousData` placeholder (the prior axis/filter's data shown
  // during a swap) — seeding on it would consume the one-shot latch on stale
  // groups and the new axis would never auto-expand.
  if (!seeded && !seed.isPlaceholder && seed.firstPage) {
    const { firstPage, isRunning } = seed;
    if (!(isRunning && !firstPage.hasFailingGroup)) {
      const def = defaultExpandedIds(firstPage.groups);
      if (def.size > 0) {
        setExpanded(def);
        setSeeded(true);
      }
    }
  }

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const resetForAxis = useCallback(() => {
    setSeeded(false);
    setExpanded(new Set());
  }, []);

  return { expanded, toggle, resetForAxis };
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
  // on the first page), seeded flash-free during render — see the hook.
  const { expanded, toggle, resetForAxis } = useAutoExpandedGroups({
    firstPage: skeletonQuery.data?.pages[0],
    isPlaceholder: skeletonQuery.isPlaceholderData,
    isRunning,
  });

  // Group the live overlay once per event so each group reads its own slice,
  // and keep each untouched group's array reference stable (`updateLiveGroups`)
  // so a memoized `<TestGroup liveRows={...}>` re-renders only the group an
  // event changed. `liveGroupCache` persists the prior pass across renders; a
  // groupBy change invalidates it (reverse index keyed on the old axis) and
  // forces a full rebuild, same as first render.
  const liveGroupCache = useRef<LiveGroupCache | null>(null);
  const liveByGroup = useMemo(() => {
    const cache = liveGroupCache.current;
    const next =
      cache && cache.groupBy === groupBy
        ? updateLiveGroups(cache, byId, groupBy)
        : buildLiveGroups(byId, groupBy);
    liveGroupCache.current = next;
    return next.groups;
  }, [byId, groupBy]);

  // Load more group headers when the bottom of the group list scrolls into view.
  const groupSentinelRef = useInfiniteScrollSentinel(skeletonQuery);

  function onGroupBy(next: GroupByAxis) {
    if (next === groupBy) return;
    setGroupBy(next);
    // Re-auto-expand for the new axis: its keys differ, so drop manual state.
    resetForAxis();
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
      {/* Deep-linkable Replay modal, driven by `?replay=<testResultId>`. Hosted
          once here (not per row) so a link resolves even when the target test's
          group is collapsed. Renders nothing until the param is set. */}
      <ReplayModalHost
        projectSlug={projectSlug}
        runId={runId}
        teamSlug={teamSlug}
      />
      <div className="sticky top-[84px] z-10 flex flex-wrap items-center gap-2 border-b border-line-1 bg-bg-0 px-6 py-2.5">
        <SearchFilterInput
          aria-label="Filter tests"
          className="w-[240px]"
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

        <span className="text-caption text-fg-3">Group by</span>
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
        <div className="px-6 py-10 text-center text-body text-fg-3">
          {summary.totalTests === 0
            ? "No tests recorded for this run."
            : statusFilter === "recommended"
              ? "No failing or flaky tests — nothing needs review."
              : "No tests match the current filters."}
        </div>
      ) : (
        <div
          className={cn(
            "transition-[opacity,filter] duration-150",
            isRefetching && "opacity-60 blur-[1px]",
          )}
        >
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
                onToggle={toggle}
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
