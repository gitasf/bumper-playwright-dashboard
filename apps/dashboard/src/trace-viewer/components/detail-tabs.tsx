"use client";

import { Crosshair } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TabBar, TabBarTab } from "@/components/ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import type { TraceTimeRange } from "../model";
import type { TraceBridge } from "../use-trace-model";
import type {
  ActionTraceEventInContext,
  TraceModel,
} from "../vendor/model-util";
import { AttachmentsTab } from "./attachments-tab";
import { CallTab } from "./call-tab";
import { ConsoleTab, selectConsoleRows } from "./console-tab";
import { ErrorsTab } from "./errors-tab";
import { LogTab } from "./log-tab";
import { MetadataTab } from "./metadata-tab";
import { selectNetworkEntries } from "./network-columns";
import { NetworkTab } from "./network-tab";
import { SourceTab } from "./source-tab";

/** Inputs owned by the detail-tab coordinator. Leaf tabs receive only the
 * subset they actually use. */
export type DetailTabsProps = {
  model: TraceModel;
  selectedAction: ActionTraceEventInContext | undefined;
  /**
   * The hover-aware action mirroring the snapshot canvas: the hovered
   * action-list row while previewing, else `selectedAction` (the workbench
   * computes `hoveredAction ?? selectedAction` once and shares it). Tabs that
   * render ONE action's detail (Call/Log/Source) key on this, matching the
   * official viewer's `highlightedAction || selectedAction`. Selection-scoped
   * tabs deliberately stay on `selectedAction` instead — Console/Network's
   * highlighting + `scopeToSelected` window, and Attachments — so a hover
   * sweep can't yank filters or scroll positions.
   */
  activeAction: ActionTraceEventInContext | undefined;
  /** Select an action in the action list (e.g. from an error's link). */
  onSelectAction: (callId: string) => void;
  /** Fetch proxy into the SW-controlled bridge (sha1 bytes, snapshotInfo…) —
   * also carries the absolute trace URL (`bridge.traceUrl`) that drives
   * SW-served attachment/resource links. */
  bridge: TraceBridge;
  /**
   * The timeline's drag-selected time window. While active, the
   * time-windowed tabs (Console/Network/Log) show only entries inside it —
   * on top of (and independent from) the `scopeToSelected` action window.
   */
  selection: TraceTimeRange | null;
};

type DetailTabId =
  | "call"
  | "log"
  | "errors"
  | "console"
  | "network"
  | "source"
  | "attachments"
  | "metadata";

/** One tab bar entry + its body, the single place the tab set is enumerated. */
type TabConfig = {
  id: DetailTabId;
  label: string;
  count?: number;
  /** Whether the crosshair "scope to selected action's window" toggle applies. */
  scopable?: boolean;
  render: () => React.ReactElement;
};

/**
 * Bottom pane: cross-cutting trace details. Counts on the tab labels are
 * whole-trace (narrowed to the timeline selection while one is active);
 * Call/Log/Source follow `activeAction` (hover-aware); Errors, Attachments
 * and Metadata stay on `selectedAction`; Console/Network can optionally
 * FILTER to the selected action's window (the crosshair toggle) instead of
 * only highlighting it, and always filter to the timeline `selection` window
 * when one is drag-selected on the strip.
 */
export function DetailTabs({
  model,
  selectedAction,
  activeAction,
  onSelectAction,
  bridge,
  selection,
}: DetailTabsProps): React.ReactElement {
  const errorCount = model.errorDescriptors.length;
  // Console/Network tab-label counts derive from the SAME selectors the tab
  // bodies use, so a label can never disagree with the list it heads.
  const consoleCount = selectConsoleRows(model, selection).length;
  const networkCount = selectNetworkEntries(model, selection).length;
  const [tab, setTab] = useState<DetailTabId>(
    errorCount > 0 ? "errors" : "call",
  );
  const [scopeToSelected, setScopeToSelected] = useState(false);

  // The single place the tab set is enumerated — the tab bar, the active
  // panel, and the crosshair's `scopable` gate all read from this one array
  // instead of separately re-listing the eight tabs.
  const tabs: TabConfig[] = [
    {
      id: "call",
      label: "Call",
      render: () => <CallTab model={model} activeAction={activeAction} />,
    },
    {
      id: "log",
      label: "Log",
      render: () => (
        <LogTab
          action={activeAction}
          startTime={model.startTime}
          selection={selection}
        />
      ),
    },
    {
      id: "errors",
      label: "Errors",
      count: errorCount,
      render: () => <ErrorsTab model={model} onSelectAction={onSelectAction} />,
    },
    {
      id: "console",
      label: "Console",
      count: consoleCount,
      scopable: true,
      render: () => (
        <ConsoleTab
          model={model}
          selectedAction={selectedAction}
          scopeToSelected={scopeToSelected}
          selection={selection}
        />
      ),
    },
    {
      id: "network",
      label: "Network",
      count: networkCount,
      scopable: true,
      render: () => (
        <NetworkTab
          model={model}
          selectedAction={selectedAction}
          scopeToSelected={scopeToSelected}
          selection={selection}
          bridge={bridge}
        />
      ),
    },
    // Source drops from the tab set entirely when the attempt recorded no
    // source, rather than rendering an empty pane.
    ...(model.hasSource
      ? [
          {
            id: "source" as const,
            label: "Source",
            render: () => (
              // Keyed so a selection change remounts the tab — fresh default
              // file + frame index for the new action's stack (see SourceTab).
              <SourceTab
                key={activeAction?.callId ?? ""}
                model={model}
                activeAction={activeAction}
                bridge={bridge}
              />
            ),
          },
        ]
      : []),
    {
      id: "attachments",
      label: "Attachments",
      count: model.visibleAttachments.length,
      render: () => <AttachmentsTab model={model} bridge={bridge} />,
    },
    {
      id: "metadata",
      label: "Metadata",
      render: () => <MetadataTab model={model} />,
    },
  ];

  // The workbench stays mounted across an attempt swap, so `tab` survives into
  // the new model. A tab can disappear from the list (Source drops when the new
  // attempt recorded no source) — fall back to the first tab so the body never
  // renders a pane whose tab is no longer selectable.
  const activeTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  const activeEntry = tabs.find((t) => t.id === activeTab) ?? tabs[0];
  const scopable = activeEntry.scopable ?? false;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-end justify-between gap-2 pr-2">
        <TabBar className="min-w-0 flex-1 px-2" role="tablist">
          {tabs.map(({ id, label, count }) => (
            <TabBarTab
              key={id}
              active={activeTab === id}
              onSelect={() => setTab(id)}
            >
              {label}
              {count ? (
                id === "errors" ? (
                  <Badge
                    variant="destructive"
                    size="sm"
                    className="tabular-nums"
                  >
                    {count}
                  </Badge>
                ) : (
                  <span className="ml-1 text-micro text-fg-4 tabular-nums">
                    {count}
                  </span>
                )
              ) : null}
            </TabBarTab>
          ))}
        </TabBar>
        {scopable ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-pressed={scopeToSelected}
                  aria-label="Filter to the selected action's window"
                  onClick={() => setScopeToSelected((v) => !v)}
                  className={cn("mb-1", scopeToSelected && "bg-bg-3 text-fg-2")}
                >
                  <Crosshair />
                </Button>
              }
            />
            <TooltipPopup>
              {scopeToSelected
                ? "Showing only the selected action's window — click to show all"
                : "Filter to the selected action's window"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {/* Keep the chosen tab + crosshair preference across attempts, but remount
          the active panel when the model changes. Leaf state such as Network's
          query/selected request and Attachments' open preview belongs to one
          trace and must never reconcile onto the next attempt's data. */}
      <div key={bridge.traceUrl} className="min-h-0 flex-1">
        {activeEntry.render()}
      </div>
    </div>
  );
}
