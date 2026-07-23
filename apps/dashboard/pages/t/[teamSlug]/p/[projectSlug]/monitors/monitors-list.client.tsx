"use client";

import { Search } from "lucide-react";
import { RowLink } from "@/components/row-link";
import { useState } from "react";
import {
  ExecStrip,
  MonBadge,
  MonGlyph,
  monitorDisplayStatus,
  MonTypeGlyph,
  SummaryPill,
} from "@/components/monitors/monitor-status";
import { PageToolbar } from "@/components/page-toolbar";
import { META_PILL_CLASSES } from "@/components/run/meta-pills";
import { SearchFilterInput } from "@/components/search-filter-input";
import { SegmentedControl } from "@/components/segmented-control";
import { TablePaginationFooter } from "@/components/table-pagination-footer";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { useFeedRoom } from "@/realtime/use-feed-room";
import { formatRelativeTime } from "@/lib/time-format";
import { applyMonitorFeedEvent } from "./monitor-feed";
import { humanizeInterval, monitorTypeLabel } from "./monitors-ui.shared";
import type { Props } from "./index.server";

type Monitor = Props["monitors"][number];

type StatusFilter = "all" | "failing" | "paused";

/**
 * Interactive monitors roster — filter + search + per-row pause toggle, live
 * over the project's `void/ws` room. The loader hands the enriched monitors in
 * as props; this island filters them client-side (instant filtering) and folds
 * `monitor-result` events into the rows via `applyMonitorFeedEvent` so a check
 * that runs anywhere advances its row's status + history strip without a reload.
 *
 * It subscribes to the SAME per-project room the runs list uses (the reducer
 * ignores `run-*` events), shared + ref-counted by `useRoom`. Rooms have no
 * replay, so a reconnect after a drop triggers a coalesced `router.refresh()`
 * and `useSeededState` reseeds from the fresh loader props. The row toggle POSTs
 * to the detail route's `?toggleEnabled` action via `fetch` (so it doesn't
 * navigate away) and reflects the new state through the same seeded setter.
 */
export function MonitorsList({
  monitors: initialMonitors,
  monitorsBase,
  projectId,
  isOwner,
}: {
  monitors: Monitor[];
  monitorsBase: string;
  projectId: string;
  isOwner: boolean;
}) {
  // Shared per-project room — so this also receives the runs list's `run-*`
  // frames, which the reducer discards by returning the SAME array reference
  // (React bails out: no re-render, just the frame's parse cost). Fine at
  // monitor + CI volumes; a dedicated monitor topic is the lever if a very busy
  // project ever makes that discard traffic matter. `useFeedRoom` owns the
  // seed/fold/reconnect-refresh plumbing; `setMonitors` is kept for the
  // optimistic pause toggle below, which writes the same seeded list.
  const [monitors, setMonitors] = useFeedRoom(
    "/ws/project/:projectId",
    { projectId },
    [projectId, initialMonitors],
    () => [...initialMonitors] as readonly Monitor[],
    (prev, event) => applyMonitorFeedEvent(prev, event),
  );
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  // Status counts use the MONITOR's display status (paused beats last result),
  // matching the summary strip + the design's per-state tallies. States outside
  // the strip (running/queued/never) aren't tallied.
  const counts = { pass: 0, degraded: 0, fail: 0, error: 0, paused: 0 };
  for (const m of monitors) {
    const status = monitorDisplayStatus(m);
    if (
      status === "pass" ||
      status === "degraded" ||
      status === "fail" ||
      status === "error" ||
      status === "paused"
    ) {
      counts[status] += 1;
    }
  }

  const filtered = monitors.filter((m) => {
    if (search && !m.name.toLowerCase().includes(search.toLowerCase())) {
      return false;
    }
    const status = monitorDisplayStatus(m);
    if (
      statusFilter === "failing" &&
      !(status === "fail" || status === "error")
    ) {
      return false;
    }
    if (statusFilter === "paused" && status !== "paused") return false;
    return true;
  });

  function setEnabled(id: string, enabled: boolean) {
    setMonitors((prev) =>
      prev.map((m) => (m.id === id ? { ...m, enabled: enabled ? 1 : 0 } : m)),
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Status summary strip */}
      <PageToolbar>
        <SummaryPill count={counts.pass} label="Passing" state="pass" />
        <SummaryPill
          count={counts.degraded}
          label="Degraded"
          state="degraded"
        />
        <SummaryPill count={counts.fail} label="Failing" state="fail" />
        <SummaryPill count={counts.error} label="Errored" state="error" />
        <SummaryPill count={counts.paused} label="Paused" state="paused" />
        <div className="flex-1" />
        <SegmentedControl
          compact
          onChange={setStatusFilter}
          options={[
            { value: "all", label: "All" },
            { value: "failing", label: "Failing" },
            { value: "paused", label: "Paused" },
          ]}
          value={statusFilter}
        />
        <SearchFilterInput
          aria-label="Search monitors"
          className="w-[240px]"
          onChange={(e) => setSearch(e.currentTarget.value)}
          placeholder="Search monitors…"
          value={search}
        />
      </PageToolbar>

      <div className="min-h-0 flex-1 overflow-auto">
        <Table className="min-w-[980px] table-fixed" stickyHeader>
          <TableHeader className="sticky top-0 z-20 bg-bg-0/95 backdrop-blur-sm">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10 px-4" />
              <TableHead className="px-4">Monitor</TableHead>
              <TableHead className="w-[100px] px-4">Interval</TableHead>
              <TableHead className="w-[186px] px-4">Recent</TableHead>
              <TableHead className="w-[116px] px-4 text-right">
                Last run
              </TableHead>
              <TableHead className="w-[104px] px-4 text-right">
                Enabled
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((m) => (
              <MonitorRow
                isOwner={isOwner}
                key={m.id}
                monitor={m}
                monitorsBase={monitorsBase}
                onToggle={setEnabled}
              />
            ))}
          </TableBody>
        </Table>

        {filtered.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Search />
              </EmptyMedia>
              <EmptyTitle>No monitors match</EmptyTitle>
              <EmptyDescription>
                Try a different search or clear the status filter.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>

      {filtered.length > 0 && (
        <TablePaginationFooter
          fromRow={1}
          itemNoun="monitor"
          toRow={filtered.length}
          totalCount={monitors.length}
        />
      )}
    </div>
  );
}

function MonitorRow({
  monitor: m,
  monitorsBase,
  onToggle,
  isOwner,
}: {
  monitor: Monitor;
  monitorsBase: string;
  onToggle: (id: string, enabled: boolean) => void;
  isOwner: boolean;
}) {
  const status = monitorDisplayStatus(m);
  const href = `${monitorsBase}/${m.id}`;
  const enabled = m.enabled === 1;
  const [pending, setPending] = useState(false);

  async function toggle(next: boolean) {
    if (pending) return;
    setPending(true);
    onToggle(m.id, next); // optimistic
    try {
      const body = new FormData();
      body.set("enabled", next ? "true" : "false");
      const res = await fetch(`${href}?toggleEnabled`, {
        method: "POST",
        body,
        // The action 302s to the detail page; we only care that it landed.
        redirect: "manual",
      });
      if (res.type !== "opaqueredirect" && !res.ok) {
        onToggle(m.id, !next); // revert
      }
    } catch {
      onToggle(m.id, !next); // revert
    } finally {
      setPending(false);
    }
  }

  return (
    <TableRow className="cursor-pointer">
      <TableCell className="w-10 px-4 py-3 align-middle">
        {/* Match RowLink's default centered-flex layout so the glyph lands at
         * the same x as the RowLink-wrapped glyphs on runs/flaky/tests. */}
        <span className="flex items-center justify-center">
          <MonGlyph size={14} state={status} />
        </span>
      </TableCell>

      <TableCell className="px-4 py-3 align-middle">
        <RowLink
          className="min-w-0 flex-col items-stretch justify-start gap-[3px]"
          href={href}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              className="max-w-[360px] truncate text-body-lg text-fg-1"
              title={m.name}
            >
              {m.name}
            </span>
            <span className={cn(META_PILL_CLASSES, "shrink-0 gap-1")}>
              <MonTypeGlyph type={m.type} />
              {monitorTypeLabel(m.type)}
            </span>
          </span>
          <span className="mt-px">
            <MonBadge size="sm" state={status} />
          </span>
        </RowLink>
      </TableCell>

      <TableCell className="w-[100px] px-4 py-3 align-middle font-mono text-body text-fg-2">
        {humanizeInterval(m.intervalSeconds)}
      </TableCell>

      <TableCell className="w-[186px] px-4 py-3 align-middle">
        <ExecStrip executions={m.recentExecutions} />
      </TableCell>

      <TableCell className="w-[116px] px-4 py-3 text-right align-middle text-caption text-fg-2">
        {m.lastRunAt ? (
          formatRelativeTime(m.lastRunAt)
        ) : (
          <span className="text-fg-4">—</span>
        )}
      </TableCell>

      <TableCell className="w-[104px] px-4 py-3 align-middle">
        {/* `relative z-10` lifts the switch above the row's stretched-link so
         * the toggle gets the click instead of navigating. */}
        <div className="relative z-10 flex justify-end">
          <Switch
            aria-label={enabled ? "Pause monitor" : "Resume monitor"}
            checked={enabled}
            // Members get a read-only roster — only owners can pause/resume
            // (the `toggleEnabled` action is owner-gated server-side too).
            disabled={!isOwner || pending}
            onCheckedChange={(next) => {
              void toggle(next);
            }}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}
