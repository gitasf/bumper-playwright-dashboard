"use client";

import { useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { formatTraceOffset } from "../format";
import {
  actionParamHint,
  actionTitle,
  sha1Path,
  type TraceTimeRange,
} from "../model";
import { useElementSize } from "../use-element-size";
import type { TraceBridge } from "../use-trace-model";
import { useBufferedObjectUrl, useObjectUrl } from "../use-object-url";
import type { PageEntry } from "../vendor/entries";
import type { TraceModel } from "../vendor/model-util";
import { Playhead } from "./playhead";
import {
  lowerBoundByTime,
  type PlaybackController,
  type TimelineAction,
} from "./use-playback";

type ScreencastFrame = PageEntry["screencastFrames"][number];

const AXIS_HEIGHT = 16;
const BARS_HEIGHT = 8;
const STRIP_HEIGHT = 56;
const TOTAL_HEIGHT = AXIS_HEIGHT + BARS_HEIGHT + STRIP_HEIGHT;

const MAX_THUMBS = 60;
const PREVIEW_HEIGHT = 220;
const DRAG_THRESHOLD_PX = 4;
const PREVIEW_CLEARANCE = PREVIEW_HEIGHT + 40;

function nearestFrameIndex(frames: ScreencastFrame[], t: number): number {
  const lb = lowerBoundByTime(frames, t, (f) => f.timestamp);
  if (lb === 0) return 0;
  if (lb === frames.length) return frames.length - 1;
  return Math.abs(frames[lb - 1].timestamp - t) <=
    Math.abs(frames[lb].timestamp - t)
    ? lb - 1
    : lb;
}

function actionActiveAt(
  actions: TimelineAction[],
  t: number,
): TimelineAction | undefined {
  if (actions.length === 0) return undefined;
  const lb = lowerBoundByTime(actions, t, (a) => a.startTime);
  if (lb < actions.length && actions[lb].startTime === t) return actions[lb];
  return lb === 0 ? actions[0] : actions[lb - 1];
}

type TimeScale = {
  duration: number;
  timeAt: (fraction: number) => number;
  fractionAt: (time: number, opts?: { clamp?: boolean }) => number;
  percentAt: (time: number, opts?: { clamp?: boolean }) => number;
  spanPercent: (
    start: number,
    end: number,
    opts?: { clamp?: boolean },
  ) => number;
};

function makeTimeScale(startTime: number, endTime: number): TimeScale {
  const duration = endTime - startTime;
  const fractionAt = (time: number, opts?: { clamp?: boolean }): number => {
    const f = (time - startTime) / duration;
    return opts?.clamp ? Math.min(1, Math.max(0, f)) : f;
  };
  const percentAt = (time: number, opts?: { clamp?: boolean }): number =>
    fractionAt(time, opts) * 100;
  return {
    duration,
    timeAt: (fraction) => startTime + fraction * duration,
    fractionAt,
    percentAt,
    spanPercent: (start, end, opts) =>
      Math.max(0, percentAt(end, opts) - percentAt(start, opts)),
  };
}

type TimelineHover = { fraction: number; below: boolean };

function useTimelineSeek({
  containerRef,
  scale,
  seekActions,
  playback,
  selection,
  onSelect,
  onSelectionChange,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  scale: TimeScale;
  seekActions: TimelineAction[];
  playback: PlaybackController;
  selection: TraceTimeRange | null;
  onSelect: (callId: string) => void;
  onSelectionChange: (range: TraceTimeRange | null) => void;
}): {
  hover: TimelineHover | null;
  handlers: {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
    onLostPointerCapture: () => void;
    onPointerLeave: () => void;
  };
} {
  const [hover, setHover] = useState<TimelineHover | null>(null);
  const draggingRef = useRef<{
    anchorClientX: number;
    anchorFraction: number;
    selecting: boolean;
  } | null>(null);

  const fractionAtClientX = (clientX: number): number => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const seekToFraction = (fraction: number): void => {
    if (seekActions.length === 0) return;
    const t = scale.timeAt(fraction);
    onSelect(actionActiveAt(seekActions, t)!.callId);
  };

  const previewBelow = (): boolean => {
    const top = containerRef.current?.getBoundingClientRect().top ?? 0;
    return top < PREVIEW_CLEARANCE;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const fraction = fractionAtClientX(event.clientX);
    draggingRef.current = {
      anchorClientX: event.clientX,
      anchorFraction: fraction,
      selecting: false,
    };
    playback.pause();
    setHover((prev) => ({ fraction, below: prev?.below ?? previewBelow() }));
    seekToFraction(fraction);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const fraction = fractionAtClientX(event.clientX);
    setHover((prev) =>
      prev
        ? { fraction, below: prev.below }
        : { fraction, below: previewBelow() },
    );
    const drag = draggingRef.current;
    if (!drag) return;
    if (
      !drag.selecting &&
      Math.abs(event.clientX - drag.anchorClientX) > DRAG_THRESHOLD_PX
    ) {
      drag.selecting = true;
    }
    if (drag.selecting) {
      const a = scale.timeAt(drag.anchorFraction);
      const b = scale.timeAt(fraction);
      onSelectionChange({ start: Math.min(a, b), end: Math.max(a, b) });
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    // Releasing capture clears draggingRef through onLostPointerCapture.
    const drag = draggingRef.current;
    if (drag && !drag.selecting && selection) onSelectionChange(null);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return {
    hover,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onLostPointerCapture: () => {
        draggingRef.current = null;
      },
      onPointerLeave: () => {
        if (!draggingRef.current) setHover(null);
      },
    },
  };
}

export function Timeline({
  model,
  bridge,
  selectedAction,
  onSelect,
  playback,
  seekActions,
  selection,
  onSelectionChange,
  className,
}: {
  model: TraceModel;
  bridge: TraceBridge;
  selectedAction: TimelineAction | undefined;
  onSelect: (callId: string) => void;
  playback: PlaybackController;
  seekActions: TimelineAction[];
  selection: TraceTimeRange | null;
  onSelectionChange: (range: TraceTimeRange | null) => void;
  className?: string;
}): React.ReactElement | null {
  const containerRef = useRef<HTMLDivElement>(null);
  const containerWidth = useElementSize(containerRef)?.width ?? 0;

  const scale = useMemo(
    () => makeTimeScale(model.startTime, model.endTime),
    [model.startTime, model.endTime],
  );

  const allFrames = useMemo<ScreencastFrame[]>(() => {
    const frames = model.pages.flatMap((p) => p.screencastFrames);
    frames.sort((a, b) => a.timestamp - b.timestamp);
    return frames;
  }, [model]);

  const aspect =
    allFrames.length > 0 ? allFrames[0].width / allFrames[0].height : 16 / 9;
  const thumbWidth = Math.max(1, Math.round(STRIP_HEIGHT * aspect));
  const slotCount =
    allFrames.length > 0 && containerWidth > 0
      ? Math.min(
          MAX_THUMBS,
          Math.max(0, Math.floor(containerWidth / thumbWidth)),
        )
      : 0;

  const slots = useMemo<ScreencastFrame[]>(() => {
    if (slotCount === 0 || scale.duration <= 0) return [];
    const result: ScreencastFrame[] = [];
    for (let i = 0; i < slotCount; i++) {
      const t = scale.timeAt((i + 0.5) / slotCount);
      result.push(allFrames[nearestFrameIndex(allFrames, t)]);
    }
    return result;
  }, [allFrames, slotCount, scale]);

  const { hover, handlers } = useTimelineSeek({
    containerRef,
    scale,
    seekActions,
    playback,
    selection,
    onSelect,
    onSelectionChange,
  });

  if (scale.duration <= 0) return null;

  return (
    <div
      className={cn("flex w-full select-none", className)}
      style={{ height: TOTAL_HEIGHT }}
    >
      <div
        ref={containerRef}
        data-testid="timeline-strip"
        className="relative min-w-0 flex-1 cursor-crosshair"
        {...handlers}
      >
        <div
          className="pointer-events-none absolute inset-x-0"
          style={{ top: AXIS_HEIGHT, height: BARS_HEIGHT }}
        >
          {model.actions.map((action) => {
            const span = action.endTime - action.startTime;
            if (span <= 0) return null;
            const isSelected = action.callId === selectedAction?.callId;
            const left = scale.percentAt(action.startTime);
            const width = scale.spanPercent(action.startTime, action.endTime);
            return (
              <div
                key={action.callId}
                data-testid="timeline-bar"
                data-status={action.error ? "fail" : "ok"}
                data-selected={isSelected ? "true" : "false"}
                className={cn(
                  "absolute top-1/2 -translate-y-1/2 rounded-sm",
                  isSelected
                    ? "h-full bg-ring"
                    : action.error
                      ? "h-1.5 bg-fail"
                      : "h-1.5 bg-fg-4/50",
                )}
                style={{ left: `${left}%`, width: `${width}%`, minWidth: 2 }}
              />
            );
          })}
        </div>

        <div
          className="absolute inset-x-0 bottom-0 flex overflow-hidden bg-bg-2"
          style={{ height: STRIP_HEIGHT }}
        >
          {/* Index keys preserve buffered slots across attempt changes. */}
          {slots.map((frame, i) => (
            <BufferedTraceFrameImage
              key={i}
              bridge={bridge}
              traceUri={model.traceUri}
              frame={frame}
              width={thumbWidth}
              height={STRIP_HEIGHT}
              className="shrink-0"
            />
          ))}
        </div>

        {selectedAction ? (
          <div
            className="pointer-events-none absolute inset-y-0 border-x border-ring bg-ring/20"
            style={{
              left: `${scale.percentAt(selectedAction.startTime)}%`,
              width: `${scale.spanPercent(selectedAction.startTime, selectedAction.endTime)}%`,
            }}
          />
        ) : null}

        {selection ? (
          <div
            data-testid="timeline-selection"
            className="pointer-events-none absolute inset-0"
          >
            <div
              className="absolute inset-y-0 left-0 bg-bg-0/60"
              style={{
                width: `${scale.percentAt(selection.start, { clamp: true })}%`,
              }}
            />
            <div
              className="absolute inset-y-0 right-0 bg-bg-0/60"
              style={{
                width: `${100 - scale.percentAt(selection.end, { clamp: true })}%`,
              }}
            />
            <div
              className="absolute inset-y-0 border-x border-fg-3"
              style={{
                left: `${scale.percentAt(selection.start, { clamp: true })}%`,
                width: `${scale.spanPercent(selection.start, selection.end, { clamp: true })}%`,
              }}
            />
          </div>
        ) : null}

        {playback.playing ? (
          <Playhead
            key={playback.session}
            startTime={playback.playFrom}
            stopTime={playback.playTo}
            traceStartTime={model.startTime}
            traceEndTime={model.endTime}
            speedIndex={playback.speedIndex}
            playableActions={playback.playableActions}
            initialSelectedCallId={playback.initialSelectedCallId}
            onSelect={onSelect}
            onComplete={playback.pause}
          />
        ) : null}

        {hover ? (
          <HoverOverlay
            hover={hover}
            scale={scale}
            allFrames={allFrames}
            aspect={aspect}
            containerWidth={containerWidth}
            seekActions={seekActions}
            bridge={bridge}
            traceUri={model.traceUri}
            startTime={model.startTime}
          />
        ) : null}
      </div>
    </div>
  );
}

function HoverOverlay({
  hover,
  scale,
  allFrames,
  aspect,
  containerWidth,
  seekActions,
  bridge,
  traceUri,
  startTime,
}: {
  hover: TimelineHover;
  scale: TimeScale;
  allFrames: ScreencastFrame[];
  aspect: number;
  containerWidth: number;
  seekActions: TimelineAction[];
  bridge: TraceBridge;
  traceUri: string;
  startTime: number;
}): React.ReactElement {
  const hoverTime = scale.timeAt(hover.fraction);
  const hoverPercent = scale.percentAt(hoverTime);
  const previewFrame =
    allFrames.length > 0
      ? allFrames[nearestFrameIndex(allFrames, hoverTime)]
      : undefined;
  const previewAspect = previewFrame
    ? previewFrame.width / previewFrame.height
    : aspect;
  const previewWidth = Math.max(1, Math.round(PREVIEW_HEIGHT * previewAspect));
  const previewLeft =
    containerWidth > 0
      ? Math.min(
          Math.max(hover.fraction * containerWidth - previewWidth / 2, 0),
          Math.max(0, containerWidth - previewWidth),
        )
      : 0;

  const hoverAction =
    seekActions.length > 0 ? actionActiveAt(seekActions, hoverTime) : undefined;

  return (
    <>
      <div
        className="pointer-events-none absolute inset-y-0 w-px bg-fg-3"
        style={{ left: `${hoverPercent}%` }}
      />
      {previewFrame ? (
        <HoverPreview
          key={previewFrame.sha1}
          below={hover.below}
          bridge={bridge}
          traceUri={traceUri}
          frame={previewFrame}
          label={formatTraceOffset(hoverTime, startTime)}
          title={hoverAction ? actionTitle(hoverAction) : undefined}
          hint={hoverAction ? actionParamHint(hoverAction) : undefined}
          left={previewLeft}
          width={previewWidth}
        />
      ) : (
        <div
          className="pointer-events-none absolute top-0 whitespace-nowrap font-mono text-micro text-fg-3"
          style={{
            left: `${hoverPercent}%`,
            transform:
              hover.fraction > 0.9
                ? "translateX(-100%)"
                : hover.fraction < 0.1
                  ? "translateX(0)"
                  : "translateX(-50%)",
          }}
        >
          {formatTraceOffset(hoverTime, startTime)}
        </div>
      )}
    </>
  );
}

function HoverPreview({
  bridge,
  traceUri,
  frame,
  label,
  title,
  hint,
  left,
  width,
  below,
}: {
  bridge: TraceBridge;
  traceUri: string;
  frame: ScreencastFrame;
  label: string;
  title?: string;
  hint?: string;
  left: number;
  width: number;
  below: boolean;
}): React.ReactElement {
  return (
    <div
      data-testid="timeline-preview"
      data-side={below ? "bottom" : "top"}
      className={cn(
        "pointer-events-none absolute z-50 rounded border border-line-1 bg-bg-0 p-1 shadow-md",
        below ? "top-full mt-2" : "bottom-full mb-2",
      )}
      style={{ left }}
    >
      <TraceFrameImage
        bridge={bridge}
        traceUri={traceUri}
        frame={frame}
        width={width}
        height={PREVIEW_HEIGHT}
        className="rounded-sm"
      />
      {title ? (
        <div className="mt-1 px-0.5" style={{ width }}>
          <div className="truncate text-caption text-fg-2" title={title}>
            {title}
          </div>
          {hint ? (
            <div
              className="truncate font-mono text-micro text-fg-4"
              title={hint}
            >
              {hint}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="mt-1 whitespace-nowrap text-center font-mono text-micro text-fg-3">
        {label}
      </div>
    </div>
  );
}

type TraceFrameImageProps = {
  bridge: TraceBridge;
  traceUri: string;
  frame: ScreencastFrame;
  width: number;
  height: number;
  className?: string;
};

function FrameImageBox({
  url,
  width,
  height,
  className,
}: {
  url: string | null;
  width: number;
  height: number;
  className?: string;
}): React.ReactElement {
  return (
    <div
      className={cn("overflow-hidden bg-bg-2", className)}
      style={{ width, height }}
    >
      {url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          className="size-full object-cover"
        />
      ) : null}
    </div>
  );
}

function TraceFrameImage({
  bridge,
  traceUri,
  frame,
  ...box
}: TraceFrameImageProps): React.ReactElement {
  const { url } = useObjectUrl(bridge, sha1Path(traceUri, frame.sha1));
  return <FrameImageBox url={url} {...box} />;
}

function BufferedTraceFrameImage({
  bridge,
  traceUri,
  frame,
  ...box
}: TraceFrameImageProps): React.ReactElement {
  const { url } = useBufferedObjectUrl(bridge, sha1Path(traceUri, frame.sha1));
  return <FrameImageBox url={url} {...box} />;
}
