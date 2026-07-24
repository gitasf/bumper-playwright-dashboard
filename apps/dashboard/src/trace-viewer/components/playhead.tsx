"use client";

import { useEffect, useRef } from "react";
import {
  nearestActionIndex,
  SPEEDS,
  type TimelineAction,
} from "./use-playback";

/**
 * The moving playhead line while replaying. Owns its own rAF loop and
 * positions itself by mutating `style.left` directly on its own ref — a
 * per-frame `setState` here would re-render the whole Timeline 60×/sec for a
 * value only this 1px div consumes. Reports action-boundary crossings via
 * `onSelect` and end-of-trace via `onComplete`. Everything that can change
 * identity mid-session — the callbacks and the speed — is read through refs,
 * so the rAF effect never restarts while playing: a restart re-baselines the
 * clock and drops a frame, which would visibly stall the playhead whenever
 * the parent re-renders per-frame (e.g. hover state on pointermove).
 *
 * One instance = one play session — the parent remounts this component
 * (via a `key`) each time "Play" starts a fresh session.
 */
export function Playhead({
  startTime,
  stopTime,
  traceStartTime,
  traceEndTime,
  speedIndex,
  playableActions,
  initialSelectedCallId,
  onSelect,
  onComplete,
}: {
  startTime: number;
  /**
   * Where the clock stops and `onComplete` fires — the timeline selection's
   * end when one is active, else `traceEndTime`. Positioning still maps over
   * the full trace span, so the playhead pauses mid-strip at a selection end.
   */
  stopTime: number;
  traceStartTime: number;
  traceEndTime: number;
  speedIndex: number;
  playableActions: TimelineAction[];
  initialSelectedCallId: string | undefined;
  onSelect: (callId: string) => void;
  onComplete: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const positionRef = useRef(startTime);
  const lastSelectedRef = useRef(initialSelectedCallId);
  const speedRef = useRef<number>(SPEEDS[speedIndex]);
  const onSelectRef = useRef(onSelect);
  const onCompleteRef = useRef(onComplete);
  const duration = traceEndTime - traceStartTime;

  useEffect(() => {
    speedRef.current = SPEEDS[speedIndex];
  }, [speedIndex]);
  // Assigned post-commit (never during render) so an abandoned concurrent
  // render can't leave its callbacks behind in the refs.
  useEffect(() => {
    onSelectRef.current = onSelect;
    onCompleteRef.current = onComplete;
  });

  useEffect(() => {
    const setLeft = (t: number): void => {
      const node = ref.current;
      if (!node || duration <= 0) return;
      const fraction = Math.min(
        1,
        Math.max(0, (t - traceStartTime) / duration),
      );
      node.style.left = `${fraction * 100}%`;
    };

    let raf = 0;
    let last: number | undefined;
    setLeft(positionRef.current);
    const tick = (timestamp: number): void => {
      // The first frame only baselines the clock — deltas start on frame 2.
      if (last !== undefined) {
        const next = Math.min(
          stopTime,
          positionRef.current + (timestamp - last) * speedRef.current,
        );
        positionRef.current = next;
        setLeft(next);
        const index = nearestActionIndex(playableActions, next);
        const action = index >= 0 ? playableActions[index] : undefined;
        if (action && action.callId !== lastSelectedRef.current) {
          lastSelectedRef.current = action.callId;
          onSelectRef.current(action.callId);
        }
        if (next >= stopTime) {
          onCompleteRef.current();
          return;
        }
      }
      last = timestamp;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [traceStartTime, stopTime, duration, playableActions]);

  const initialFraction =
    duration > 0
      ? Math.min(1, Math.max(0, (startTime - traceStartTime) / duration))
      : 0;

  return (
    <div
      ref={ref}
      data-testid="timeline-playhead"
      className="pointer-events-none absolute inset-y-0 w-px bg-ring"
      style={{ left: `${initialFraction * 100}%` }}
    />
  );
}
