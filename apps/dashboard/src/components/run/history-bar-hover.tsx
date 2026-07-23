import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, GitCommit, Repeat, TriangleAlert, User, X } from "lucide-react";
import type React from "react";
import { useCallback } from "react";
import { fetch } from "void/client";
import { Link } from "@void/react";
import { ChartColumnTooltip } from "@/components/analytics/chart-tooltip";
import { StatusPill } from "@/components/status-pill";
import { cn } from "@/lib/cn";
import type { RunSummaryResponse } from "@/lib/api-response-types";
import type { TestResultSummaryResponse } from "@/lib/api-response-types";
import { firstLine } from "@/lib/text";
import { statusCssVar } from "@/lib/status";
import { formatDuration, formatRelativeTime } from "@/lib/time-format";

type HoverTarget =
  | { kind: "run"; teamSlug: string; projectSlug: string; runId: string }
  | {
      kind: "testResult";
      teamSlug: string;
      projectSlug: string;
      runId: string;
      testResultId: string;
    };

type Props = HoverTarget & {
  href?: string;
  /** Applied to the trigger `<a>` so it fills the hitbox slot. Without this
   * the anchor collapses to zero size and the tooltip anchors to the slot's
   * top-left corner. */
  className?: string;
  "aria-label"?: string;
  /** Adjacent bars' targets, warmed alongside this one on hover so sweeping to
   * a neighbour opens with data already resolved (`undefined` entries — e.g. the
   * strip's ends — are skipped). */
  neighbors?: (HoverTarget | undefined)[];
};

type SummaryResult =
  | { kind: "run"; data: RunSummaryResponse }
  | { kind: "testResult"; data: TestResultSummaryResponse };

async function fetchSummary(target: HoverTarget): Promise<SummaryResult> {
  if (target.kind === "run") {
    const data = await fetch(
      "/api/t/:teamSlug/p/:projectSlug/runs/:runId/summary",
      {
        params: {
          teamSlug: target.teamSlug,
          projectSlug: target.projectSlug,
          runId: target.runId,
        },
      },
    );
    return { kind: "run", data };
  }
  const data = await fetch(
    "/api/t/:teamSlug/p/:projectSlug/runs/:runId/tests/:testResultId/summary",
    {
      params: {
        teamSlug: target.teamSlug,
        projectSlug: target.projectSlug,
        runId: target.runId,
        testResultId: target.testResultId,
      },
    },
  );
  return { kind: "testResult", data };
}

function summaryQueryKey(target: HoverTarget) {
  return target.kind === "run"
    ? ([
        "run-summary",
        target.teamSlug,
        target.projectSlug,
        target.runId,
      ] as const)
    : ([
        "test-result-summary",
        target.teamSlug,
        target.projectSlug,
        target.runId,
        target.testResultId,
      ] as const);
}

/**
 * Single source of truth for a bar's summary query, shared by the hover
 * prefetch and the payload's `useQuery`. Prefetch only warms the entry the
 * popup then reads if the two agree on key/fn/staleTime — one factory keeps
 * them from drifting apart.
 */
function summaryQuery(target: HoverTarget) {
  return {
    queryKey: summaryQueryKey(target),
    queryFn: () => fetchSummary(target),
    staleTime: 60_000,
  };
}

/**
 * A run-history bar's hover trigger, wired to the chart's shared, gliding
 * {@link ChartColumnTooltip} — same tooltip chrome and sweep behaviour as the
 * analytics charts, just with rich async content ({@link RunHistoryBarSummary})
 * as the payload. With an `href` the trigger is a `<Link>` (the bar navigates on
 * click); without one — the currently-viewed run/test bar — it's a focusable
 * `<span>` that still shows its summary on hover/focus but doesn't self-link.
 * Prefetches this bar AND its `neighbors` on `pointerenter`/`focus`, so the
 * popup usually opens with data resolved and sweeping to an adjacent bar stays
 * instant; if a fetch is still in flight, the payload shows its own skeleton.
 * Must be rendered inside a `ChartTooltipProvider`.
 */
export function RunHistoryBarTrigger(props: Props): React.ReactElement {
  const {
    href,
    className,
    "aria-label": ariaLabel,
    neighbors,
    ...target
  } = props;
  const queryClient = useQueryClient();
  const prefetch = useCallback(() => {
    for (const t of [target, ...(neighbors ?? [])]) {
      if (!t) continue;
      void queryClient.prefetchQuery(summaryQuery(t));
    }
  }, [queryClient, target, neighbors]);

  return (
    <ChartColumnTooltip
      tooltip={<RunHistoryBarSummary {...target} />}
      render={
        href ? (
          <Link
            href={href}
            aria-label={ariaLabel}
            className={className}
            onFocus={prefetch}
            onPointerEnter={prefetch}
          />
        ) : (
          <span
            aria-label={ariaLabel}
            className={className}
            onFocus={prefetch}
            onPointerEnter={prefetch}
            role="img"
            tabIndex={0}
          />
        )
      }
    />
  );
}

/**
 * Tooltip payload for a single bar. Only mounts when its column is the active
 * trigger (the shared popup renders one payload at a time), so the query fires
 * on hover; TanStack caches by key, so re-hovering is instant.
 */
function RunHistoryBarSummary(target: HoverTarget): React.ReactElement {
  const { data, isError, refetch } = useQuery(summaryQuery(target));

  return (
    <div className="flex flex-col gap-3">
      {isError ? (
        <div className="py-2 text-center text-sm text-fg-3">
          <p>Couldn't load summary.</p>
          <button
            type="button"
            className="mt-1 font-mono text-micro underline underline-offset-2 hover:text-fg-1"
            onClick={() => void refetch()}
          >
            Retry
          </button>
        </div>
      ) : !data ? (
        // Kind-specific skeleton mirrors the real body's row structure/heights
        // so the shared, gliding popup doesn't resize when data swaps in. The
        // chart is single-kind, so the skeleton always matches the body it
        // precedes.
        target.kind === "run" ? (
          <RunSummarySkeleton />
        ) : (
          <TestResultSummarySkeleton />
        )
      ) : data.kind === "run" ? (
        <RunSummaryBody summary={data.data} />
      ) : (
        <TestResultSummaryBody summary={data.data} />
      )}
    </div>
  );
}

/**
 * A shimmer bar that occupies exactly one text line box. The `--text-*` tokens
 * carry no paired line-height, so a fixed-px bar drifts a pixel or two from the
 * real text; instead the bar takes the SAME font-size/leading class as the text
 * it stands in for (`text`) plus a zero-width space to force a line box, so its
 * height is derived from identical CSS and matches to the pixel — no shift when
 * the summary swaps in. `w` sets the bar width.
 *
 * Tinted `bg-fg-4/…` (not `bg-muted`): in dark mode `--muted` resolves to the
 * same `--bg-2` as the tooltip surface, so a muted shimmer is invisible against
 * the popup. A foreground tint contrasts on the popup in both themes.
 */
function SkelLine({ w, text }: { w: string; text?: string }) {
  return (
    <div className={cn("animate-pulse rounded-sm bg-fg-4/20", w, text)}>
      {"\u200B"}
    </div>
  );
}

/** Shimmer sized like a `StatusPill` (sm): `text-micro` + `px-1.5 py-0.5`. */
function SkelPill({ w }: { w: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-sm bg-fg-4/20 px-1.5 py-0.5 text-micro",
        w,
      )}
    >
      {"\u200B"}
    </div>
  );
}

/** Mirrors {@link RunSummaryBody}: status/counts row, title + meta, commit footer. */
function RunSummarySkeleton() {
  return (
    <>
      <div className="flex items-center gap-2">
        <SkelPill w="w-16" />
        <SkelLine text="text-micro" w="w-20" />
      </div>
      <div>
        <SkelLine text="text-sm leading-snug" w="w-3/4" />
        <SkelLine text="mt-1 text-micro" w="w-1/2" />
      </div>
      <div className="border-t border-line-1 pt-2">
        <SkelLine text="text-micro" w="w-2/3" />
      </div>
    </>
  );
}

/** Mirrors {@link TestResultSummaryBody}: status row, title + file + duration, commit footer. */
function TestResultSummarySkeleton() {
  return (
    <>
      <div className="flex items-center gap-2">
        <SkelPill w="w-16" />
      </div>
      <div>
        <SkelLine text="text-sm leading-snug" w="w-3/4" />
        <SkelLine text="mt-1 text-micro" w="w-2/3" />
        <SkelLine text="mt-1 text-micro" w="w-1/2" />
      </div>
      <div className="flex flex-col gap-1 border-t border-line-1 pt-2">
        <SkelLine text="text-micro" w="w-3/4" />
        <SkelLine text="text-micro" w="w-1/2" />
      </div>
    </>
  );
}

function RunSummaryBody({ summary }: { summary: RunSummaryResponse }) {
  const shortId = summary.id.slice(-7);
  const title = firstLine(summary.commitMessage) ?? `Run #${shortId}`;
  const completed = summary.completedAt ?? summary.createdAt;

  return (
    <>
      <div className="flex items-center gap-2">
        <StatusChip status={summary.status} label={`#${shortId}`} />
        <div className="flex items-center gap-2 font-mono text-micro text-fg-3">
          <span className="inline-flex items-center gap-0.5 text-success">
            <Check size={10} strokeWidth={3} />
            {summary.passed}
          </span>
          <span className="inline-flex items-center gap-0.5 text-destructive">
            <X size={10} strokeWidth={3} />
            {summary.failed}
          </span>
          {summary.flaky > 0 && (
            <span className="inline-flex items-center gap-0.5 text-warning">
              <TriangleAlert size={10} strokeWidth={2.5} />
              {summary.flaky}
            </span>
          )}
        </div>
      </div>
      <TitleAndMeta
        title={title}
        actor={summary.actor}
        durationMs={summary.durationMs}
        timestamp={completed}
      />
      <CommitFooter commitSha={summary.commitSha} branch={summary.branch} />
    </>
  );
}

function TestResultSummaryBody({
  summary,
}: {
  summary: TestResultSummaryResponse;
}) {
  const runShortId = summary.runId.slice(-7);
  const commitTitle = firstLine(summary.commitMessage);

  return (
    <>
      <div className="flex items-center gap-2">
        <StatusChip status={summary.status} label={`#${runShortId}`} />
        {summary.retryCount > 0 && (
          <span className="inline-flex items-center gap-0.5 font-mono text-micro text-warning">
            <Repeat size={10} strokeWidth={2.5} />
            {summary.retryCount}
          </span>
        )}
      </div>
      <div>
        <div className="truncate text-sm font-medium leading-snug">
          {summary.title}
        </div>
        <div className="mt-1 font-mono text-micro text-fg-3 truncate">
          {summary.projectName ? `${summary.projectName} · ` : ""}
          {summary.file}
        </div>
        <div className="mt-1 font-mono text-micro text-fg-3">
          {formatDuration(summary.durationMs)} (
          {formatRelativeTime(summary.createdAt)})
        </div>
      </div>
      {(summary.commitSha || commitTitle) && (
        <div className="flex flex-col gap-1 border-t border-line-1 pt-2">
          {commitTitle && (
            <div className="line-clamp-1 font-mono text-micro text-fg-3">
              {commitTitle}
            </div>
          )}
          <div className="flex items-center gap-1.5 font-mono text-micro text-fg-3">
            {summary.commitSha && (
              <>
                <GitCommit size={11} />
                <span>{summary.commitSha.slice(0, 7)}</span>
              </>
            )}
            {summary.branch && (
              <>
                {summary.commitSha && <span className="opacity-50">·</span>}
                <span className="truncate">{summary.branch}</span>
              </>
            )}
            {summary.actor && (
              <>
                <span className="opacity-50">·</span>
                <User size={10} />
                <span className="truncate">{summary.actor}</span>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function TitleAndMeta({
  title,
  actor,
  durationMs,
  timestamp,
}: {
  title: string;
  actor: string | null;
  durationMs: number;
  timestamp: number;
}) {
  return (
    <div>
      <div className="truncate text-sm font-medium leading-snug">{title}</div>
      <div className="mt-1 flex items-center gap-2 font-mono text-micro text-fg-3">
        {actor && (
          <span className="inline-flex items-center gap-1">
            <User size={10} />
            <span className="truncate max-w-32">{actor}</span>
          </span>
        )}
        <span>·</span>
        <span>
          {formatDuration(durationMs)} ({formatRelativeTime(timestamp)})
        </span>
      </div>
    </div>
  );
}

function CommitFooter({
  commitSha,
  branch,
}: {
  commitSha: string | null;
  branch: string | null;
}) {
  if (!commitSha) return null;
  return (
    <div className="flex items-center gap-1.5 border-t border-line-1 pt-2 font-mono text-micro text-fg-3">
      <GitCommit size={11} />
      <span>{commitSha.slice(0, 7)}</span>
      {branch && (
        <>
          <span className="opacity-50">·</span>
          <span className="truncate">{branch}</span>
        </>
      )}
    </div>
  );
}

function StatusChip({ status, label }: { status: string; label: string }) {
  return (
    <StatusPill
      className="font-mono"
      cssVar={statusCssVar(status)}
      label={label}
      size="sm"
    />
  );
}
