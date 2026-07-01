import { Link } from "@void/react";
import type React from "react";
import { useMemo } from "react";
import { ActorAvatar } from "@/components/actor-avatar";
import { DetailHeaderBar, HeaderCrumbs } from "@/components/page-header";
import { RunHistoryBranchFilter } from "@/components/run-history-branch-filter";
import { ALL_BRANCHES } from "@/components/run-history-branch-filter.shared";
import {
  RunHistoryChart,
  type RunHistoryPoint,
} from "@/components/run-history-chart";
import {
  RunDurationLive,
  RunStatusGlyphLive,
  RunTestCountLive,
} from "@/components/run-detail-live";
import {
  BranchPill,
  CommitPill,
  EnvPill,
  PrPill,
} from "@/components/run-meta-pills";
import { RunProgress } from "@/components/run-progress";
import { RunSummaryLive } from "@/components/run-summary-live";
import { cn } from "@/lib/cn";
import { makeHrefBuilder } from "@/lib/page-links";
import { branchUrl, commitUrl, prUrl } from "@/lib/pr-url";
import { formatDuration, formatRelativeTime } from "@/lib/time-format";
import type { Props } from "./index.server";

const TAB_KEYS = ["tests", "env"] as const;
type TabKey = (typeof TAB_KEYS)[number];

const TAB_LABEL: Record<TabKey, string> = {
  tests: "Tests",
  env: "Environment",
};

/**
 * Run detail page. Layout mirrors the Wrightful design bundle's
 * `RunDetailScreen` (see `screen-run-detail.jsx`):
 *
 *   - One tight header block: status glyph + #N + commit title + duration/time,
 *     chip row with branch/PR/env/actor/commit + summary stats, OutcomeBar,
 *     duration-trend bar chart of the last N runs on this branch.
 *   - Tab pills (Tests / Environment) below the header.
 *   - Tests tab: live test list via `<RunProgress>`.
 *   - Environment tab: build metadata (Playwright/Reporter/CI/Browsers).
 *
 * Tab state lives in the URL (`?tab=tests|env`) — keeps the page RSC, makes
 * deep links to a specific tab work, and avoids hydrating a client island
 * just for two buttons.
 */
export default function RunDetailPage({
  project,
  run,
  runId,
  history,
  branches,
  branchParam,
  defaultBranch,
  effectiveBranch,
  tab,
  pathname,
  tests,
  tracedTestIds,
}: Props) {
  const base = `/t/${project.teamSlug}/p/${project.slug}`;
  const shortId = run.id.slice(-7);
  const prHref = prUrl(run.ciProvider, run.repo, run.prNumber);
  const branchHref = branchUrl(run.ciProvider, run.repo, run.branch);
  const commitHref = commitUrl(run.ciProvider, run.repo, run.commitSha);

  const chronological = [...history].reverse();
  const hrefQuery = branchParam
    ? `?branch=${encodeURIComponent(branchParam)}`
    : "";
  const historyPoints: RunHistoryPoint[] = chronological.map((h) => ({
    id: h.id,
    durationMs: h.durationMs,
    status: h.status,
    current: h.id === runId,
    href: h.id === runId ? undefined : `${base}/runs/${h.id}${hrefQuery}`,
    hover:
      h.id === runId
        ? undefined
        : {
            kind: "run" as const,
            teamSlug: project.teamSlug,
            projectSlug: project.slug,
            runId: h.id,
          },
    label: [
      h.status,
      formatDuration(h.durationMs),
      formatRelativeTime(h.createdAt),
      h.commitSha ? h.commitSha.slice(0, 7) : null,
    ]
      .filter(Boolean)
      .join(" · "),
  }));

  // Memoized on the `run` loader prop so the object identity is stable across
  // re-renders and only changes per navigation — `useRunRoom`'s render-time
  // reseed keys on this reference, so a fresh identity must mean fresh data.
  const initialSummary = useMemo(
    () => ({
      totalTests: run.totalTests,
      passed: run.passed,
      failed: run.failed,
      flaky: run.flaky,
      skipped: run.skipped,
      durationMs: run.durationMs,
      status: run.status,
      completedAt: run.completedAt,
    }),
    [run],
  );

  const { with: hrefWith } = makeHrefBuilder(pathname, {
    branch: branchParam,
  });
  const tabHref = (next: TabKey): string =>
    hrefWith({ tab: next === "tests" ? null : next });

  return (
    <>
      {/* Single page-level scroller. The H1 row + tab bar are sticky inside this
       * container; everything else (chips, OutcomeBar, RunHistoryChart, tab
       * content) participates in the same scroll, so users can drag the whole
       * page and only the H1 + tabs stay anchored at the top. */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Sticky H1 row — fixed 52px height so the tab bar below can pin to a
         * matching `top-[52px]` with zero gap. Padding-based heights aren't
         * deterministic enough (text metrics + border can drift a couple px). */}
        <DetailHeaderBar className="sticky top-0 z-30 border-b border-border bg-background">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <HeaderCrumbs items={[{ label: "Runs", href: base }]} />
            <h1
              className="flex min-w-0 flex-1 items-center gap-2 text-[17px] font-semibold tracking-[-0.2px]"
              title={run.commitMessage ?? run.id}
            >
              <span className="min-w-0 truncate">
                {run.commitMessage ?? (
                  <span className="italic text-muted-foreground">
                    No message
                  </span>
                )}
              </span>
              <RunStatusGlyphLive
                initialSummary={initialSummary}
                runId={runId}
                size={18}
              />
            </h1>
            <div className="flex shrink-0 items-center gap-3 text-[12px] text-muted-foreground">
              <span className="font-mono text-[13px] tabular-nums">
                #{shortId}
              </span>
              <RunDurationLive
                createdAt={run.createdAt}
                initialSummary={initialSummary}
                runId={runId}
              />
              <span className="text-fg-4">·</span>
              <span>{formatRelativeTime(run.createdAt)}</span>
            </div>
          </div>
        </DetailHeaderBar>

        {/* Scrolling header — chips + summary, OutcomeBar, duration trend */}
        <div className="border-b border-border px-6 pt-3 pb-[18px]">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11.5px]">
            {run.branch ? (
              <BranchPill
                className="max-w-[220px]"
                href={branchHref}
                name={run.branch}
              />
            ) : null}
            {run.prNumber != null ? (
              <PrPill href={prHref} num={run.prNumber} />
            ) : null}
            {run.environment ? <EnvPill env={run.environment} /> : null}
            {run.actor ? (
              <span className="inline-flex shrink-0 items-center gap-1.5 text-fg-2">
                <ActorAvatar actor={run.actor} size={14} />
                <span>{run.actor}</span>
              </span>
            ) : null}
            {run.commitSha ? (
              <CommitPill href={commitHref} marker="icon" sha={run.commitSha} />
            ) : null}
          </div>

          {/* Live summary tiles + OutcomeBar. Seeded from SSR `run.*`, then driven
           * by the published `RunProgressEvent.summary` so the header counters
           * track streaming results (and run completion) without a reload —
           * `"use client"` stays at this leaf, not the page root. */}
          <div className="mt-2.5">
            <RunSummaryLive initialSummary={initialSummary} runId={runId} />
          </div>

          <div className="mt-4">
            <RunHistoryChart
              emptyState={
                effectiveBranch === ALL_BRANCHES
                  ? "No run history yet."
                  : `No run history on ${effectiveBranch} yet.`
              }
              points={historyPoints}
              subtitle={
                <RunHistoryBranchFilter
                  branches={branches}
                  defaultValue={defaultBranch}
                />
              }
              title={`Duration · last ${historyPoints.length} run${historyPoints.length === 1 ? "" : "s"}`}
            />
          </div>
        </div>

        {/* Sticky tab bar — `top-[52px]` matches the fixed H1 row height so
         * the two sticky bands butt up against each other with no gap and no
         * overlap. */}
        <div className="sticky top-[52px] z-20 flex items-end gap-1 border-b border-line-1 bg-background px-6">
          {TAB_KEYS.map((key) => (
            <Link
              className={cn(
                "relative -mb-px px-3 py-2 text-[13px] transition-colors",
                tab === key
                  ? "text-foreground font-medium after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-[var(--running)] after:content-['']"
                  : "text-muted-foreground hover:text-foreground",
              )}
              href={tabHref(key)}
              key={key}
            >
              {TAB_LABEL[key]}
              {key === "tests" ? (
                <span className="ml-1.5 font-mono text-[11px] tabular-nums text-fg-3">
                  <RunTestCountLive
                    initialSummary={initialSummary}
                    runId={runId}
                  />
                </span>
              ) : null}
            </Link>
          ))}
          <div className="flex-1" />
          {/* Compare affordance (roadmap 2.4): diff this run against a baseline
           * (most recent passing run on the same branch). Sits at the trailing
           * edge of the tab bar so it doesn't shift the tab pills. */}
          <Link
            aria-label="Compare this run against a baseline"
            className="-mb-px py-2 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
            href={`${base}/runs/${runId}/diff`}
          >
            Compare <span aria-hidden="true">↗</span>
          </Link>
        </div>

        {/* Tab content — scrolls with the rest of the page */}
        {tab === "tests" ? (
          <RunProgress
            initialTests={tests}
            projectSlug={project.slug}
            runId={runId}
            teamSlug={project.teamSlug}
            tracedTestIds={tracedTestIds}
          />
        ) : (
          <EnvironmentTab run={run} />
        )}
      </div>
    </>
  );
}

function EnvironmentTab({ run }: { run: Props["run"] }): React.ReactElement {
  const rows: { label: string; value: React.ReactNode; mono?: boolean }[] = [
    { label: "Run ID", value: run.id, mono: true },
    { label: "Branch", value: run.branch ?? "—", mono: !!run.branch },
    { label: "Commit", value: run.commitSha ?? "—", mono: !!run.commitSha },
    {
      label: "PR",
      value: run.prNumber != null ? `#${run.prNumber}` : "—",
    },
    { label: "Actor", value: run.actor ? `@${run.actor}` : "—" },
    { label: "Environment", value: run.environment ?? "—" },
    {
      label: "Playwright",
      value: run.playwrightVersion ? `v${run.playwrightVersion}` : "—",
      mono: !!run.playwrightVersion,
    },
    {
      label: "Reporter",
      value: run.reporterVersion ? `v${run.reporterVersion}` : "—",
      mono: !!run.reporterVersion,
    },
    { label: "CI provider", value: run.ciProvider ?? "—" },
    { label: "Build", value: run.ciBuildId ?? "—", mono: !!run.ciBuildId },
    {
      label: "Started at",
      value: new Date(run.createdAt * 1000).toISOString(),
      mono: true,
    },
    {
      label: "Duration",
      value: run.durationMs ? formatDuration(run.durationMs) : "—",
      mono: !!run.durationMs,
    },
  ];

  return (
    <div className="p-6">
      <div className="max-w-[720px] overflow-hidden rounded-[8px] border border-line-1 bg-card">
        {rows.map((r, i) => (
          <div
            className={cn(
              "flex items-center px-4 py-2.5 text-[13px]",
              i !== rows.length - 1 && "border-b border-line-1",
            )}
            key={r.label}
          >
            <span className="w-[140px] shrink-0 text-fg-3">{r.label}</span>
            <span
              className={cn(
                "min-w-0 truncate text-foreground",
                r.mono && "font-mono",
              )}
            >
              {r.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
