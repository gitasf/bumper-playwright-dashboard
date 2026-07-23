"use client";

import { ChevronRight, CircleAlert, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FILTER_INPUT_CLASSES } from "@/components/filter-controls";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/time-format";
import {
  actionIntersectsRange,
  actionParamHint,
  actionTitle,
  type TraceTimeRange,
} from "../model";
import { useActionTreeCollapse } from "../use-action-tree-collapse";
import type { ActionGroup } from "../vendor/protocol-formatter";
import type { ActionTreeItem, TraceModel } from "../vendor/model-util";
import { buildActionTree, stats } from "../vendor/model-util";

/**
 * Low-signal action groups (`route` handlers, `getter` reads, context
 * `configuration` calls) are HIDDEN by default, matching the official
 * viewer's `filteredActions([])` semantics — chips per group (with counts)
 * toggle them back in. The choice persists across traces.
 */
const GROUPS: ActionGroup[] = ["route", "getter", "configuration"];
const SHOWN_GROUPS_KEY = "wrightful:trace-viewer:shown-action-groups";

/**
 * The persisted set of shown groups + its toggle, best-effort localStorage on
 * both sides so the read that seeds initial state and the write can't drift out
 * of the same serialization shape.
 */
function usePersistentGroupSet(
  key: string,
  groups: readonly ActionGroup[],
): [ReadonlySet<ActionGroup>, (group: ActionGroup) => void] {
  const [shown, setShown] = useState<ReadonlySet<ActionGroup>>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return new Set();
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      return new Set(groups.filter((g) => (parsed as unknown[]).includes(g)));
    } catch {
      return new Set();
    }
  });
  const toggle = (group: ActionGroup): void => {
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      try {
        window.localStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        /* persistence is best-effort */
      }
      return next;
    });
  };
  return [shown, toggle];
}

/**
 * Left pane of the workbench: the merged test-runner/library action tree.
 * Selection is controlled by the workbench (snapshot pane + detail tabs key
 * off it).
 */
export function ActionList({
  model,
  selectedCallId,
  onSelect,
  onHover,
  selection,
  onClearSelection,
}: {
  model: TraceModel;
  selectedCallId: string | undefined;
  onSelect: (callId: string) => void;
  /** Preview-on-hover for the snapshot pane; selection is unaffected. */
  onHover: (callId: string | undefined) => void;
  /** Timeline drag-selection: scope the list to actions in this window. */
  selection: TraceTimeRange | null;
  /** Clears the timeline selection (the "Show all" affordance). */
  onClearSelection: () => void;
}): React.ReactElement {
  const [shownGroups, toggleGroup] = usePersistentGroupSet(
    SHOWN_GROUPS_KEY,
    GROUPS,
  );
  const { rootItem, itemMap } = useMemo(() => {
    const actions = model.filteredActions([...shownGroups]);
    return buildActionTree(
      selection
        ? actions.filter((a) => actionIntersectsRange(a, selection))
        : actions,
    );
  }, [model, shownGroups, selection]);
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;

  // The collapse/override/auto-reveal state machine + the flattened visible-row
  // walk, all in one hook (see `use-action-tree-collapse`).
  const { isCollapsed, toggle, visibleRows } = useActionTreeCollapse({
    rootItem,
    itemMap,
    model,
    selectedCallId,
    query,
  });

  const groupChips = GROUPS.map((group) => ({
    group,
    count: model.actionCounters.get(group) ?? 0,
  })).filter(({ count }) => count > 0);

  const moveSelection = (delta: number): void => {
    const index = visibleRows.findIndex(
      ({ item }) => item.action.callId === selectedCallId,
    );
    const next =
      visibleRows[index + delta] ?? (index === -1 ? visibleRows[0] : null);
    if (next) onSelect(next.item.action.callId);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Borderless, full-width filter row that IS the pane's top edge — the
       * same command-menu / filter-popover input as `ComboboxFilterPopup`
       * (`FILTER_INPUT_CLASSES`), plus the native search-cancel-button reset
       * this borderless context doesn't want. The `h-9` wrapper carries the
       * hairline divider, matching the snapshot pane's Before/Action/After
       * nav (`snapshot-pane.tsx`) so the two panes' dividers align across
       * the split. */}
      <div className="shrink-0 border-b border-line-1">
        <input
          type="search"
          className={cn(
            FILTER_INPUT_CLASSES,
            "[&::-webkit-search-cancel-button]:appearance-none",
          )}
          placeholder="Filter actions"
          aria-label="Filter actions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {/* Timeline-selection scope bar: while a time window is drag-selected on
       * the strip, the list shows only intersecting actions and this bar is
       * the escape hatch back to the full list. */}
      {selection ? (
        <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-line-1 bg-bg-2 pl-3 pr-1.5">
          <span className="truncate text-caption text-fg-3">
            Timeline selection
          </span>
          <button
            type="button"
            onClick={onClearSelection}
            className="shrink-0 rounded px-1.5 py-0.5 text-caption font-medium text-fg-2 hover:bg-bg-3"
          >
            Show all
          </button>
        </div>
      ) : null}
      {groupChips.length > 0 ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line-1 px-2 py-1.5">
          {groupChips.map(({ group, count }) => {
            const shown = shownGroups.has(group);
            return (
              <Tooltip key={group}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-pressed={shown}
                      onClick={() => toggleGroup(group)}
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-micro tabular-nums",
                        shown
                          ? "border-ring/40 bg-bg-3 text-fg-2"
                          : "border-line-1 text-fg-4 hover:text-fg-2",
                      )}
                    >
                      {group} {count}
                    </button>
                  }
                />
                <TooltipPopup>
                  {shown
                    ? `Hide ${count} ${group} action${count === 1 ? "" : "s"}`
                    : `Show ${count} ${group} action${count === 1 ? "" : "s"}`}
                </TooltipPopup>
              </Tooltip>
            );
          })}
        </div>
      ) : null}
      <div
        role="listbox"
        aria-label="Actions"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            moveSelection(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            moveSelection(-1);
          }
        }}
        onPointerLeave={() => onHover(undefined)}
      >
        {visibleRows.map(({ item, depth }) => (
          <ActionRow
            key={item.id}
            item={item}
            depth={depth}
            startTime={model.startTime}
            selected={item.action.callId === selectedCallId}
            // While filtering, the tree is force-expanded (matches + ancestors
            // are shown regardless of collapse) and toggling is disabled, so
            // the chevron reflects that instead of the underlying override.
            isCollapsed={searching ? false : isCollapsed(item.id)}
            onToggle={searching ? undefined : toggle}
            onSelect={onSelect}
            onHover={onHover}
          />
        ))}
        {visibleRows.length === 0 ? (
          <div className="px-3 py-6 text-center text-caption text-fg-4">
            {selection
              ? "No actions in the selected timeline range."
              : "No actions recorded in this trace."}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ActionRow({
  item,
  depth,
  startTime,
  selected,
  isCollapsed,
  onToggle,
  onSelect,
  onHover,
}: {
  item: ActionTreeItem;
  depth: number;
  startTime: number;
  selected: boolean;
  isCollapsed: boolean;
  /** Undefined disables the disclosure toggle (e.g. while filtering). */
  onToggle?: (id: string) => void;
  onSelect: (callId: string) => void;
  /** Fires synchronously on pointer enter — the snapshot pane double-buffers
   * its iframes, so a sweep across rows is safe without debouncing. */
  onHover?: (callId: string) => void;
}): React.ReactElement {
  const action = item.action;
  const failed = Boolean(action.error?.message);
  const { errors, warnings } = stats(action);
  const duration = action.endTime - action.startTime;
  const paramHint = actionParamHint(action);
  const hasChildren = item.children.length > 0;
  // One chevron, wrapped interactively or not below; only the toggleable
  // variant animates its rotation.
  const chevron = (
    <ChevronRight
      className={cn(
        "size-3.5",
        onToggle && "transition-transform",
        !isCollapsed && "rotate-90",
      )}
    />
  );

  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div
      role="option"
      aria-selected={selected}
      data-status={failed ? "fail" : "ok"}
      ref={rowRef}
      onClick={() => {
        onSelect(action.callId);
        // Selecting a row also expands it — the chevron button handles the
        // toggle-without-select case itself via stopPropagation, so this
        // never double-toggles a chevron click.
        if (hasChildren && onToggle) onToggle(item.id);
      }}
      onPointerEnter={() => onHover?.(action.callId)}
      className={cn(
        "flex h-7 cursor-pointer items-center gap-1.5 pr-2 text-body",
        selected ? "bg-bg-3" : "hover:bg-bg-2",
      )}
      style={{ paddingLeft: depth * 14 + 6 }}
    >
      {!hasChildren ? (
        <span className="size-4 shrink-0" />
      ) : onToggle ? (
        <button
          type="button"
          aria-label={isCollapsed ? "Expand" : "Collapse"}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(item.id);
          }}
          className="flex size-4 shrink-0 items-center justify-center rounded text-fg-4 hover:text-fg-2"
        >
          {chevron}
        </button>
      ) : (
        <span className="flex size-4 shrink-0 items-center justify-center text-fg-4">
          {chevron}
        </span>
      )}
      {failed ? <CircleAlert className="size-3.5 shrink-0 text-fail" /> : null}
      <span
        className={cn("shrink-0", failed && "text-fail")}
        title={actionTitle(action)}
      >
        {actionTitle(action)}
      </span>
      {paramHint ? (
        <span
          className="min-w-0 flex-1 truncate font-mono text-caption text-fg-4"
          title={paramHint}
        >
          {paramHint}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      {errors > 0 ? (
        <span
          className="flex shrink-0 items-center gap-0.5 text-micro text-fail"
          title={`${errors} console error${errors === 1 ? "" : "s"}`}
        >
          <CircleAlert className="size-3" />
          {errors}
        </span>
      ) : null}
      {warnings > 0 ? (
        <span
          className="flex shrink-0 items-center gap-0.5 text-micro text-warning"
          title={`${warnings} console warning${warnings === 1 ? "" : "s"}`}
        >
          <TriangleAlert className="size-3" />
          {warnings}
        </span>
      ) : null}
      <span className="shrink-0 font-mono text-micro text-fg-4 tabular-nums">
        {duration >= 0 ? formatDuration(Math.max(1, Math.round(duration))) : ""}
      </span>
      <span className="sr-only">
        starts at {formatDuration(Math.round(action.startTime - startTime))}
      </span>
    </div>
  );
}
