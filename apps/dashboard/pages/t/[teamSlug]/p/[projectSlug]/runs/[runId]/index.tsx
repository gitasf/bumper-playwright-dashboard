import { GitBranch, GitCommit, GitPullRequest } from "lucide-react";
import { Link } from "@void/react";
import type React from "react";
import { ActorAvatar } from "@/components/actor-avatar";
import { RunHistoryBranchFilter } from "@/components/run-history-branch-filter";
import { ALL_BRANCHES } from "@/components/run-history-branch-filter.shared";
import {
  RunHistoryChart,
  type RunHistoryPoint,
} from "@/components/run-history-chart";
import { RunProgress } from "@/components/run-progress";
import { RunSummaryLive } from "@/components/run-summary-live";
import { StatusGlyph } from "@/components/status-glyph";
import { cn } from "@/lib/cn";
import { makeHrefBuilder } from "@/lib/page-links";
import { prUrl } from "@/lib/pr-url";
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
}: Props) {
  const base = `/t/${project.teamSlug}/p/${project.slug}`;
  const shortId = run.id.slice(-7);
  const prHref = prUrl(run.ciProvider, run.repo, run.prNumber);
  const branchHref =
    run.ciProvider && run.repo && run.branch
      ? branchHrefFor(run.ciProvider, run.repo, run.branch)
      : null;
  const commitHref =
    run.ciProvider && run.repo && run.commitSha
      ? commitHrefFor(run.ciProvider, run.repo, run.commitSha)
      : null;

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

  const initialSummary = {
    totalTests: run.totalTests,
    passed: run.passed,
    failed: run.failed,
    flaky: run.flaky,
    skipped: run.skipped,
    durationMs: run.durationMs,
    status: run.status,
    completedAt: run.completedAt,
  };

  const { with: hrefWith } = makeHrefBuilder(pathname, {
    branch: branchParam,
  });
  const tabHref = (next: TabKey): string =>
    hrefWith({ tab: next === "tests" ? null : next });

  return (
    /* Single page-level scroller. The H1 row + tab bar are sticky inside this
     * container; everything else (chips, OutcomeBar, RunHistoryChart, tab
     * content) participates in the same scroll, so users can drag the whole
     * page and only the H1 + tabs stay anchored at the top. */
    <div className="flex-1 overflow-y-auto min-h-0">
      {/* Sticky H1 row — fixed 52px height so the tab bar below can pin to a
       * matching `top-[52px]` with zero gap. Padding-based heights aren't
       * deterministic enough (text metrics + border can drift a couple px). */}
      <div className="sticky top-0 z-30 flex h-[52px] items-center border-b border-border bg-background px-6">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <StatusGlyph size={18} status={run.status} />
          <span className="shrink-0 font-mono text-[13px] tabular-nums text-muted-foreground">
            #{shortId}
          </span>
          <h1
            className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-[-0.2px]"
            title={run.commitMessage ?? run.id}
          >
            {run.commitMessage ?? (
              <span className="italic text-muted-foreground">No message</span>
            )}
          </h1>
          <div className="flex shrink-0 items-center gap-3 text-[12px] text-muted-foreground">
            <span className="font-mono tabular-nums">
              {formatDuration(run.durationMs)}
            </span>
            <span className="text-fg-4">·</span>
            <span>{formatRelativeTime(run.createdAt)}</span>
          </div>
        </div>
      </div>

      {/* Scrolling header — chips + summary, OutcomeBar, duration trend */}
      <div className="border-b border-border px-6 pt-3 pb-[18px]">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11.5px]">
          {run.branch ? (
            <BranchPill href={branchHref} name={run.branch} />
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
            <CommitPill href={commitHref} sha={run.commitSha} />
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
                {run.totalTests}
              </span>
            ) : null}
          </Link>
        ))}
      </div>

      {/* Tab content — scrolls with the rest of the page */}
      {tab === "tests" ? (
        <RunProgress
          initialTests={tests}
          projectSlug={project.slug}
          runId={runId}
          teamSlug={project.teamSlug}
        />
      ) : (
        <EnvironmentTab run={run} />
      )}
    </div>
  );
}

function BranchPill({
  name,
  href,
}: {
  name: string;
  href: string | null;
}): React.ReactElement {
  const content = (
    <>
      <GitBranch className="size-3 shrink-0" strokeWidth={2} />
      <span className="truncate">{name}</span>
    </>
  );
  const className =
    "relative z-10 inline-flex max-w-[220px] items-center gap-1 rounded-full border border-line-1 bg-bg-2 px-2 py-px font-mono text-[11.5px] leading-[18px] text-fg-2 hover:text-foreground";
  return href ? (
    <a className={className} href={href} rel="noreferrer" target="_blank">
      {content}
    </a>
  ) : (
    <span className={className}>{content}</span>
  );
}

function PrPill({
  num,
  href,
}: {
  num: number;
  href: string | null;
}): React.ReactElement {
  const content = (
    <>
      <GitPullRequest className="size-3 shrink-0" strokeWidth={2} />#{num}
    </>
  );
  const className =
    "relative z-10 inline-flex shrink-0 items-center gap-1 rounded-full border border-line-1 bg-bg-2 px-2 py-px text-[11.5px] leading-[18px] text-fg-2 hover:text-foreground";
  return href ? (
    <a
      className={className}
      href={href}
      rel="noreferrer"
      target="_blank"
      title={`Open PR #${num}`}
    >
      {content}
    </a>
  ) : (
    <span className={className}>{content}</span>
  );
}

function EnvPill({ env }: { env: string }): React.ReactElement {
  const tone: { bg: string; fg: string } =
    env === "production"
      ? { bg: "oklch(0.70 0.20 24 / 0.14)", fg: "oklch(0.78 0.20 24)" }
      : env === "staging"
        ? { bg: "var(--accent-soft)", fg: "var(--accent-line)" }
        : { bg: "var(--bg-3)", fg: "var(--fg-2)" };
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-[4px] px-2 py-px font-mono text-[11px] font-medium tracking-[0.2px]"
      style={{ background: tone.bg, color: tone.fg }}
    >
      {env}
    </span>
  );
}

function CommitPill({
  sha,
  href,
}: {
  sha: string;
  href: string | null;
}): React.ReactElement {
  const short = sha.slice(0, 7);
  const className =
    "relative z-10 inline-flex shrink-0 items-center gap-1 font-mono text-[11.5px] text-fg-3 hover:text-foreground";
  const content = (
    <>
      <GitCommit className="size-3 shrink-0" strokeWidth={2} />
      {short}
    </>
  );
  return href ? (
    <a
      className={className}
      href={href}
      rel="noreferrer"
      target="_blank"
      title="View commit"
    >
      {content}
    </a>
  ) : (
    <span className={className}>{content}</span>
  );
}

/** GitHub-style URL helpers — local to this file to avoid widening the
 * shared `pr-url` module's API. The shared helpers don't expose
 * branch/commit URLs because the runs list only links PRs externally; the
 * detail header wants direct deep-links into the repo. */
function branchHrefFor(
  provider: string,
  repo: string,
  branch: string,
): string | null {
  if (provider === "github" || provider === "github-actions") {
    return `https://github.com/${repo}/tree/${encodeURIComponent(branch)}`;
  }
  return null;
}

function commitHrefFor(
  provider: string,
  repo: string,
  sha: string,
): string | null {
  if (provider === "github" || provider === "github-actions") {
    return `https://github.com/${repo}/commit/${sha}`;
  }
  return null;
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
