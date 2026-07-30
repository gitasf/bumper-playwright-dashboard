"use client";

import { useMemo } from "react";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Progress, ProgressIndicator } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import {
  actionIntersectsRange,
  defaultSelectedActionId,
  describeTraceLoadError,
  type TraceTimeRange,
} from "../model";
import { useModelScopedState } from "../use-model-scoped-state";
import type { TraceBridge } from "../use-trace-model";
import { useTraceModel } from "../use-trace-model";
import type { ContextEntry } from "../vendor/entries";
import { TraceModel } from "../vendor/model-util";
import { ActionList } from "./action-list";
import { DetailTabs } from "./detail-tabs";
import { usePlayback } from "./use-playback";
import { SnapshotPane } from "./snapshot-pane";
import { SplitPane } from "./split-pane";
import { Timeline } from "./timeline";

/** `done/total` → a 0–1 fraction, or `null` while the total isn't known yet
 * (a zip download or SW-reported switch hasn't sent a first progress event). */
function fractionOf(
  progress: { done: number; total: number } | null,
): number | null {
  return progress && progress.total > 0 ? progress.done / progress.total : null;
}

/**
 * Progress bar shared by the initial trace load and the attempt-switch strip
 * — same aria wiring (`role="progressbar"` + value/indeterminate handling
 * come from `ui/progress`'s Base UI primitive), different sizing/position
 * per call site via `className`/`indicatorClassName`. `value={null}` is
 * Base UI's indeterminate state: no `aria-valuenow` until a real fraction is
 * known, which also drives the `data-indeterminate` pulse below.
 */
function TraceProgress({
  value,
  label,
  className,
  indicatorClassName,
}: {
  value: number | null;
  label: string;
  className?: string;
  indicatorClassName?: string;
}): React.ReactElement {
  return (
    <Progress aria-label={label} value={value} className={className}>
      <ProgressIndicator
        className={cn(
          "h-full bg-ring transition-[width] data-indeterminate:w-full data-indeterminate:animate-pulse",
          indicatorClassName,
        )}
      />
    </Progress>
  );
}

/**
 * Wrightful's own Playwright trace viewer ("Replay"). Loads the trace model
 * through the vendored Playwright service worker (see `../bridge.html` /
 * `../use-trace-model.ts`) and renders the workbench with the dashboard's
 * component library — replacing the old iframe embed of the official viewer
 * UI. `traceUrl` must be absolute (typically the signed artifact download
 * URL resolved against the current origin).
 *
 * When `traceUrl` changes while a model is showing (attempt switch), the
 * hook keeps the previous model alive and loads the new trace behind it —
 * the workbench stays MOUNTED (deliberately un-keyed; it resets its own
 * selection when the model swaps) with only a thin progress bar on top.
 * Keeping the same workbench instance is what lets the snapshot pane
 * double-buffer across the swap instead of tearing its iframes down.
 */
export function TraceViewer({
  traceUrl,
  onEscape,
}: {
  traceUrl: string;
  onEscape?: () => void;
}): React.ReactElement {
  const { state, bridge } = useTraceModel(traceUrl);

  if (state.status === "loading") {
    const fraction = fractionOf(state.progress);
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Spinner className="size-5 text-fg-3" />
        <div className="text-body text-fg-3">Loading trace…</div>
        {fraction !== null ? (
          <TraceProgress
            value={Math.round(fraction * 100)}
            label="Loading trace"
            className="h-1 w-48 overflow-hidden rounded-full bg-bg-3"
            indicatorClassName="rounded-full"
          />
        ) : null}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <Empty className="h-full justify-center">
        <EmptyTitle>Couldn&apos;t load this trace</EmptyTitle>
        <EmptyDescription className="max-w-md whitespace-pre-wrap">
          {describeTraceLoadError(state.error)}
        </EmptyDescription>
      </Empty>
    );
  }

  const switchFraction = fractionOf(state.switching?.progress ?? null);

  return (
    <div aria-busy={state.switching !== null} className="relative h-full">
      {state.switching ? (
        <TraceProgress
          value={
            switchFraction !== null ? Math.round(switchFraction * 100) : null
          }
          label="Loading attempt"
          className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-bg-3"
        />
      ) : null}
      <Workbench
        contextEntries={state.contextEntries}
        bridge={bridge}
        onEscape={onEscape}
      />
    </div>
  );
}

function Workbench({
  contextEntries,
  bridge,
  onEscape,
}: {
  contextEntries: ContextEntry[];
  bridge: TraceBridge;
  onEscape?: () => void;
}): React.ReactElement {
  // `bridge.traceUrl` mirrors the `ready` model's `state.traceUrl` exactly
  // (see `useTraceModel`) — reading it here instead of threading a second
  // `traceUrl` prop keeps the two channels from drifting apart.
  const traceUrl = bridge.traceUrl;
  const model = useMemo(
    () => new TraceModel(traceUrl, contextEntries),
    [traceUrl, contextEntries],
  );
  // Selection, hover, and the timeline window all belong to the CURRENT model
  // and reset the instant a new attempt swaps in (the workbench stays mounted
  // across the swap — see TraceViewer). `useModelScopedState` owns that
  // render-time reset so each of the three below is a plain state declaration.
  const [selectedCallId, setSelectedCallId] = useModelScopedState(
    model,
    defaultSelectedActionId,
  );
  const selectedAction = useMemo(
    () => model.actions.find((a) => a.callId === selectedCallId),
    [model, selectedCallId],
  );

  // Hover preview for the snapshot canvas + Source tab only — every other
  // detail tab, the timeline, and playback key off `selectedCallId` and are
  // untouched by hovering.
  const [hoveredCallId, setHoveredCallId] = useModelScopedState<
    TraceModel,
    string | undefined
  >(model, () => undefined);
  const hoveredAction = useMemo(
    () => model.actions.find((a) => a.callId === hoveredCallId),
    [model, hoveredCallId],
  );
  // Coalesced once and shared by the snapshot pane and the Source tab — the
  // only two panels that follow hover (upstream viewer parity); every other
  // detail tab keys off `selectedAction` alone.
  const activeAction = hoveredAction ?? selectedAction;

  // Drag-selected timeline window. Scopes the action list and the playable set
  // to actions intersecting it; playback then plays just that section and
  // pauses at its end. A range from the previous attempt is meaningless against
  // the new trace's time base, so it resets on swap like the two above.
  const [timeRange, setTimeRangeInternal] = useModelScopedState<
    TraceModel,
    TraceTimeRange | null
  >(model, () => null);

  // Playback (rAF clock + prev/play/stop/next/speed state) lives here, one
  // level above both the timeline strip (which draws the moving Playhead) and
  // the snapshot pane's nav (which renders the control cluster) — the two are
  // siblings, so a single shared controller is what keeps the Playhead and the
  // buttons in lockstep. Prev/next stepping and click-to-seek walk the
  // DEFAULT-VISIBLE action set (`filteredActions([])` drops the route/getter/
  // configuration noise groups the action list hides by default) — selecting a
  // hidden action would land on a row that isn't in the list, so "Next" would
  // appear to do nothing. A timeline selection narrows the same set further
  // for playback and stepping; strip click-seeks keep the UNSCOPED set
  // (`allPlayableActions`) because a click dismisses the selection and lands
  // on the action at that exact point.
  const allPlayableActions = useMemo(() => model.filteredActions([]), [model]);
  const playableActions = useMemo(
    () =>
      timeRange
        ? allPlayableActions.filter((a) => actionIntersectsRange(a, timeRange))
        : allPlayableActions,
    [allPlayableActions, timeRange],
  );
  const playback = usePlayback({
    model,
    windowStartTime: timeRange?.start ?? model.startTime,
    windowEndTime: timeRange?.end ?? model.endTime,
    playableActions,
    selectedAction,
    onSelect: setSelectedCallId,
  });

  // Changing or clearing the window mid-play would silently retarget the
  // playhead's clock — pause instead and let the user hit Play on the new
  // window. `pause` is identity-stable (see PlaybackController).
  const setTimeRange = (range: TraceTimeRange | null): void => {
    playback.pause();
    setTimeRangeInternal(range);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Timeline
        model={model}
        bridge={bridge}
        selectedAction={selectedAction}
        onSelect={setSelectedCallId}
        playback={playback}
        seekActions={allPlayableActions}
        selection={timeRange}
        onSelectionChange={setTimeRange}
        className="shrink-0 border-b border-line-1"
      />
      <SplitPane
        direction="horizontal"
        initial={0.32}
        separatorLabel="Resize action list and trace details"
        min={0.18}
        max={0.55}
        className="min-h-0 flex-1"
      >
        <ActionList
          model={model}
          selectedCallId={selectedCallId}
          onSelect={setSelectedCallId}
          onHover={setHoveredCallId}
          selection={timeRange}
          onClearSelection={() => setTimeRange(null)}
        />
        <SplitPane
          direction="vertical"
          initial={0.62}
          separatorLabel="Resize snapshot and action details"
          min={0.3}
          max={0.85}
          className="h-full"
        >
          <SnapshotPane
            action={activeAction}
            bridge={bridge}
            onEscape={onEscape}
            playback={playback}
          />
          <DetailTabs
            model={model}
            selectedAction={selectedAction}
            activeAction={activeAction}
            onSelectAction={setSelectedCallId}
            bridge={bridge}
            selection={timeRange}
          />
        </SplitPane>
      </SplitPane>
    </div>
  );
}
