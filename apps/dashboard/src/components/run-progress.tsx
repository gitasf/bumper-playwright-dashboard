import { ChevronDown, ChevronRight } from "lucide-react";
import { Link } from "@void/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SearchFilterInput } from "@/components/search-filter-input";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/segmented-control";
import { StatusGlyph } from "@/components/status-glyph";
import { TestReplayButton } from "@/components/trace-viewer-dialog";
import { cn } from "@/lib/cn";
import {
  countByStatusGroup,
  groupAndSortTests,
  type GroupByAxis,
  type StatusFilter,
} from "@/lib/group-tests-by-file";
import { statusToken } from "@/lib/status";
import { type RunProgressTest } from "@/realtime/run-progress";
import { useRunRoom } from "@/realtime/use-run-room";
import { formatDuration } from "@/lib/time-format";

interface RunProgressProps {
  /** Run id used as the `void/ws` run-room key (`run:<runId>`). */
  runId: string;
  /** Team slug — used to build test-detail href on row click. */
  teamSlug: string;
  /** Project slug — same as above. */
  projectSlug: string;
  /** SSR-loaded test rows. Forwarded to the hook to seed its accumulator. */
  initialTests?: RunProgressTest[];
  /**
   * `testResultId`s (among `initialTests`) that have a trace artifact → gate the
   * per-row "Test Replay" button. Computed at SSR; a test streamed in live after
   * load won't be listed (the realtime event can't carry it — artifacts register
   * in a later flush), so its button appears only after a reload.
   */
  tracedTestIds?: string[];
}

/**
 * Run-detail Tests tab. Subscribes to live progress events for `run:<runId>`
 * via `useRunRoom` (the `void/ws` run room), merging streaming updates on top of the SSR-loaded
 * `initialTests`. Owns only the per-test list; the aggregate summary (header
 * tiles + OutcomeBar) is rendered live by the separate `<RunSummaryLive>`
 * island, so this component derives every count it shows from its own `byId`
 * accumulator (`statusCounts` below) rather than reading the published summary.
 *
 * Layout mirrors the design bundle's `screen-run-detail.jsx`:
 *   - Sticky filter bar — search input, status SegmentedControl with per-status
 *     counts, Group-by control (File / Playwright project).
 *   - Grouped collapsible list — each group header shows the file path or
 *     project name plus a per-status count summary; click to toggle. Failed /
 *     flaky groups expand by default.
 *   - Each row is a `<Link>` to the test-detail page (whole row clickable).
 *
 * Tags from the design's `TestRow` aren't shown — `RunProgressTest` doesn't
 * carry them today (testTags table is keyed by `testResultId` and not joined
 * into the live progress payload). Easy to add later by extending the wire
 * format if/when it becomes load-bearing.
 */
export function RunProgress({
  runId,
  teamSlug,
  projectSlug,
  initialTests,
  tracedTestIds,
}: RunProgressProps) {
  const { byId } = useRunRoom(runId, { initialTests });
  const tests = useMemo(() => Object.values(byId), [byId]);
  const tracedIds = useMemo(
    () => new Set(tracedTestIds ?? []),
    [tracedTestIds],
  );

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [groupBy, setGroupBy] = useState<GroupByAxis>("file");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [didAutoExpand, setDidAutoExpand] = useState(false);

  // Filter → group → order + 4-bucket counts + default-expanded keys, all from
  // one pure engine so streaming updates re-derive everything in lockstep. The
  // `statusCounts` feed the SegmentedControl labels; `suggestedExpanded` seeds
  // the one-shot auto-expand below.
  const { groups, statusCounts, suggestedExpanded } = useMemo(
    () => groupAndSortTests(tests, { search, statusFilter, groupBy }),
    [tests, search, statusFilter, groupBy],
  );

  // Auto-expand the worst-status groups ONCE. Tracks separately so user
  // toggles after the first interaction stick around. When seeded non-empty
  // (terminal run / reload mid-run) this fires on first render, as before.
  // When seeded EMPTY (live run viewed from the start), don't latch on the
  // first arriving test — a single all-passing group would consume the latch
  // and later failed groups would never auto-expand. Instead wait for the
  // first failed/flaky-bucket test to appear, then expand the worst groups.
  const seededNonEmpty = useRef((initialTests?.length ?? 0) > 0);
  useEffect(() => {
    if (didAutoExpand || groups.length === 0) return;
    const hasBadGroup = statusCounts.failed > 0 || statusCounts.flaky > 0;
    if (!seededNonEmpty.current && !hasBadGroup) return;
    setExpanded(suggestedExpanded);
    setDidAutoExpand(true);
  }, [groups, statusCounts, suggestedExpanded, didAutoExpand]);

  function toggleGroup(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const statusOptions: SegmentedOption<StatusFilter>[] = [
    { value: "all", label: "All", count: tests.length },
    {
      value: "failed",
      label: "Failed",
      count: statusCounts.failed,
      dot: "failed",
    },
    {
      value: "flaky",
      label: "Flaky",
      count: statusCounts.flaky,
      dot: "flaky",
    },
    {
      value: "passed",
      label: "Passed",
      count: statusCounts.passed,
      dot: "passed",
    },
    {
      value: "skipped",
      label: "Skipped",
      count: statusCounts.skipped,
      dot: "skipped",
    },
  ];

  return (
    /* Filter bar is sticky relative to the page-level scroller in
     * `pages/.../runs/[runId]/index.tsx`. `top-[84px]` clears the sticky H1
     * row (52px) plus the sticky tab bar (~32px) so the filter controls
     * sit just below them rather than overlapping. */
    <div className="flex flex-col">
      <div className="sticky top-[84px] z-10 flex flex-wrap items-center gap-2 border-b border-line-1 bg-background px-6 py-2.5">
        <SearchFilterInput
          aria-label="Filter tests"
          className="w-[260px]"
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter tests…"
          value={search}
        />

        <SegmentedControl
          onChange={setStatusFilter}
          options={statusOptions}
          value={statusFilter}
        />

        <div className="flex-1" />

        <span className="text-[12px] text-fg-3">Group by</span>
        <SegmentedControl
          compact
          onChange={setGroupBy}
          options={[
            { value: "file", label: "File" },
            { value: "project", label: "Playwright project" },
          ]}
          value={groupBy}
        />
      </div>

      <div>
        {groups.length === 0 ? (
          <div className="px-6 py-10 text-center text-[12.5px] text-muted-foreground">
            {tests.length === 0
              ? "No tests recorded for this run."
              : "No tests match the current filters."}
          </div>
        ) : (
          groups.map(([key, items]) => (
            <TestGroup
              groupBy={groupBy}
              groupKey={key}
              key={key}
              onToggle={() => toggleGroup(key)}
              open={expanded.has(key)}
              projectSlug={projectSlug}
              runId={runId}
              teamSlug={teamSlug}
              tests={items}
              tracedIds={tracedIds}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TestGroup({
  groupKey,
  groupBy,
  tests,
  open,
  onToggle,
  teamSlug,
  projectSlug,
  runId,
  tracedIds,
}: {
  groupKey: string;
  groupBy: GroupByAxis;
  tests: RunProgressTest[];
  open: boolean;
  onToggle: () => void;
  teamSlug: string;
  projectSlug: string;
  runId: string;
  tracedIds: ReadonlySet<string>;
}) {
  const counts = useMemo(() => countByStatusGroup(tests), [tests]);

  return (
    <div className="border-b border-line-1">
      <button
        className="flex w-full items-center gap-2 px-6 py-2 text-left hover:bg-bg-1"
        onClick={onToggle}
        type="button"
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0 text-fg-3" strokeWidth={2} />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-fg-3" strokeWidth={2} />
        )}
        {groupBy === "file" ? (
          <span className="min-w-0 truncate font-mono text-[12.5px] text-foreground">
            {groupKey}
          </span>
        ) : (
          <span className="truncate text-[13px] font-medium text-foreground">
            {groupKey}
          </span>
        )}
        <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-fg-3">
          {tests.length}
        </span>
        <div className="flex-1" />
        <div className="flex shrink-0 items-center gap-2.5 font-mono text-[11px] tabular-nums">
          {counts.failed > 0 ? (
            <span style={{ color: statusToken("failed") }}>
              {counts.failed}f
            </span>
          ) : null}
          {counts.flaky > 0 ? (
            <span style={{ color: statusToken("flaky") }}>{counts.flaky}~</span>
          ) : null}
          {counts.skipped > 0 ? (
            <span style={{ color: statusToken("skipped") }}>
              {counts.skipped}s
            </span>
          ) : null}
          <span style={{ color: statusToken("passed") }}>{counts.passed}p</span>
        </div>
      </button>

      {open ? (
        <div>
          {/* Rows arrive pre-sorted worst-status-first from `groupAndSortTests`. */}
          {tests.map((t) => (
            <TestRow
              key={t.id}
              hasTrace={tracedIds.has(t.id)}
              projectSlug={projectSlug}
              runId={runId}
              teamSlug={teamSlug}
              test={t}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TestRow({
  test,
  teamSlug,
  projectSlug,
  runId,
  hasTrace,
}: {
  test: RunProgressTest;
  teamSlug: string;
  projectSlug: string;
  runId: string;
  /** Show the inline "Test Replay" button — set when the test has a trace. */
  hasTrace: boolean;
}) {
  const href = `/t/${teamSlug}/p/${projectSlug}/runs/${runId}/tests/${test.id}?attempt=0`;
  // Strip the file-path prefix that the reporter sometimes bakes into the
  // stored title (`tests/foo.spec.ts > describe > test`). Display the rest.
  let displayTitle = test.title;
  if (test.file) {
    const prefix = `${test.file} > `;
    if (displayTitle.startsWith(prefix))
      displayTitle = displayTitle.slice(prefix.length);
  }

  // The row is a <Link>, so the Test Replay button (which opens a dialog) lives
  // as a sibling rather than nested inside the anchor.
  return (
    <div
      className={cn(
        "group flex w-full items-center gap-1 py-1.5 pl-[50px] pr-6",
        "min-h-8 text-left text-foreground hover:bg-bg-1",
      )}
    >
      <Link
        className="flex min-w-0 flex-1 items-center gap-1 text-left text-foreground"
        href={href}
      >
        <span className="flex w-[18px] shrink-0 items-center justify-center">
          <StatusGlyph size={12} status={test.status} />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
          <span className="min-w-0 truncate text-[12.5px]">{displayTitle}</span>
          {test.retryCount > 0 ? (
            <span
              className="shrink-0 font-mono text-[10.5px]"
              style={{ color: statusToken("flaky") }}
            >
              ×{test.retryCount + 1}
            </span>
          ) : null}
        </div>
        <span className="w-[60px] shrink-0 px-2 font-mono text-[11px] capitalize text-fg-3">
          {test.projectName ?? ""}
        </span>
        <span className="w-[70px] shrink-0 px-2 text-right font-mono text-[12px] tabular-nums text-fg-3">
          {formatDuration(test.durationMs)}
        </span>
      </Link>
      {hasTrace ? (
        <TestReplayButton
          teamSlug={teamSlug}
          projectSlug={projectSlug}
          runId={runId}
          testResultId={test.id}
          title={displayTitle}
        />
      ) : null}
      {/*
       * Decorative hover affordance only — the primary row <Link> above already
       * navigates to the test. Keep this a non-interactive <span> (not a second
       * <Link> to the same href): a duplicate anchor adds a redundant
       * screen-reader link and lets the SPA schedule two competing navigations
       * (which bounced the test-detail nav back to the run page). aria-hidden so
       * AT ignores the redundant chevron.
       */}
      <span
        aria-hidden="true"
        className="flex w-5 shrink-0 items-center justify-center px-1 text-center text-fg-3 opacity-0 group-hover:opacity-100"
      >
        <ChevronRight className="size-3" strokeWidth={2} />
      </span>
    </div>
  );
}
