"use client";

import type React from "react";
import { cn } from "@/lib/cn";
import { formatTraceOffset } from "../format";
import { timeInRange, type TraceTimeRange } from "../model";
import type { ActionTraceEventInContext } from "../vendor/model-util";
import {
  OFFSET_GRID_CLASSES,
  OffsetCell,
  ScopedEmpty,
  TabNotice,
} from "./detail-shared";

/**
 * One action's step log — API log lines recorded for the hover-aware action,
 * narrowed to the timeline `selection`
 * window when one is drag-selected. Unlike Console/Network there's no
 * whole-trace universe to fall back to (there's no action selected at all
 * before one is), so the "select an action" state is handled up front and
 * `ScopedEmpty`'s scope-vs-range precedence covers the rest: an empty log for
 * the action takes precedence over an empty-after-selection-filter log,
 * matching how the crosshair's action scope out-ranks a timeline selection
 * on Console/Network.
 */
export function LogTab({
  action,
  startTime,
  selection,
}: {
  action: ActionTraceEventInContext | undefined;
  startTime: number;
  /** Timeline selection: only log entries inside the window are shown. */
  selection: TraceTimeRange | null;
}): React.ReactElement {
  if (!action) {
    return <TabNotice>Select an action to see its log.</TabNotice>;
  }

  const allEntries = action.log;
  const log = selection
    ? allEntries.filter((entry) => timeInRange(entry.time, selection))
    : allEntries;

  if (log.length === 0) {
    return (
      <ScopedEmpty
        scoped={allEntries.length === 0}
        selection={selection !== null}
        actionScopedMessage="No log entries for this action."
        rangeScopedMessage="No log entries in the selected timeline range."
        title="No log entries"
        description="This action recorded no log entries."
      />
    );
  }

  return (
    <div
      className={cn(
        OFFSET_GRID_CLASSES,
        "h-full content-start overflow-y-auto overscroll-contain py-1",
      )}
    >
      {log.map((entry, i) => (
        <div
          key={i}
          className="col-span-full grid grid-cols-subgrid items-baseline px-3 py-0.5 font-mono text-caption"
        >
          <OffsetCell>
            {formatTraceOffset(entry.time, startTime, { signed: false })}
          </OffsetCell>
          <span className="whitespace-pre-wrap break-words text-fg-2">
            {entry.message.trim()}
          </span>
        </div>
      ))}
    </div>
  );
}
