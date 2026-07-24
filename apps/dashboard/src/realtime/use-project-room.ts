"use client";

import type { RunOriginFilter } from "@/lib/runs/filters";
import type { RunListRowData } from "@/realtime/events";
import { applyProjectFeedEvent } from "@/realtime/project-feed";
import { useFeedRoom } from "@/realtime/use-feed-room";

export interface UseProjectRoomOptions {
  /**
   * Whether `run-created` events may prepend rows — true only on the first,
   * otherwise-unfiltered page (a filtered/paginated view must not be injected
   * with rows that don't belong to it). The origin view alone doesn't disable
   * this; `origin` below gates which provenance is accepted.
   */
  acceptNewRuns: boolean;
  /**
   * The list's active origin view. The server broadcasts `run-created` for ALL
   * runs (synthetic monitor runs included); the reducer prepends only rows
   * whose `origin` matches this view, so the CI view isn't drowned by
   * monitor-cadence runs while the Synthetic/All views stay live.
   */
  origin: RunOriginFilter;
}

/**
 * Subscribe to the project's `void/ws` room and fold `run-created` /
 * `run-progress` into the runs-list rows via the pure reducer
 * (`applyProjectFeedEvent`), seeded from the SSR `initialRows`. A thin
 * specialization of `useFeedRoom` (project path + project-feed reducer); see
 * that hook for the reseed + coalesced-reconnect-refresh policy.
 *
 * `options` is closed over by the per-event `fold`, which `useFeedRoom` reads
 * fresh each render, so the current view's `acceptNewRuns` / `origin` always
 * apply without re-opening the socket.
 */
export function useProjectRoom(
  projectId: string,
  initialRows: readonly RunListRowData[],
  options: UseProjectRoomOptions,
): readonly RunListRowData[] {
  const [rows] = useFeedRoom<
    "/ws/project/:projectId",
    readonly RunListRowData[]
  >(
    "/ws/project/:projectId",
    { projectId },
    [projectId, initialRows],
    () => [...initialRows],
    (prev, event) => applyProjectFeedEvent(prev, event, options),
  );
  return rows;
}
