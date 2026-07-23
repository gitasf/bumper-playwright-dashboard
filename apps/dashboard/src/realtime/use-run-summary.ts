"use client";

import {
  applyRunSummaryEvent,
  seedRunSummaryState,
  type RunProgressSummary,
  type RunSummaryState,
} from "@/realtime/run-progress";
import { useFeedRoom } from "@/realtime/use-feed-room";

export interface UseRunSummaryOptions {
  /** SSR-loaded aggregate so consumers can render counts before the first event. */
  initialSummary?: RunProgressSummary | null;
}

/**
 * Summary-only counterpart of `useRunRoom`, for leaves that only ever render
 * the run-wide aggregate — the sticky-header status glyph, duration, and tab
 * count (`run/detail-live.tsx`) and the summary tiles + OutcomeBar
 * (`RunSummaryLive`). Same room, same seeding, same reseed/reconnect policy —
 * it's a thin specialization of `useFeedRoom` exactly like `useRunRoom` (see
 * that hook for the reseed + coalesced-reconnect-refresh policy) — but folds
 * through `applyRunSummaryEvent` instead of `applyRunProgressEvent`, so it
 * never touches or clones `byId`.
 *
 * A run-detail page mounts several of these leaves (plus `<RunProgress>`,
 * which needs `byId` and stays on `useRunRoom`) against the SAME run room;
 * `useRoom`'s ref-counted sharing (`use-room.ts`) means they all still share
 * ONE WebSocket — this hook only changes what each leaf FOLDS locally out of
 * the shared stream, not the connection. Near the end of a big run, that's
 * the difference between a handful of field comparisons per event and a full
 * `byId` object clone the leaf never reads from.
 *
 * The `initialSummary` seed must be referentially STABLE across re-renders of
 * the same page instance — see `useSeededState` (the run-detail page
 * memoizes `initialSummary` on a loader prop, shared by every leaf here and
 * by `useRunRoom`).
 */
export function useRunSummary(
  runId: string,
  options: UseRunSummaryOptions = {},
): RunSummaryState {
  const [state] = useFeedRoom(
    "/ws/run/:runId",
    { runId },
    [runId, options.initialSummary],
    () => seedRunSummaryState(options.initialSummary),
    (prev, event) => applyRunSummaryEvent(prev, event),
  );

  return state;
}
