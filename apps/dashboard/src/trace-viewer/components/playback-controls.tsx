"use client";

import { ChevronLeft, ChevronRight, Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { SPEEDS, type PlaybackController } from "./use-playback";

/**
 * Small ghost icon button for the playback cluster — `icon-xs` is the
 * closest `ui/button` size to the cluster's 24px controls (7px on touch,
 * 6px at `sm:`, same as the icon buttons in `detail-tabs.tsx`).
 */
function PlaybackButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            size="icon-xs"
            variant="ghost"
            className="rounded text-fg-3 hover:bg-bg-2 hover:text-fg-2"
          >
            {children}
          </Button>
        }
      />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Playback control cluster: prev / play–pause / stop / next / speed. Rendered
 * in the snapshot pane's Before/Action/After nav (to the right, before the
 * paint-`<canvas>` button) rather than inside the timeline strip, so its
 * clicks never collide with the strip's pointer-seek handlers. The playback
 * engine lives one level up in the workbench (see `usePlayback`) so this
 * cluster and the timeline's moving Playhead share a single controller —
 * `PlaybackController` IS this cluster's prop contract, so nothing here
 * re-declares its fields.
 */
export function PlaybackControls({
  playback,
}: {
  playback: PlaybackController;
}): React.ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <PlaybackButton
        label="Previous action"
        disabled={playback.atStart}
        onClick={() => playback.step(-1)}
      >
        <ChevronLeft className="size-3.5" />
      </PlaybackButton>
      <PlaybackButton
        label={playback.playing ? "Pause" : "Play"}
        disabled={!playback.hasActions}
        onClick={playback.togglePlay}
      >
        {playback.playing ? (
          <Pause className="size-3.5 fill-current" />
        ) : (
          <Play className="size-3.5 fill-current" />
        )}
      </PlaybackButton>
      <PlaybackButton
        label="Stop"
        disabled={
          !playback.hasActions || (playback.atStart && !playback.playing)
        }
        onClick={playback.stopPlayback}
      >
        <Square className="size-3 fill-current" />
      </PlaybackButton>
      <PlaybackButton
        label="Next action"
        disabled={!playback.hasActions || playback.atEnd}
        onClick={() => playback.step(1)}
      >
        <ChevronRight className="size-3.5" />
      </PlaybackButton>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Playback speed"
              onClick={playback.cycleSpeed}
              className="flex h-6 min-w-8 items-center justify-center rounded px-1 font-mono text-micro text-fg-3 tabular-nums transition-colors hover:bg-bg-2 hover:text-fg-2"
            >
              {SPEEDS[playback.speedIndex]}×
            </button>
          }
        />
        <TooltipPopup>Playback speed</TooltipPopup>
      </Tooltip>
    </div>
  );
}
