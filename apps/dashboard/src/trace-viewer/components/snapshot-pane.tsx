"use client";

import { ExternalLink } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { TabBar, TabBarTab } from "@/components/ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type {
  ResolvedSnapshotInfo,
  Snapshot,
  SnapshotSet,
  SnapshotTabId,
} from "../model";
import {
  collectSnapshots,
  parseSnapshotInfo,
  snapshotIframeUrl,
  snapshotInfoPath,
  snapshotPopoutUrl,
  snapshotViewport,
} from "../model";
import { useBridgeFetch } from "../use-bridge-fetch";
import type { TraceBridge } from "../use-trace-model";
import type { ActionTraceEventInContext } from "../vendor/model-util";
import { PlaybackControls } from "./playback-controls";
import type { PlaybackController } from "./use-playback";
import { ScaledSnapshotStage, TAB_LABELS } from "./snapshot-stage";

const TAB_ORDER: SnapshotTabId[] = ["before", "action", "after"];

/**
 * Cache key for a snapshot's `snapshotInfo/` sidecar. The trace URL is part
 * of the key: the pane stays mounted across an attempt swap (the workbench
 * is deliberately un-keyed — see `trace-viewer.tsx`), and page ids /
 * snapshot names recur across a test's attempts with different content.
 */
function snapshotInfoKey(traceUrl: string, snapshot: Snapshot): string {
  return `${traceUrl}#${snapshot.pageId}:${snapshot.snapshotName}`;
}

/**
 * Center pane: the DOM snapshot scrubber. Up to three iframes (Before/Action/
 * After) are mounted at once, one per available snapshot in the action's
 * `SnapshotSet`, and tab switches merely toggle which is visible — this is
 * what makes TAB switching flash-free (the old single `key={url}` iframe
 * remounted, and therefore reloaded, on every tab click). Each iframe loads
 * the SW-rendered snapshot document (`/trace-viewer/snapshot/<pageId>?…`) — a
 * navigation request, so the SW serves it even though this page itself is not
 * SW-controlled. When the selected ACTION (or, on an attempt swap, the whole
 * trace) changes, each slot double-buffers the swap — the previous document
 * stays painted while the next loads in a hidden sibling — so scrubbing and
 * attempt switches never show a blank iframe (see {@link BufferedSnapshotFrame}).
 */
export function SnapshotPane({
  action,
  onEscape,
  bridge,
  playback,
}: {
  action: ActionTraceEventInContext | undefined;
  onEscape?: () => void;
  /** Bridge proxy for the `snapshotInfo/` sidecar (URL bar + exact viewport) —
   * also carries the absolute trace URL (`bridge.traceUrl`). */
  bridge: TraceBridge;
  /** Shared playback controller (owned by the workbench). */
  playback: PlaybackController;
}): React.ReactElement {
  const traceUrl = bridge.traceUrl;
  const snapshots: SnapshotSet = useMemo(
    () => collectSnapshots(action),
    [action],
  );
  const [tab, setTab] = useState<SnapshotTabId>("action");
  const available = TAB_ORDER.filter((id) => snapshots[id]);
  const activeTab: SnapshotTabId | undefined = snapshots[tab]
    ? tab
    : (["action", "after", "before"] as const).find((id) => snapshots[id]);
  const activeSnapshot: Snapshot | undefined = activeTab
    ? snapshots[activeTab]
    : undefined;

  const info = useSnapshotInfo(bridge, activeSnapshot);

  // Absolute URL of the currently rendered snapshot iframe, resolved against
  // the page origin for the popout shell. `window` is safe here: this pane
  // only ever mounts after the bridge posts a model, which requires a
  // client-side effect — it never server-renders.
  const popoutHref = useMemo(() => {
    if (!activeSnapshot) return undefined;
    const relativeUrl = snapshotIframeUrl(traceUrl, activeSnapshot);
    const absoluteUrl = new URL(relativeUrl, window.location.origin).href;
    return snapshotPopoutUrl(traceUrl, absoluteUrl);
  }, [traceUrl, activeSnapshot]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The bottom rule lives on the whole header row so it spans full width
       * — the TabBar is only `flex-1`, so its own `border-b` would stop where
       * the playback/popout controls begin. `border-b-0` drops the TabBar's
       * rule so the row owns the single divider. `h-9` matches the action
       * list's filter header (`action-list.tsx`) so the two panes' dividers
       * align across the split. */}
      <div className="flex h-9 shrink-0 items-end justify-between gap-2 border-b border-line-1 pr-2">
        <TabBar className="min-w-0 flex-1 border-b-0 px-2" role="tablist">
          {available.length > 0 ? (
            available.map((id) => (
              <TabBarTab
                key={id}
                active={id === activeTab}
                onSelect={() => setTab(id)}
              >
                {TAB_LABELS[id]}
              </TabBarTab>
            ))
          ) : (
            // No snapshot for this action → no tabs. Reserve one tab's height
            // (same box as TabBarTab) so the nav row doesn't shrink to the
            // shorter playback-control cluster on the right.
            <span
              aria-hidden
              className="invisible inline-flex items-center px-3 py-2 text-body"
            >
              &nbsp;
            </span>
          )}
        </TabBar>
        <div className="mb-1 flex shrink-0 items-center gap-1">
          <PlaybackControls playback={playback} />
          <div className="mx-0.5 h-5 w-px shrink-0 bg-line-1" aria-hidden />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  // No rendered snapshot to open → disabled (rather than
                  // hidden) so the control's slot stays put across
                  // action/tab switches. The `render` prop swaps the
                  // underlying element to an anchor once a href exists —
                  // one Button, two arms.
                  disabled={!popoutHref}
                  aria-label="Open snapshot in a new tab"
                  size="icon-xs"
                  variant="ghost"
                  className="text-fg-4 hover:bg-bg-2 hover:text-fg-2"
                  render={
                    popoutHref ? (
                      <a href={popoutHref} target="_blank" rel="noreferrer" />
                    ) : undefined
                  }
                >
                  <ExternalLink className="size-3.5" />
                </Button>
              }
            />
            <TooltipPopup>Open snapshot in a new tab</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      <SnapshotUrlBar url={info?.url} />
      <div className="min-h-0 flex-1 bg-bg-2">
        {activeTab && activeSnapshot && action ? (
          <ScaledSnapshotStage
            traceUrl={traceUrl}
            snapshots={snapshots}
            available={available}
            activeTab={activeTab}
            viewport={info?.viewport ?? snapshotViewport(action)}
            onEscape={onEscape}
          />
        ) : (
          <Empty className="h-full justify-center">
            <EmptyTitle>No snapshot</EmptyTitle>
            <EmptyDescription>
              {action
                ? "This action did not capture a DOM snapshot."
                : "Select an action to see its DOM snapshot."}
            </EmptyDescription>
          </Empty>
        )}
      </div>
    </div>
  );
}

/**
 * Slim "browser chrome" strip showing the page URL captured for the active
 * snapshot. Renders nothing while the URL hasn't resolved yet (no bridge, no
 * info yet, or the sidecar 404ed) so the pane doesn't jitter for a missing
 * value — an em dash reads better than a layout shift once it arrives.
 */
function SnapshotUrlBar({
  url,
}: {
  url: string | undefined;
}): React.ReactElement {
  return (
    <div className="flex h-6 shrink-0 items-center border-b border-line-1 px-3">
      <span className="truncate font-mono text-caption text-fg-4" title={url}>
        {url ?? "—"}
      </span>
    </div>
  );
}

/**
 * Resolve the `snapshotInfo/` sidecar for a snapshot, on the canonical
 * {@link useBridgeFetch} lifecycle (keyed by `pageId:snapshotName`, stale
 * in-flight fetches gated out). A malformed / error sidecar (one the SW
 * couldn't resolve) is treated as absent so callers fall back to the context
 * viewport / hide the URL bar. A tiny per-hook cache holds the last resolved
 * sidecar for each key so re-selecting an already-visited tab renders its URL
 * bar immediately instead of blanking for the refetch's one tick.
 */
function useSnapshotInfo(
  bridge: TraceBridge,
  snapshot: Snapshot | undefined,
): ResolvedSnapshotInfo | undefined {
  const cacheRef = useRef(new Map<string, ResolvedSnapshotInfo>());
  const key = snapshot ? snapshotInfoKey(bridge.traceUrl, snapshot) : null;

  const { value } = useBridgeFetch(
    bridge,
    key,
    async (activeKey): Promise<ResolvedSnapshotInfo | null> => {
      if (!snapshot) return null;
      const parsed = parseSnapshotInfo(
        await bridge.fetchJson(snapshotInfoPath(bridge.traceUrl, snapshot)),
      );
      if (!parsed || "error" in parsed) return null;
      cacheRef.current.set(activeKey, parsed);
      return parsed;
    },
  );

  if (value) return value;
  return key ? cacheRef.current.get(key) : undefined;
}
