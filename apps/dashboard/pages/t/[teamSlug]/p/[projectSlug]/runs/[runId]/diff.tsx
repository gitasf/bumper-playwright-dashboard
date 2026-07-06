import { Link, PREFETCH_REALTIME } from "@/components/ui/link";
import type React from "react";
import { use } from "react";
import { DeferredSection } from "@/components/defer-error-boundary";
import { DetailHeaderBar, HeaderCrumbs } from "@/components/page-header";
import { StatusGlyph } from "@/components/status-glyph";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/cn";
import type { FlakyDelta, PresenceChange, StatusChange } from "@/lib/run-diff";
import { statusLabel } from "@/lib/status";
import { formatDuration, formatRelativeTime } from "@/lib/time-format";
import type { Props } from "./diff.server";

/**
 * Run-to-run comparison page (roadmap 2.4). A pure read-path set-diff over two
 * runs' test results, keyed by stable `testId`. Sections are ordered by
 * importance — Newly Failed first, then Newly Passed, Still Failing, flaky
 * deltas, and added/removed tests.
 *
 * Kept RSC: the base-run selector is a list of `<Link>`s that set `?base=`,
 * which re-runs the loader (the diff is server-computed), so no client island
 * is needed.
 */
export default function RunDiffPage({
  project,
  head,
  base,
  comparison,
  baseCandidates,
}: Props) {
  const runsBase = `/t/${project.teamSlug}/p/${project.slug}/runs`;
  const headShort = head.id.slice(-7);
  const diffHref = (baseId: string | null): string =>
    baseId === null
      ? `${runsBase}/${head.id}/diff`
      : `${runsBase}/${head.id}/diff?base=${encodeURIComponent(baseId)}`;

  return (
    <>
      <div className="flex-1 overflow-y-auto min-h-0">
        <DetailHeaderBar className="gap-1.5 border-b border-border">
          <HeaderCrumbs
            items={[
              { label: "Runs", href: runsBase, cacheFor: PREFETCH_REALTIME },
              {
                label: `#${headShort}`,
                href: `${runsBase}/${head.id}`,
                cacheFor: PREFETCH_REALTIME,
              },
            ]}
          />
          <h1 className="text-[17px] font-semibold tracking-[-0.2px]">
            Compare runs
          </h1>
        </DetailHeaderBar>

        <div className="border-b border-border px-6 pt-3 pb-3">
          <div className="text-[12.5px] text-muted-foreground">
            Diffing test results against a baseline run on{" "}
            {head.branch ? (
              <span className="font-mono">{head.branch}</span>
            ) : (
              <span className="italic">no branch</span>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px]">
            <RunChip label="Head" run={head} runsBase={runsBase} />
            <span className="text-fg-4">vs</span>
            {base ? (
              <RunChip label="Base" run={base} runsBase={runsBase} />
            ) : (
              <span className="text-muted-foreground italic">no base</span>
            )}
          </div>

          {baseCandidates.length > 0 ? (
            <BaseSelector
              baseCandidates={baseCandidates}
              diffHref={diffHref}
              selectedBaseId={base?.id ?? null}
            />
          ) : null}
        </div>

        {base ? (
          <DeferredSection
            resetKey={`${head.id}:${base.id}`}
            skeleton={<DiffBodySkeleton />}
          >
            <DiffBody comparison={comparison} />
          </DeferredSection>
        ) : (
          <div className="flex min-h-[40vh] items-center justify-center p-10">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No baseline to compare against</EmptyTitle>
                <EmptyDescription>
                  {head.branch
                    ? `There is no earlier passing run on "${head.branch}" to use as a baseline. A base run is the most recent passing run on the same branch, created before this one.`
                    : "This run has no branch, so there is no same-branch baseline to compare against."}
                  {baseCandidates.length > 0
                    ? " Pick a base run above to compare manually."
                    : ""}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        )}
      </div>
    </>
  );
}

/** The deferred diff body: the CountPill summary row + either the "No
 *  differences" empty state or the six bucket tables. Reads the deferred
 *  `comparison` ({ diff, counts }); the caller only renders this when `base`
 *  (eager) exists, so `diff`/`counts` are non-null here. */
function DiffBody({
  comparison,
}: {
  comparison: Props["comparison"];
}): React.ReactElement | null {
  const { diff, counts } = use(comparison);
  if (!diff || !counts) return null;
  const total =
    counts.newlyFailed +
    counts.newlyPassed +
    counts.stillFailing +
    counts.flakyDeltas +
    counts.addedTests +
    counts.removedTests;
  return (
    <div className="px-6 py-4">
      <div className="mb-4 flex flex-wrap gap-2">
        <CountPill
          accent="var(--fail)"
          count={counts.newlyFailed}
          label="Newly failed"
        />
        <CountPill
          accent="var(--pass)"
          count={counts.newlyPassed}
          label="Newly passed"
        />
        <CountPill count={counts.stillFailing} label="Still failing" />
        <CountPill count={counts.flakyDeltas} label="Flaky changes" />
        <CountPill count={counts.addedTests} label="Added" />
        <CountPill count={counts.removedTests} label="Removed" />
      </div>

      {total === 0 ? (
        <div className="flex min-h-[40vh] items-center justify-center p-10">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No differences</EmptyTitle>
              <EmptyDescription>
                These two runs have identical test outcomes — same pass/fail
                state, retries, and test set.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <StatusChangeSection rows={diff.newlyFailed} title="Newly failed" />
          <StatusChangeSection rows={diff.newlyPassed} title="Newly passed" />
          <StatusChangeSection rows={diff.stillFailing} title="Still failing" />
          <FlakyDeltaSection rows={diff.flakyDeltas} />
          <PresenceSection rows={diff.addedTests} title="Added tests" />
          <PresenceSection rows={diff.removedTests} title="Removed tests" />
        </div>
      )}
    </div>
  );
}

/** Fallback for the deferred diff body: the 6-pill summary row + a couple of
 *  bucket-table placeholders. The real section count/sizes are only known
 *  post-scan, and this is the terminal, below-the-fold region, so a fixed
 *  plausible shape resizes in place without shifting anything above. */
function DiffBodySkeleton(): React.ReactElement {
  const bucketRows = Array.from({ length: 4 }, (_, r) => (
    <Skeleton className="h-9 w-full" key={r} />
  ));
  return (
    <div className="px-6 py-4">
      <div className="mb-4 flex flex-wrap gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton className="h-[28px] w-28 rounded-md" key={i} />
        ))}
      </div>
      <div className="flex flex-col gap-6">
        {Array.from({ length: 2 }, (_, s) => (
          <div key={s}>
            <Skeleton className="mb-2 h-5 w-40" />
            <div className="space-y-2">{bucketRows}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RunChip({
  label,
  run,
  runsBase,
}: {
  label: string;
  run: {
    id: string;
    status: string;
    commitSha: string | null;
    commitMessage: string | null;
    createdAt: number;
  };
  runsBase: string;
}): React.ReactElement {
  return (
    <Link
      className="inline-flex items-center gap-2 rounded-md border border-line-1 bg-card px-2.5 py-1.5 transition-colors hover:border-border"
      href={`${runsBase}/${run.id}`}
    >
      <span className="text-fg-3">{label}</span>
      <StatusGlyph size={13} status={run.status} />
      <span className="font-mono text-fg-2">#{run.id.slice(-7)}</span>
      {run.commitSha ? (
        <span className="font-mono text-fg-3">{run.commitSha.slice(0, 7)}</span>
      ) : null}
      <span className="text-fg-3">{formatRelativeTime(run.createdAt)}</span>
    </Link>
  );
}

function BaseSelector({
  baseCandidates,
  selectedBaseId,
  diffHref,
}: {
  baseCandidates: Props["baseCandidates"];
  selectedBaseId: string | null;
  diffHref: (baseId: string | null) => string;
}): React.ReactElement {
  return (
    <div className="mt-3">
      <div className="mb-1.5 text-[11.5px] uppercase tracking-wide text-fg-3">
        Base run
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Link
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors",
            selectedBaseId === null
              ? "border-border bg-secondary text-foreground"
              : "border-line-1 text-fg-2 hover:border-border",
          )}
          href={diffHref(null)}
        >
          Auto
        </Link>
        {baseCandidates.map((c) => (
          <Link
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors",
              selectedBaseId === c.id
                ? "border-border bg-secondary text-foreground"
                : "border-line-1 text-fg-2 hover:border-border",
            )}
            href={diffHref(c.id)}
            key={c.id}
            title={c.commitMessage ?? c.id}
          >
            <StatusGlyph size={12} status={c.status} />
            <span className="font-mono">#{c.id.slice(-7)}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function CountPill({
  label,
  count,
  accent,
}: {
  label: string;
  count: number;
  accent?: string;
}): React.ReactElement {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-md border border-line-1 bg-card px-2.5 py-1 text-[12px]">
      <span className="text-fg-3">{label}</span>
      <span
        className="font-mono font-medium tabular-nums"
        style={accent && count > 0 ? { color: accent } : undefined}
      >
        {count}
      </span>
    </div>
  );
}

/** Section title + count, shared chrome around each bucket table. */
function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}): React.ReactElement | null {
  if (count === 0) return null;
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-[14px] font-semibold">
        {title}
        <span className="font-mono text-[12px] tabular-nums text-fg-3">
          {count}
        </span>
      </h2>
      {children}
    </section>
  );
}

function StatusCell({ status }: { status: string }): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusGlyph size={13} status={status} />
      <span>{statusLabel(status)}</span>
    </span>
  );
}

/** Signed, human-readable duration delta (`+1.2s`, `-340ms`, `±0`, or `—`). */
function DurationDelta({
  deltaMs,
}: {
  deltaMs: number | null;
}): React.ReactElement {
  // null = a side didn't run (skipped/queued base), so there's no real baseline
  // duration to diff against — show an em-dash, not a phantom regression.
  if (deltaMs === null) {
    return <span className="text-fg-3">—</span>;
  }
  if (deltaMs === 0) {
    return <span className="text-fg-3">±0</span>;
  }
  const sign = deltaMs > 0 ? "+" : "-";
  const color = deltaMs > 0 ? "var(--fail)" : "var(--pass)";
  return (
    <span className="font-mono tabular-nums" style={{ color }}>
      {sign}
      {formatDuration(Math.abs(deltaMs))}
    </span>
  );
}

function StatusChangeSection({
  title,
  rows,
}: {
  title: string;
  rows: StatusChange[];
}): React.ReactElement | null {
  return (
    <Section count={rows.length} title={title}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Test</TableHead>
            <TableHead>Base</TableHead>
            <TableHead>Head</TableHead>
            <TableHead className="text-right">Δ Duration</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.testId}>
              <TableCell className="max-w-[420px] truncate font-mono text-[12px]">
                {r.testId}
              </TableCell>
              <TableCell>
                <StatusCell status={r.baseStatus} />
              </TableCell>
              <TableCell>
                <StatusCell status={r.headStatus} />
              </TableCell>
              <TableCell className="text-right">
                <DurationDelta deltaMs={r.durationDeltaMs} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

function FlakyDeltaSection({
  rows,
}: {
  rows: FlakyDelta[];
}): React.ReactElement | null {
  return (
    <Section count={rows.length} title="Flaky changes">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Test</TableHead>
            <TableHead>Base</TableHead>
            <TableHead>Head</TableHead>
            <TableHead className="text-right">Retries</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.testId}>
              <TableCell className="max-w-[420px] truncate font-mono text-[12px]">
                {r.testId}
              </TableCell>
              <TableCell>
                <StatusCell status={r.baseStatus} />
              </TableCell>
              <TableCell>
                <StatusCell status={r.headStatus} />
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {r.baseRetryCount} → {r.headRetryCount}
                {r.flakyChanged ? (
                  <Badge className="ml-2" size="sm" variant="warning">
                    flaky changed
                  </Badge>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

function PresenceSection({
  title,
  rows,
}: {
  title: string;
  rows: PresenceChange[];
}): React.ReactElement | null {
  return (
    <Section count={rows.length} title={title}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Test</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Duration</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.testId}>
              <TableCell className="max-w-[420px] truncate font-mono text-[12px]">
                {r.testId}
              </TableCell>
              <TableCell>
                <StatusCell status={r.status} />
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums text-fg-2">
                {formatDuration(r.durationMs)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}
