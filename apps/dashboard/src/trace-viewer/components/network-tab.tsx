"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import type React from "react";
import { useRef, useState } from "react";
import { SearchFilterInput } from "@/components/search-filter-input";
import { SegmentedControl } from "@/components/segmented-control";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatBytes, formatTraceDuration } from "../format";
import { monotonicTime } from "../har-fields";
import { timeInRange, type TraceTimeRange } from "../model";
import type { TraceBridge } from "../use-trace-model";
import type {
  ActionTraceEventInContext,
  TraceModel,
} from "../vendor/model-util";
import { ScopedEmpty, TabNotice } from "./detail-shared";
import { DETAIL_PANEL_ID, DetailPanel } from "./network-detail-panel";
import {
  compareEntries,
  entryMimeType,
  entrySize,
  RESOURCE_TYPE_OPTIONS,
  type ResourceTypeFilter,
  resourceTypeOf,
  selectNetworkEntries,
  shortUrl,
  type SortKey,
  type SortState,
} from "./network-columns";

/**
 * Header cell that cycles its column's sort on click: ascending →
 * descending → back to the trace's natural (request-start) order. The icon
 * slot is always rendered so the column doesn't shift when sorting engages.
 */
function SortableHead({
  label,
  sortKey,
  sort,
  onToggle,
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState | null;
  onToggle: (key: SortKey) => void;
}): React.ReactElement {
  const dir = sort?.key === sortKey ? sort.dir : null;
  return (
    <TableHead
      aria-sort={
        dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined
      }
      // The cell's padding moves onto the full-bleed button so the whole
      // header — not just the label text — is the click target.
      className="p-0"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => onToggle(sortKey)}
              // Inset ring: the button is full-bleed inside a sticky header
              // row, so an outward ring/outline would clip against the
              // neighboring cells.
              className="flex size-full items-center gap-0.5 px-2.5 outline-none hover:text-fg-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              {label}
              <span aria-hidden className="inline-flex size-3 items-center">
                {dir === "asc" ? (
                  <ChevronUp className="size-3" />
                ) : dir === "desc" ? (
                  <ChevronDown className="size-3" />
                ) : null}
              </span>
            </button>
          }
        />
        <TooltipPopup>Sort by {label.toLowerCase()}</TooltipPopup>
      </Tooltip>
    </TableHead>
  );
}

/** Column order for the request table header — the sort accessors themselves
 * are table-driven in `network-columns.ts` (`SORT_ACCESSORS`); this is the
 * matching label/key pairing for the header row. */
const NETWORK_COLUMNS: { label: string; key: SortKey }[] = [
  { label: "Name", key: "name" },
  { label: "Status", key: "status" },
  { label: "Method", key: "method" },
  { label: "Type", key: "type" },
  { label: "Size", key: "size" },
  { label: "Duration", key: "duration" },
];

/**
 * HAR entries as a dense request table, highlighting the selected action's
 * window. A toolbar filters by URL substring and DevTools-style resource
 * type. Selecting a row splits the tab to show a request detail panel
 * (official-viewer parity: general/timing/headers/bodies).
 */
export function NetworkTab({
  model,
  selectedAction,
  scopeToSelected,
  selection,
  bridge,
}: {
  model: TraceModel;
  selectedAction: ActionTraceEventInContext | undefined;
  scopeToSelected: boolean;
  selection: TraceTimeRange | null;
  bridge: TraceBridge;
}): React.ReactElement {
  const scoped = scopeToSelected && selectedAction != null;
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<ResourceTypeFilter>("all");
  const [sort, setSort] = useState<SortState | null>(null);
  const toggleSort = (key: SortKey): void =>
    setSort((prev) =>
      prev?.key !== key
        ? { key, dir: "asc" }
        : prev.dir === "asc"
          ? { key, dir: "desc" }
          : null,
    );
  // A timeline selection narrows the entry universe first (by request start
  // time); the crosshair's action-window scoping then applies within it.
  const allEntries = selectNetworkEntries(model, selection);
  // The selected action's window as a range — the timeline-selection filter
  // above and the action-window scoping/highlighting here share one
  // `timeInRange` predicate. Scoped: filter to it. Unscoped: keep every entry
  // and merely highlight the ones inside it (below).
  const actionRange: TraceTimeRange | null = selectedAction
    ? { start: selectedAction.startTime, end: selectedAction.endTime }
    : null;
  const scopedEntries =
    scoped && actionRange
      ? allEntries.filter((entry) =>
          timeInRange(monotonicTime(entry), actionRange),
        )
      : allEntries;

  const needle = query.trim().toLowerCase();
  const filtered = scopedEntries.filter(
    (entry) =>
      (typeFilter === "all" || resourceTypeOf(entry) === typeFilter) &&
      (needle === "" || entry.request.url.toLowerCase().includes(needle)),
  );
  // Unsorted = the trace's natural request-start order.
  const entries = sort
    ? [...filtered].sort((a, b) => compareEntries(a, b, sort))
    : filtered;

  // DetailTabs keys its panel boundary by `bridge.traceUrl`, so this state is
  // scoped to one model even though the surrounding Workbench deliberately
  // stays mounted across an attempt swap. A scoped-out or filtered-out
  // selection simply isn't found below (`selectedEntry` is undefined) and the
  // detail panel hides — it reappears if the scope/filter is relaxed again.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedEntry = entries.find((entry) => entry.id === selectedId);
  // The selected row's disclosure button — closing the panel via its X would
  // otherwise drop keyboard focus on an unmounted element.
  const selectedRowButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeDetailPanel = (): void => {
    setSelectedId(null);
    selectedRowButtonRef.current?.focus();
  };

  if (scopedEntries.length === 0) {
    return (
      <ScopedEmpty
        scoped={scoped}
        selection={selection !== null}
        actionScopedMessage="No requests during this action."
        rangeScopedMessage="No requests in the selected timeline range."
        title="No network activity"
        description="This trace recorded no network requests."
      />
    );
  }

  const toolbar = (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line-1 px-2 py-1.5">
      <SearchFilterInput
        placeholder="Filter requests"
        aria-label="Filter requests"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="min-w-40 flex-1"
      />
      <SegmentedControl
        compact
        value={typeFilter}
        onChange={setTypeFilter}
        options={RESOURCE_TYPE_OPTIONS}
      />
    </div>
  );

  const tableArea = (
    <ScrollArea className="h-full">
      <Table stickyHeader>
        <TableHeader className="sticky top-0 z-10 bg-bg-0">
          <TableRow>
            {NETWORK_COLUMNS.map(({ label, key }) => (
              <SortableHead
                key={key}
                label={label}
                sortKey={key}
                sort={sort}
                onToggle={toggleSort}
              />
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => {
            const isHighlighted =
              !scoped &&
              actionRange != null &&
              timeInRange(monotonicTime(entry), actionRange);
            const isSelected = entry.id === selectedId;
            return (
              <TableRow
                key={entry.id}
                className={cn(
                  isSelected ? "bg-bg-3" : isHighlighted && "bg-bg-2",
                )}
              >
                <TableCell className="max-w-[320px]">
                  {/* Stretched disclosure button (the RowLink pattern, but a
                      button): its after-pseudo fills the `relative` TableRow,
                      so the whole row toggles the detail panel while keyboard
                      focus, the accessible name, and the expanded state live
                      on a real control. */}
                  <button
                    type="button"
                    ref={isSelected ? selectedRowButtonRef : undefined}
                    onClick={() =>
                      setSelectedId((prev) =>
                        prev === entry.id ? null : entry.id,
                      )
                    }
                    aria-expanded={isSelected}
                    aria-controls={isSelected ? DETAIL_PANEL_ID : undefined}
                    title={entry.request.url}
                    className="block w-full truncate text-left focus-visible:outline-none after:absolute after:inset-0 after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                  >
                    {shortUrl(entry.request.url)}
                  </button>
                </TableCell>
                <TableCell
                  data-status={entry.response.status >= 400 ? "fail" : "ok"}
                  className={cn(
                    "font-mono",
                    entry.response.status >= 400 && "text-fail",
                  )}
                >
                  {entry.response.status || "—"}
                </TableCell>
                <TableCell className="font-mono text-fg-3">
                  {entry.request.method}
                </TableCell>
                <TableCell className="text-fg-4">
                  {entryMimeType(entry) || "—"}
                </TableCell>
                <TableCell className="font-mono text-fg-3">
                  {formatBytes(entrySize(entry))}
                </TableCell>
                <TableCell className="font-mono text-fg-3">
                  {formatTraceDuration(entry.time)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ScrollArea>
  );

  const content =
    entries.length === 0 ? (
      // Filters excluded everything — keep the toolbar visible (unlike the
      // no-requests-at-all early return above) so they can be cleared.
      <TabNotice>No matching requests.</TabNotice>
    ) : (
      // One stable wrapper whether or not the detail panel is open — swapping
      // the structure would remount the table, which resets its scroll
      // position and detaches the focused row button mid-interaction.
      <div className="flex h-full min-h-0 flex-col sm:flex-row">
        <div
          className={cn(
            "min-h-0 min-w-0",
            selectedEntry ? "shrink-0 grow-0 basis-[55%]" : "flex-1",
          )}
        >
          {tableArea}
        </div>
        {selectedEntry ? (
          <div className="min-h-0 min-w-0 flex-1">
            <DetailPanel
              entry={selectedEntry}
              bridge={bridge}
              onClose={closeDetailPanel}
            />
          </div>
        ) : null}
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      <div className="min-h-0 flex-1">{content}</div>
    </div>
  );
}
