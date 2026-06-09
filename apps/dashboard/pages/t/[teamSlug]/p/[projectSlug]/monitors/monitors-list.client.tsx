"use client";

import { Search } from "lucide-react";
import { useState } from "react";
import { Link } from "@void/react";
import {
  ExecStrip,
  MonBadge,
  MonGlyph,
  monitorDisplayStatus,
  SummaryPill,
} from "@/components/monitors/monitor-status";
import { SearchFilterInput } from "@/components/search-filter-input";
import { SegmentedControl } from "@/components/segmented-control";
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
import { formatRelativeTime } from "@/lib/time-format";
import { humanizeInterval } from "./monitors-ui.shared";
import type { Props } from "./index.server";

type Monitor = Props["monitors"][number];

type StatusFilter = "all" | "failing" | "paused";

/**
 * Interactive monitors roster — filter + search + per-row pause toggle. The
 * loader hands the enriched monitors in as props and this island filters them
 * client-side (matching the design's instant filtering). The row toggle POSTs
 * to the detail route's `?toggleEnabled` action via `fetch` (so it doesn't
 * navigate away to the detail page the action redirects to) and reflects the
 * new state locally on success.
 */
export function MonitorsList({
  monitors: initialMonitors,
  monitorsBase,
  isOwner,
}: {
  monitors: Monitor[];
  monitorsBase: string;
  isOwner: boolean;
}) {
  const [monitors, setMonitors] = useState(initialMonitors);
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
      <div className="flex shrink-0 items-center gap-3 border-b border-line-1 px-6 py-3.5">
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
          className="w-[220px]"
          onChange={(e) => setSearch(e.currentTarget.value)}
          placeholder="Search monitors…"
          value={search}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Table className="min-w-[980px] table-fixed">
          <TableHeader className="sticky top-0 z-10 bg-bg-0">
            <TableRow className="hover:bg-transparent">
              <Th className="w-[44px]" />
              <Th>Monitor</Th>
              <Th className="w-[100px]">Interval</Th>
              <Th className="w-[186px]">Recent</Th>
              <Th align="right" className="w-[116px]">
                Last run
              </Th>
              <Th align="right" className="w-[104px]">
                Enabled
              </Th>
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
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
            <span className="flex size-9 items-center justify-center rounded-md border border-line-1 bg-bg-2 text-fg-3">
              <Search className="size-4" />
            </span>
            <div className="text-sm font-medium text-foreground">
              No monitors match
            </div>
            <div className="text-[12.5px] text-muted-foreground">
              Try a different search or clear the status filter.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Th({
  children,
  className,
  align = "left",
}: {
  children?: React.ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
  return (
    <TableHead
      className={cn(
        "px-2 text-[10.5px] font-semibold uppercase tracking-[0.5px] text-fg-3",
        align === "right" && "text-right",
        className,
      )}
    >
      {children}
    </TableHead>
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
      <TableCell className="w-[44px] px-2 py-3 text-center align-middle">
        <span className="inline-flex justify-center">
          <MonGlyph size={14} state={status} />
        </span>
      </TableCell>

      <TableCell className="px-2 py-3 align-middle">
        {/* Stretched-link: the TableRow is `relative`, this Link's
         * `after:inset-0` fills it so the whole row is the click target. */}
        <Link
          className="flex min-w-0 flex-col gap-[3px] focus-visible:outline-none after:absolute after:inset-0 after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring"
          href={href}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              className="max-w-[360px] truncate text-[13.5px] text-foreground"
              title={m.name}
            >
              {m.name}
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-bg-3 px-[7px] py-px font-mono text-[10.5px] text-fg-2">
              <BeakerGlyph />
              {m.type}
            </span>
          </span>
          <span className="mt-px">
            <MonBadge size="sm" state={status} />
          </span>
        </Link>
      </TableCell>

      <TableCell className="w-[100px] px-2 py-3 align-middle font-mono text-[12.5px] text-fg-2">
        {humanizeInterval(m.intervalSeconds)}
      </TableCell>

      <TableCell className="w-[186px] px-2 py-3 align-middle">
        <ExecStrip executions={m.recentExecutions} />
      </TableCell>

      <TableCell className="w-[116px] px-2 py-3 text-right align-middle text-[12px] text-fg-2">
        {m.lastRunAt ? (
          formatRelativeTime(m.lastRunAt)
        ) : (
          <span className="text-fg-4">—</span>
        )}
      </TableCell>

      <TableCell className="w-[104px] px-2 py-3 align-middle">
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

/** `beaker` glyph from the design, mapped to a small inline SVG on the same
 * 16-grid stroke set the other monitor visuals use. */
function BeakerGlyph() {
  return (
    <svg
      aria-hidden="true"
      className="size-2.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
    >
      <path d="M6 2.5 V 7 L 3 13 H 13 L 10 7 V 2.5" />
      <path d="M5.5 2.5 H 10.5" />
    </svg>
  );
}
