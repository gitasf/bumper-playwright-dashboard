"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { snapshotIframeUrl } from "../model";
import type { SnapshotSet, SnapshotTabId } from "../model";
import { snapshotSandbox } from "../origin";
import { useElementSize } from "../use-element-size";
import { bindEscapeAcrossFrames } from "./escape-frames";

export const TAB_LABELS: Record<SnapshotTabId, string> = {
  before: "Before",
  action: "Action",
  after: "After",
};

type SnapshotFrameTarget = {
  url: string;
  viewport: { width: number; height: number };
};

type StageSize = { width: number; height: number };

const STAGE_PADDING = 16;

function scaleToFit(
  viewport: SnapshotFrameTarget["viewport"],
  size: StageSize,
): number {
  return Math.min(
    (size.width - STAGE_PADDING) / viewport.width,
    (size.height - STAGE_PADDING) / viewport.height,
    1,
  );
}

function sameTarget(
  a: SnapshotFrameTarget | null,
  b: SnapshotFrameTarget,
): boolean {
  return (
    a?.url === b.url &&
    a.viewport.width === b.viewport.width &&
    a.viewport.height === b.viewport.height
  );
}

/**
 * The DOM-snapshot iframe stage: scales the recorded viewport to fit the pane
 * and double-buffers the swap so scrubbing/attempt switches never flash a blank
 * iframe. A self-contained subsystem — its only inputs are the action's
 * `SnapshotSet` + the active tab — split out of `SnapshotPane` so the pane's
 * tab/nav chrome and this iframe state machine can be read independently.
 */
export function ScaledSnapshotStage({
  traceUrl,
  snapshots,
  available,
  activeTab,
  viewport,
  onEscape,
}: {
  traceUrl: string;
  snapshots: SnapshotSet;
  available: SnapshotTabId[];
  activeTab: SnapshotTabId;
  viewport: { width: number; height: number };
  onEscape?: () => void;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(containerRef);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      {size
        ? available.map((id) => {
            const snapshot = snapshots[id];
            if (!snapshot) return null;
            return (
              <BufferedSnapshotFrame
                key={id}
                id={id}
                target={{
                  url: snapshotIframeUrl(traceUrl, snapshot),
                  viewport,
                }}
                isActive={id === activeTab}
                size={size}
                onEscape={onEscape}
              />
            );
          })
        : null}
    </div>
  );
}

/**
 * Double-buffers one tab slot's snapshot document. When the slot's target
 * `url` changes (scrubbing to another action, or an attempt swap replacing
 * the whole trace), the PREVIOUS document stays visible while the next one
 * loads in a hidden sibling iframe; the loaded frame is then promoted in
 * place — so the pane never shows a blank iframe mid-load. Frames are keyed
 * by URL: promotion keeps the already-loaded element's key (no remount, no
 * reload), while the retired front unmounts (running its escape-binding
 * cleanup). A target that changes again mid-load replaces the back buffer
 * (it's hidden, so its reload costs nothing visually), and a target that
 * returns to the visible document just drops the back buffer.
 */
function BufferedSnapshotFrame({
  id,
  target,
  isActive,
  size,
  onEscape,
}: {
  id: SnapshotTabId;
  target: SnapshotFrameTarget;
  isActive: boolean;
  size: StageSize;
  onEscape?: () => void;
}): React.ReactElement {
  const [buffer, setBuffer] = useState<{
    front: SnapshotFrameTarget;
    back: SnapshotFrameTarget | null;
  }>({ front: target, back: null });

  // Buffer the complete render target, not just its URL. The front document
  // keeps its own viewport/scale while the replacement loads, so an attempt
  // recorded at a different viewport cannot distort the still-visible frame.
  // A viewport refinement for the SAME URL (snapshotInfo resolving) updates in
  // place without reloading the iframe.
  if (target.url === buffer.front.url) {
    if (buffer.back !== null || !sameTarget(buffer.front, target)) {
      setBuffer({ front: target, back: null });
    }
  } else if (!sameTarget(buffer.back, target)) {
    setBuffer({ front: buffer.front, back: target });
  }

  const promote = (): void => {
    setBuffer((prev) =>
      prev.back !== null ? { front: prev.back, back: null } : prev,
    );
  };

  const frames =
    buffer.back !== null && buffer.back !== buffer.front
      ? [
          { target: buffer.front, isFront: true },
          { target: buffer.back, isFront: false },
        ]
      : [{ target: buffer.front, isFront: true }];

  return (
    <>
      {frames.map((frame) => (
        <ScaledSnapshotFrame
          key={`${id}:${frame.target.url}`}
          id={id}
          target={frame.target}
          isActive={isActive && frame.isFront}
          size={size}
          onEscape={onEscape}
          onLoaded={frame.isFront ? undefined : promote}
        />
      ))}
    </>
  );
}

/** One buffered target's complete presentation boundary. Front and back frames
 * calculate layout from their own viewport, so promotion swaps document and
 * geometry together. */
function ScaledSnapshotFrame({
  id,
  target,
  isActive,
  size,
  onEscape,
  onLoaded,
}: {
  id: SnapshotTabId;
  target: SnapshotFrameTarget;
  isActive: boolean;
  size: StageSize;
  onEscape?: () => void;
  onLoaded?: () => void;
}): React.ReactElement | null {
  const scale = scaleToFit(target.viewport, size);
  if (scale <= 0) return null;
  return (
    <div
      className={cn(
        "absolute inset-0 flex items-center justify-center",
        isActive ? "visible" : "invisible pointer-events-none",
      )}
    >
      <div
        className="relative overflow-hidden rounded-[6px] border border-line-1 bg-white shadow-sm"
        style={{
          width: target.viewport.width * scale,
          height: target.viewport.height * scale,
        }}
      >
        <SnapshotFrame
          id={id}
          url={target.url}
          isActive={isActive}
          viewport={target.viewport}
          scale={scale}
          onEscape={onEscape}
          onLoaded={onLoaded}
        />
      </div>
    </div>
  );
}

/**
 * One mounted snapshot iframe. Owns its own escape binding: (re-)bound in
 * `onLoad`, released on unmount and before every re-bind. Because the parent
 * keys each `SnapshotFrame` by `${id}:${url}`, a snapshot change or tab-slot
 * change unmounts the old frame outright — its cleanup effect runs then, so
 * there's no need for a manually keyed cleanup map spanning frames.
 */
function SnapshotFrame({
  id,
  url,
  isActive,
  viewport,
  scale,
  onEscape,
  onLoaded,
}: {
  id: SnapshotTabId;
  url: string;
  isActive: boolean;
  viewport: { width: number; height: number };
  scale: number;
  onEscape?: () => void;
  /** Fires after the document loads (back-buffer promotion hook). */
  onLoaded?: () => void;
}): React.ReactElement | null {
  const escapeCleanupRef = useRef<(() => void) | null>(null);
  const [pageOrigin, setPageOrigin] = useState("");

  useEffect(() => {
    setPageOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    return () => {
      escapeCleanupRef.current?.();
      escapeCleanupRef.current = null;
    };
  }, []);

  // The sandbox attribute must be right BEFORE the document starts loading:
  // granting `allow-scripts` after the iframe has navigated does not enable
  // scripts in the already-loaded document. `pageOrigin` is only known
  // client-side (an effect fills it, keeping SSR/hydration consistent), so
  // hold the iframe off that first origin-less render — otherwise a
  // separate-origin snapshot loads script-less and stays that way.
  if (pageOrigin === "") return null;

  return (
    <iframe
      title={`DOM snapshot (${TAB_LABELS[id]})`}
      src={url}
      sandbox={snapshotSandbox(pageOrigin)}
      aria-hidden={!isActive}
      inert={!isActive}
      className={cn(
        "absolute inset-0 origin-top-left border-0",
        isActive ? "visible" : "invisible pointer-events-none",
      )}
      style={{
        width: viewport.width,
        height: viewport.height,
        transform: `scale(${scale})`,
      }}
      onLoad={(e) => {
        escapeCleanupRef.current?.();
        escapeCleanupRef.current = null;
        if (onEscape) {
          const win = e.currentTarget.contentWindow;
          if (win) {
            escapeCleanupRef.current = bindEscapeAcrossFrames(win, onEscape);
          }
        }
        onLoaded?.();
      }}
    />
  );
}
