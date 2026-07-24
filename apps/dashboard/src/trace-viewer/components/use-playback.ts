"use client";

import { useCallback, useRef, useState } from "react";
import { useModelScopedState } from "../use-model-scoped-state";
import type {
  ActionTraceEventInContext,
  TraceModel,
} from "../vendor/model-util";

export type TimelineAction = Pick<
  ActionTraceEventInContext,
  | "callId"
  | "startTime"
  | "endTime"
  | "class"
  | "method"
  | "params"
  | "title"
  | "type"
>;

export const SPEEDS = [0.5, 1, 2] as const;

export function lowerBoundByTime<T>(
  items: readonly T[],
  t: number,
  key: (item: T) => number,
): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(items[mid]) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function nearestActionIndex(
  actions: TimelineAction[],
  t: number,
): number {
  if (actions.length === 0) return -1;
  const lb = lowerBoundByTime(actions, t, (a) => a.startTime);
  if (lb === 0) return 0;
  if (lb === actions.length) return actions.length - 1;
  return actions[lb].startTime - t < t - actions[lb - 1].startTime
    ? lb
    : lb - 1;
}

export interface PlaybackController {
  playing: boolean;
  speedIndex: number;
  atStart: boolean;
  atEnd: boolean;
  hasActions: boolean;
  session: number;
  playFrom: number;
  playTo: number;
  initialSelectedCallId: string | undefined;
  playableActions: TimelineAction[];
  togglePlay: () => void;
  pause: () => void;
  stopPlayback: () => void;
  step: (delta: number) => void;
  cycleSpeed: () => void;
}

export function usePlayback({
  model,
  windowStartTime,
  windowEndTime,
  playableActions,
  selectedAction,
  onSelect,
}: {
  model: TraceModel;
  windowStartTime: number;
  windowEndTime: number;
  playableActions: TimelineAction[];
  selectedAction: TimelineAction | undefined;
  onSelect: (callId: string) => void;
}): PlaybackController {
  const selectedCallId = selectedAction?.callId;
  const selectedStartTime = selectedAction?.startTime;
  const [playing, setPlaying] = useModelScopedState(model, () => false);
  const [speedIndex, setSpeedIndex] = useState(1); // 1×
  const [session, setSession] = useState(0);
  const playFromRef = useRef(windowStartTime);
  const initialSelectedRef = useRef<string | undefined>(undefined);

  const selectedIndex = playableActions.findIndex(
    (a) => a.callId === selectedCallId,
  );
  const hasActions = playableActions.length > 0;
  const lastAction = playableActions[playableActions.length - 1];

  const togglePlay = (): void => {
    if (!hasActions) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    const startFrom =
      selectedStartTime !== undefined &&
      selectedStartTime >= windowStartTime &&
      selectedStartTime < windowEndTime
        ? selectedStartTime
        : windowStartTime;
    if (lastAction && startFrom >= lastAction.startTime) {
      const first = playableActions[0];
      initialSelectedRef.current = first.callId;
      onSelect(first.callId);
      playFromRef.current = windowStartTime;
    } else {
      initialSelectedRef.current = selectedCallId;
      playFromRef.current = startFrom;
    }
    setSession((s) => s + 1);
    setPlaying(true);
  };

  const pause = useCallback((): void => setPlaying(false), [setPlaying]);

  const stopPlayback = (): void => {
    setPlaying(false);
    const first = playableActions[0];
    if (first) onSelect(first.callId);
  };

  const step = (delta: number): void => {
    if (!hasActions) return;
    const index =
      selectedIndex === -1
        ? 0
        : Math.min(
            playableActions.length - 1,
            Math.max(0, selectedIndex + delta),
          );
    onSelect(playableActions[index].callId);
  };

  const cycleSpeed = (): void => setSpeedIndex((i) => (i + 1) % SPEEDS.length);

  return {
    playing,
    speedIndex,
    atStart: selectedIndex <= 0,
    atEnd: selectedIndex === playableActions.length - 1,
    hasActions,
    session,
    playFrom: playFromRef.current,
    playTo: windowEndTime,
    initialSelectedCallId: initialSelectedRef.current,
    playableActions,
    togglePlay,
    pause,
    stopPlayback,
    step,
    cycleSpeed,
  };
}
