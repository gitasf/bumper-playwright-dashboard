"use client";

import type React from "react";
import { useCallback, useSyncExternalStore } from "react";
import { formatDuration } from "@/lib/time-format";

/**
 * Pick the duration to display. While a run is in progress the stored
 * `durationMs` isn't wall-clock yet (it's 0 / accumulated test time until
 * `completeRun` writes the reporter's final value), so a running run shows
 * **wall-clock elapsed since it started** (`createdAt`); a finished run shows its
 * authoritative `durationMs`. Pure so the running/terminal switch is unit-tested
 * without React or a clock.
 *
 * `createdAt` is unix SECONDS (run row); `nowMs`/return are MILLISECONDS.
 * `nowMs === null` means "not ticking yet" (pre-mount / terminal) → fall back to
 * the stored value, which keeps the first paint deterministic for hydration.
 */
export function displayDurationMs(args: {
  status: string;
  durationMs: number;
  createdAt: number;
  completedAt: number | null;
  nowMs: number | null;
}): number {
  const running = args.status === "running" && args.completedAt == null;
  if (running && args.nowMs != null) {
    return Math.max(0, args.nowMs - args.createdAt * 1000);
  }
  return args.durationMs;
}

type TickListener = () => void;

/**
 * Shared 1-second ticker for every running `<LiveDuration>`. A runs list can
 * render many running rows; rather than each owning its own `setInterval` (N
 * intervals + N re-renders/sec), all rows subscribe to this single module-level
 * store — at most one interval, all rows re-rendering off the same tick.
 *
 * The interval runs only while there's a subscriber and the document is visible.
 * On `visibilitychange` back to visible we re-tick immediately (not resume the
 * old cadence) so durations snap to current elapsed time instead of looking
 * frozen while hidden.
 *
 * The `visibilitychange` listener is attached lazily on first subscribe, not at
 * module load: `subscribeToTick` runs only from the `useSyncExternalStore`
 * subscribe callback (client effect only), so `document` is guaranteed present,
 * whereas the module body itself is also imported during SSR.
 */
const tickSubscribers = new Set<TickListener>();
let currentTick = Date.now();
let tickIntervalId: ReturnType<typeof setInterval> | null = null;
let visibilityListenerAttached = false;

function notifyTick(): void {
  currentTick = Date.now();
  for (const listener of tickSubscribers) listener();
}

function startTickInterval(): void {
  if (tickIntervalId != null || document.hidden) return;
  tickIntervalId = setInterval(notifyTick, 1000);
}

function stopTickInterval(): void {
  if (tickIntervalId != null) {
    clearInterval(tickIntervalId);
    tickIntervalId = null;
  }
}

function handleVisibilityChange(): void {
  if (document.hidden) {
    stopTickInterval();
  } else {
    notifyTick();
    if (tickSubscribers.size > 0) startTickInterval();
  }
}

function subscribeToTick(listener: TickListener): () => void {
  tickSubscribers.add(listener);
  if (!visibilityListenerAttached) {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    visibilityListenerAttached = true;
  }
  // Seed this row with a fresh timestamp immediately (only this row's listener,
  // not the whole set) before its first interval tick.
  currentTick = Date.now();
  listener();
  startTickInterval();
  return () => {
    tickSubscribers.delete(listener);
    if (tickSubscribers.size === 0) stopTickInterval();
  };
}

function getTick(): number {
  return currentTick;
}

/** SSR + initial client (pre-hydration) snapshot — always "not ticking yet". */
function getServerSnapshot(): number | null {
  return null;
}

/**
 * Run duration cell shared by the runs list + run-detail header. For a running
 * run it ticks elapsed-since-start every second off the shared ticker above;
 * once the WS delivers the terminal summary (`status` leaves "running" /
 * `completedAt` set) it switches to the final `durationMs`.
 *
 * The subscription starts only after mount and only while running, so the first
 * (SSR + hydration) paint renders the stored `durationMs` deterministically (no
 * server/client mismatch) and terminal runs never subscribe.
 */
export function LiveDuration({
  status,
  durationMs,
  createdAt,
  completedAt,
}: {
  status: string;
  durationMs: number;
  createdAt: number;
  completedAt: number | null;
}): React.ReactElement {
  const running = status === "running" && completedAt == null;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!running) return () => {};
      return subscribeToTick(onStoreChange);
    },
    [running],
  );
  const getSnapshot = useCallback(
    () => (running ? getTick() : null),
    [running],
  );
  const nowMs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return (
    <>
      {formatDuration(
        displayDurationMs({
          status,
          durationMs,
          createdAt,
          completedAt,
          nowMs,
        }),
      )}
    </>
  );
}
