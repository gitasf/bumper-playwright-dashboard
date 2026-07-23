"use client";

import { CircleAlert, TriangleAlert } from "lucide-react";
import type React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { stripAnsi } from "@/lib/ansi";
import { basename } from "@/lib/basename";
import { cn } from "@/lib/cn";
import { formatTraceOffset } from "../format";
import { timeInRange, type TraceTimeRange } from "../model";
import {
  eventsForAction,
  type ActionTraceEventInContext,
  type TraceModel,
} from "../vendor/model-util";
import type {
  ConsoleMessageTraceEvent,
  EventTraceEvent,
} from "../vendor/trace";
import { OFFSET_GRID_CLASSES, OffsetCell, ScopedEmpty } from "./detail-shared";

/**
 * A console message or an uncaught-page-error event. The `method: "pageError"`
 * narrowing (rather than the guard parameter's full union) is what makes
 * `rowMessage`/`rowSeverity`'s `type === "event"` branches — which assume
 * `pageError` — compiler-checked instead of merely convention.
 */
type ConsoleRow =
  | ConsoleMessageTraceEvent
  | (EventTraceEvent & { method: "pageError" });

/** Console messages + uncaught page errors — shared with `DetailTabs`' tab-label count. */
function isConsoleRow(
  event: EventTraceEvent | ConsoleMessageTraceEvent,
): event is ConsoleRow {
  return (
    event.type === "console" ||
    (event.type === "event" && event.method === "pageError")
  );
}

/**
 * Console rows visible for a timeline `selection` (before the crosshair's
 * action-window scoping). The single source of truth for both the tab body
 * below and `DetailTabs`' tab-label count, so the badge can't disagree with
 * the list.
 */
export function selectConsoleRows(
  model: TraceModel,
  selection: TraceTimeRange | null,
): ConsoleRow[] {
  return model.events
    .filter(isConsoleRow)
    .filter((event) => !selection || timeInRange(event.time, selection));
}

function rowMessage(event: ConsoleRow): string {
  if (event.type === "console") return stripAnsi(event.text).trim();
  const raw: unknown = event.params?.error?.error?.message;
  const message = typeof raw === "string" ? raw : "Uncaught (in promise)";
  return stripAnsi(message).trim();
}

function rowLocation(event: ConsoleRow): string | undefined {
  if (event.type !== "console" || !event.location.url) return undefined;
  const last = basename(event.location.url) || event.location.url;
  return `${last}:${event.location.lineNumber}`;
}

function rowSeverity(event: ConsoleRow): "error" | "warning" | undefined {
  if (event.type === "event") return "error";
  if (event.messageType === "error") return "error";
  if (event.messageType === "warning") return "warning";
  return undefined;
}

/** Console messages + uncaught page errors, time-ordered, ANSI-stripped. */
export function ConsoleTab({
  model,
  selectedAction,
  scopeToSelected,
  selection,
}: {
  model: TraceModel;
  selectedAction: ActionTraceEventInContext | undefined;
  scopeToSelected: boolean;
  selection: TraceTimeRange | null;
}): React.ReactElement {
  // A timeline selection narrows the row universe first; the crosshair's
  // action-window scoping (and highlighting) then applies within it.
  const allRows = selectConsoleRows(model, selection);
  const actionEvents = selectedAction
    ? new Set(eventsForAction(selectedAction))
    : undefined;
  // Scoped: filter to the selected action's window. Unscoped: keep every row
  // and merely highlight the ones in that window. (`scoped` is an aliased
  // condition, so TS narrows `actionEvents` through it.)
  const scoped = scopeToSelected && actionEvents !== undefined;
  const rows = scoped
    ? allRows.filter((event) => actionEvents.has(event))
    : allRows;
  const highlighted = scoped ? undefined : actionEvents;

  if (rows.length === 0) {
    return (
      <ScopedEmpty
        scoped={scoped}
        selection={selection !== null}
        actionScopedMessage="No console output during this action."
        rangeScopedMessage="No console output in the selected timeline range."
        title="No console output"
        description="This trace recorded no console messages or page errors."
      />
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className={cn(OFFSET_GRID_CLASSES, "divide-y divide-line-1")}>
        {rows.map((event, i) => {
          const severity = rowSeverity(event);
          const location = rowLocation(event);
          return (
            <div
              key={`${event.time}-${i}`}
              className={cn(
                "col-span-full grid grid-cols-subgrid items-start px-3 py-1.5 text-body font-mono",
                highlighted?.has(event) && "bg-bg-2",
              )}
            >
              <OffsetCell>
                {formatTraceOffset(event.time, model.startTime, {
                  signed: false,
                })}
              </OffsetCell>
              <span className="flex min-w-0 items-start gap-2">
                {severity === "error" ? (
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-fail" />
                ) : null}
                {severity === "warning" ? (
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                ) : null}
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                  {rowMessage(event)}
                </span>
                {location ? (
                  <span
                    className="max-w-[35%] shrink-0 truncate text-fg-4"
                    title={
                      event.type === "console" ? event.location.url : undefined
                    }
                  >
                    {location}
                  </span>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
