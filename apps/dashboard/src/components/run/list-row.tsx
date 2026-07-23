import { PREFETCH_REALTIME } from "@/components/ui/link";
import { RowLink } from "@/components/row-link";
import { memo } from "react";
import type React from "react";
import { ActorAvatar } from "@/components/actor-avatar";
import { githubAvatarUrl } from "@/lib/github-avatar";
import { LiveDuration } from "@/components/live-duration";
import { OutcomeBar } from "@/components/outcome-bar";
import {
  BranchPill,
  CommitPill,
  EnvPill,
  PrPill,
} from "@/components/run/meta-pills";
import { RunTestsPopover } from "@/components/run/tests-popover";
import { StatusGlyph } from "@/components/status-glyph";
import { TableCell, TableRow } from "@/components/ui/table";
import type { RunListRowData } from "@/realtime/events";
import { branchUrl, commitUrl, prUrl } from "@/lib/pr-url";
import { runOutcomeTotals } from "@/lib/runs/outcome";
import { formatRelativeTime } from "@/lib/time-format";

interface RunListRowProps {
  /**
   * Row data: a `runs` table row (the loader passes the whole row, which
   * satisfies {@link RunListRowData}) with any live room summary already
   * overlaid by the page via `useProjectRoom`.
   */
  run: RunListRowData;
  teamSlug: string;
  projectSlug: string;
  /** Display ordinal (#N), computed by the page from the row's list position. */
  runNum: number;
}

/**
 * One run row on the project runs list. Presentational — every value comes
 * from `run`, so the same markup serves both terminal runs (straight from SSR)
 * and live ones (the page overlays the streamed summary onto `run`). Extracted
 * out of the page so the row markup has a single home.
 *
 * Memoized: the page re-renders on every `run-progress` WS event, but the feed
 * reducer (`applyProjectFeedEvent`) preserves identity for untouched rows and
 * clones only the changed one. Props are just that `run` reference plus
 * primitives (no inline callbacks or fresh objects), so `React.memo`'s shallow
 * compare bails out for the other ~19 rows instead of re-running their
 * formatting/URL/pill work.
 */
export const RunListRow = memo(function RunListRow({
  run,
  teamSlug,
  projectSlug,
  runNum,
}: RunListRowProps): React.ReactElement {
  const base = `/t/${teamSlug}/p/${projectSlug}`;
  const href = `${base}/runs/${run.id}`;
  const prHref = prUrl(run.ciProvider, run.repo, run.prNumber);
  const commitHref = commitUrl(run.ciProvider, run.repo, run.commitSha);
  const branchHref = branchUrl(run.ciProvider, run.repo, run.branch);
  // Denominator = full declared suite size; `pending` = the not-yet-reported
  // remainder. Clamp rules live in `runOutcomeTotals` (see its doc).
  const { total, pending } = runOutcomeTotals(run);

  return (
    <TableRow>
      <TableCell className="w-10 px-4 py-3 align-middle">
        {/* Stretched-link pattern: the `<Link>` is `position: static` so its
         * `after:inset-0` pseudo fills the nearest positioned ancestor — the
         * TableRow (which has `relative` above). Result: the whole row is the
         * click target. Nested `relative z-10` external links (branch/PR/commit
         * chips) call `e.stopPropagation()` so their clicks don't bubble to this
         * Link's SPA-navigation handler. */}
        {/* prefetch disabled: hover-prefetch would fire a full run-detail loader
         * (incl. the deferred run-history chart) for every row the pointer sweeps.
         * Run detail already seeds live via the realtime room, so it buys nothing
         * worth the 20x loader fan-out. */}
        <RowLink cacheFor={PREFETCH_REALTIME} href={href} prefetch={false}>
          <span className="sr-only">
            View run {run.commitMessage ?? run.id.slice(0, 8)}
          </span>
          <StatusGlyph size={14} status={run.status} />
        </RowLink>
      </TableCell>

      <TableCell className="px-4 py-3 align-middle">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 font-mono text-caption tabular-nums text-fg-3">
              #{runNum}
            </span>
            <span
              className="min-w-0 flex-1 truncate text-body-lg text-fg-1"
              title={run.commitMessage ?? undefined}
            >
              {run.commitMessage ? (
                run.commitMessage
              ) : run.actor ? (
                `@${run.actor}`
              ) : (
                <span className="italic text-fg-3">No message</span>
              )}
            </span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-caption text-fg-3">
            {run.branch ? (
              <BranchPill href={branchHref} name={run.branch} />
            ) : null}
            {run.prNumber != null ? (
              <PrPill href={prHref} num={run.prNumber} />
            ) : null}
            {run.environment ? <EnvPill env={run.environment} /> : null}
            {run.commitSha ? (
              <CommitPill href={commitHref} sha={run.commitSha} />
            ) : null}
            {run.actor ? (
              <span className="inline-flex shrink-0 items-center gap-1.5">
                <ActorAvatar
                  actor={run.actor}
                  imageUrl={githubAvatarUrl(run.actor, run.ciProvider)}
                />
                <span className="truncate">{run.actor}</span>
              </span>
            ) : null}
          </div>
        </div>
      </TableCell>

      <TableCell className="w-[220px] px-4 py-3 align-middle">
        <div className="flex flex-col gap-1.5">
          <OutcomeBar
            failed={run.failed}
            flaky={run.flaky}
            height={7}
            passed={run.passed}
            skipped={run.skipped}
            total={total}
          />
          <div className="flex items-center gap-2.5 font-mono text-micro tabular-nums">
            <RunTestsPopover
              count={run.passed}
              projectSlug={projectSlug}
              runHref={href}
              runId={run.id}
              teamSlug={teamSlug}
              variant="passed"
            />
            {run.failed > 0 ? (
              <RunTestsPopover
                count={run.failed}
                projectSlug={projectSlug}
                runHref={href}
                runId={run.id}
                teamSlug={teamSlug}
                variant="failed"
              />
            ) : null}
            {run.flaky > 0 ? (
              <RunTestsPopover
                count={run.flaky}
                projectSlug={projectSlug}
                runHref={href}
                runId={run.id}
                teamSlug={teamSlug}
                variant="flaky"
              />
            ) : null}
            {pending > 0 ? (
              <span className="shrink-0 text-fg-4">{pending} pending</span>
            ) : null}
            <span className="ml-auto text-[color:var(--fg-4)]">/{total}</span>
          </div>
        </div>
      </TableCell>

      <TableCell className="w-[90px] px-4 py-3 text-right align-middle font-mono text-caption tabular-nums text-fg-3">
        <LiveDuration
          completedAt={run.completedAt}
          createdAt={run.createdAt}
          durationMs={run.durationMs}
          status={run.status}
        />
      </TableCell>

      <TableCell className="w-[100px] px-4 py-3 text-right align-middle text-caption text-fg-3">
        {formatRelativeTime(run.createdAt)}
      </TableCell>
    </TableRow>
  );
});
