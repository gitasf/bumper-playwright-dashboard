import { ChevronRight } from "lucide-react";
import { Link } from "@void/react";
import { memo } from "react";
import { StatusGlyph } from "@/components/status-glyph";
import { ReplayRowButton } from "@/components/trace-viewer-dialog";
import { basename } from "@/lib/basename";
import { cn } from "@/lib/cn";
import {
  type GroupByAxis,
  parseTitleSegments,
} from "@/lib/group-tests-by-file";
import { statusLabel, statusToken } from "@/lib/status";
import { formatDuration } from "@/lib/time-format";
import type { RunProgressTest } from "@/realtime/run-progress";

/**
 * One status's count in a group header: the shared shape-per-status
 * {@link StatusGlyph} icon + the count, both in the status colour — matching the
 * worst-status glyph on this same header and the per-row glyphs, so the header
 * speaks the site's icon language instead of the old `f`/`~`/`s`/`p` letters.
 */
export function GroupStatusCount({
  status,
  n,
}: {
  status: "passed" | "failed" | "flaky" | "skipped";
  n: number;
}) {
  return (
    <span
      className="inline-flex items-center gap-1"
      style={{ color: statusToken(status) }}
      title={`${n} ${statusLabel(status).toLowerCase()}`}
    >
      <StatusGlyph size={12} status={status} />
      {n}
    </span>
  );
}

/**
 * One test row within an expanded group: status glyph, title, meta, duration.
 *
 * Memoized: the reducer (`applyRunProgressEvent`) makes a new `test` reference
 * only when that test changes, so an unaffected row keeps its `test` identity
 * even when its group's `rows` array is rebuilt (`mergeGroupRows` reuses the
 * individual row objects). The remaining props are primitives, and there are no
 * callback props to hoist.
 */
export const TestRow = memo(function TestRow({
  test,
  groupBy,
  teamSlug,
  projectSlug,
  runId,
}: {
  test: RunProgressTest;
  groupBy: GroupByAxis;
  teamSlug: string;
  projectSlug: string;
  runId: string;
}) {
  const href = `/t/${teamSlug}/p/${projectSlug}/runs/${runId}/tests/${test.id}?attempt=0`;
  // The stored title is Playwright's `titlePath`: `[project >] file > describe… >
  // test`. Parse it down to just the describe chain + leaf title so the project
  // and file don't leak into the row's `>` chain — they're already surfaced by
  // the group header and the trailing meta column, not repeated here.
  const { describeChain, testTitle } = parseTitleSegments(
    test.title,
    test.file,
    test.projectName,
  );
  const displayTitle =
    describeChain.length > 0
      ? `${describeChain.join(" > ")} > ${testTitle}`
      : testTitle;

  // Trailing meta shows the axis that ISN'T the group header: the Playwright
  // project when grouped by file, the file basename when grouped by project.
  const meta =
    groupBy === "file"
      ? test.projectName
      : test.file
        ? basename(test.file)
        : null;

  // The row is a <Link>, so the Test Replay button (which opens a dialog) lives
  // as a SIBLING of the anchor, not nested inside it — a nested interactive
  // control inside an <a> is invalid, and a second anchor to the same href would
  // add a redundant screen-reader link and let the SPA schedule two competing
  // navigations. The primary navigable content stays in the inner <Link>.
  return (
    <div
      className={cn(
        "group flex w-full items-center gap-1 py-1.5 pl-[50px] pr-6",
        "min-h-8 text-left text-fg-1 hover:bg-bg-1",
      )}
    >
      <Link
        className="flex min-w-0 flex-1 items-center gap-1 text-left text-fg-1"
        href={href}
      >
        <span className="flex w-[18px] shrink-0 items-center justify-center">
          <StatusGlyph size={12} status={test.status} />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
          <span className="min-w-0 truncate text-body">{displayTitle}</span>
          {test.retryCount > 0 ? (
            <span
              className="shrink-0 font-mono text-micro"
              style={{ color: statusToken("flaky") }}
            >
              ×{test.retryCount + 1}
            </span>
          ) : null}
        </div>
        {meta ? (
          <span
            className={cn(
              "inline-flex max-w-[128px] shrink-0 items-center rounded-[4px] bg-bg-2 px-1.5 py-px font-mono text-micro leading-[16px] text-fg-3",
              groupBy === "file" && "capitalize",
            )}
            title={meta}
          >
            <span className="truncate">{meta}</span>
          </span>
        ) : null}
        <span className="w-[70px] shrink-0 px-2 text-right font-mono text-caption tabular-nums text-fg-3">
          {formatDuration(test.durationMs)}
        </span>
      </Link>
      {test.hasTrace ? <ReplayRowButton testResultId={test.id} /> : null}
      {/*
       * Decorative hover affordance only — the primary row <Link> above already
       * navigates. Kept a non-interactive aria-hidden <span> (not a second
       * <Link>) so AT ignores the redundant chevron.
       */}
      <span
        aria-hidden="true"
        className="flex w-5 shrink-0 items-center justify-center px-1 text-center text-fg-3 opacity-0 group-hover:opacity-100"
      >
        <ChevronRight className="size-3" strokeWidth={2} />
      </span>
    </div>
  );
});
