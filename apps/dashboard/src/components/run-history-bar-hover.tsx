import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, GitCommit, Repeat, TriangleAlert, User, X } from "lucide-react";
import type React from "react";
import { useCallback, useState } from "react";
import { fetch } from "void/client";
import { Link } from "@void/react";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import type { RunSummaryResponse } from "@/lib/api-response-types";
import type { TestResultSummaryResponse } from "@/lib/api-response-types";
import { cn } from "@/lib/cn";
import { firstLine } from "@/lib/text";
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
   * the anchor collapses to zero size and the popover anchors to the slot's
   * top-left corner. */
  className?: string;
  "aria-label"?: string;
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

/**
 * Wraps a bar-shaped trigger in a hover-activated Popover that fetches the
 * summary on first hover via TanStack Query. Prefetches on `pointerenter`
 * so the popup usually opens with data already resolved.
 */
export function RunHistoryBarHoverCard(props: Props): React.ReactElement {
  const { href, className, "aria-label": ariaLabel, ...target } = props;
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const queryKey =
    target.kind === "run"
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
  const prefetch = useCallback(() => {
    void queryClient.prefetchQuery({
      queryKey,
      queryFn: () => fetchSummary(target),
      staleTime: 60_000,
    });
  }, [queryClient, queryKey, target]);

  const { data, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => fetchSummary(target),
    enabled: isOpen,
    staleTime: 60_000,
  });

  return (
    <Popover onOpenChange={setIsOpen}>
      <PopoverTrigger
        render={
          <Link
            href={href ?? "#"}
            aria-label={ariaLabel}
            className={className}
            onPointerEnter={prefetch}
            onFocus={prefetch}
          />
        }
        openOnHover
        delay={0}
      />
      <PopoverPopup
        align="center"
        side="bottom"
        className="w-80 p-0 transition-none data-starting-style:scale-100 data-starting-style:opacity-100 data-ending-style:scale-100 data-ending-style:opacity-100"
      >
        <div className="flex flex-col gap-3 px-4 py-3">
          {isError ? (
            <div className="py-2 text-center text-sm text-muted-foreground">
              <p>Couldn't load summary.</p>
              <button
                type="button"
                className="mt-1 font-mono text-[11px] underline hover:text-foreground"
                onClick={() => void refetch()}
              >
                Retry
              </button>
            </div>
          ) : !data ? (
            <SummarySkeleton />
          ) : data.kind === "run" ? (
            <RunSummaryBody summary={data.data} />
          ) : (
            <TestResultSummaryBody summary={data.data} />
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function SummarySkeleton() {
  return (
    <div className="space-y-2">
      <div className="h-4 w-1/2 animate-pulse rounded-sm bg-muted" />
      <div className="h-3 w-3/4 animate-pulse rounded-sm bg-muted/60" />
      <div className="h-3 w-2/3 animate-pulse rounded-sm bg-muted/60" />
    </div>
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
        <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
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
          <span className="inline-flex items-center gap-0.5 font-mono text-[11px] text-warning">
            <Repeat size={10} strokeWidth={2.5} />
            {summary.retryCount}
          </span>
        )}
      </div>
      <div>
        <div className="line-clamp-2 text-sm font-medium leading-snug">
          {summary.title}
        </div>
        <div className="mt-1 font-mono text-[11px] text-muted-foreground truncate">
          {summary.projectName ? `${summary.projectName} · ` : ""}
          {summary.file}
        </div>
        <div className="mt-1 font-mono text-[11px] text-muted-foreground">
          {formatDuration(summary.durationMs)} (
          {formatRelativeTime(summary.createdAt)})
        </div>
      </div>
      {(summary.commitSha || commitTitle) && (
        <div className="flex flex-col gap-1 border-t border-border pt-2">
          {commitTitle && (
            <div className="line-clamp-1 font-mono text-[11px] text-muted-foreground">
              {commitTitle}
            </div>
          )}
          <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
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
      <div className="line-clamp-2 text-sm font-medium leading-snug">
        {title}
      </div>
      <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
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
    <div className="flex items-center gap-1.5 border-t border-border pt-2 font-mono text-[11px] text-muted-foreground">
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
  // Text colour is the status token itself (`text-success` etc.), not the
  // `*-foreground` contrast-on-solid pair — the chip background is a 12% tint,
  // so the solid-fill foreground would be near-invisible on it.
  const tone =
    status === "passed"
      ? "bg-success/12 text-success border-success/24"
      : status === "failed" || status === "timedout"
        ? "bg-destructive/12 text-destructive border-destructive/24"
        : status === "flaky"
          ? "bg-warning/12 text-warning border-warning/24"
          : "bg-muted text-muted-foreground border-border";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[11px] font-semibold",
        tone,
      )}
    >
      {label}
    </span>
  );
}
