"use client";

import {
  applyRunProgressEvent,
  seedRunProgressState,
  type RunProgressState,
  type UseRunProgressOptions,
} from "@/realtime/run-progress";
import { useFeedRoom } from "@/realtime/use-feed-room";

export type UseRunRoomOptions = UseRunProgressOptions;

/**
 * Run-detail realtime hook: subscribe to the run's `void/ws` room and fold each
 * `progress` event through the pure reducer (`applyRunProgressEvent`), seeded
 * from SSR data. Shared by `<RunSummaryLive>` and `<RunProgress>`. A thin
 * specialization of `useFeedRoom` (run path + run-progress reducer); see that
 * hook for the reseed + coalesced-reconnect-refresh policy.
 *
 * Exposes two things consumers care about: `summary` — the live whole-run
 * aggregate (seeded from `run.*`, replaced by each event's snapshot) that drives
 * the header tiles AND the Tests-tab filter chips; and `byId` — the live overlay
 * of `changedTests` that the Tests tab merges on top of the rows it paginates in
 * per group, so a test finishing updates in place without a refetch.
 *
 * There is no eager whole-run back-paginator: the Tests tab pages rows lazily
 * per expanded group (TanStack), and the chips read `summary`, so nothing needs
 * every row in memory. (This is the fix for the old "counts tick 200→2000 as the
 * back-paginate loop floods the DB" behaviour.)
 *
 * The seed-prop references (`initialTests` / `initialSummary`) must be
 * referentially STABLE across re-renders of the same page instance — see
 * `useSeededState` for the requirement (the run-detail page memoizes
 * `initialSummary` on a loader prop).
 */
export function useRunRoom(
  runId: string,
  options: UseRunRoomOptions = {},
): RunProgressState {
  const [state] = useFeedRoom(
    "/ws/run/:runId",
    { runId },
    [runId, options.initialTests, options.initialSummary],
    () => seedRunProgressState(options.initialTests, options.initialSummary),
    (prev, event) => applyRunProgressEvent(prev, event),
  );

  return state;
}
