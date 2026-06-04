"use client";

import type React from "react";
import { OutcomeBar } from "@/components/outcome-bar";
import {
  currentSummary,
  useRunProgress,
  type RunProgressSummary,
} from "@/lib/live-client";

interface RunSummaryLiveProps {
  /** Run id used as the `void/live` topic suffix (`run:<runId>`). */
  runId: string;
  /** SSR-loaded aggregate. Seeds the live accumulator + first paint. */
  initialSummary: RunProgressSummary;
}

/**
 * Live run-summary header: the per-status SummaryStat tiles + the stacked
 * OutcomeBar, rendered from the published `RunProgressEvent.summary` snapshot
 * (seeded by `initialSummary`).
 *
 * This is the consumer that makes the ingest-side summary broadcast
 * load-bearing — it concentrates the header counters (tiles + bar) that
 * previously read static SSR `run.*` props in the RSC page into one client
 * leaf, so every `broadcastRunUpdate` (including `completeRun`, whose payload
 * is summary-only with `changedTests: []`) is reflected in the header without a
 * reload. The per-test list stays in its own island (`<RunProgress>`); this one
 * owns only the aggregate, and subscribes once for both the tiles and the bar.
 *
 * `"use client"` lives here at the leaf, not at the page root (islands ADR).
 * The total denominator prefers the bucket sum and falls back to `totalTests`
 * so the bar stays proportional even before the recompute lands — mirroring the
 * page's prior `run.passed + … || run.totalTests` derivation.
 */
export function RunSummaryLive({
  runId,
  initialSummary,
}: RunSummaryLiveProps): React.ReactElement {
  const state = useRunProgress(runId, { initialSummary });
  const summary = currentSummary(state, initialSummary);
  const total =
    summary.passed + summary.failed + summary.flaky + summary.skipped ||
    summary.totalTests;

  return (
    <>
      <div className="flex items-center justify-end gap-3 font-mono tabular-nums">
        <SummaryStat n={summary.passed} status="passed" />
        {summary.failed > 0 ? (
          <SummaryStat n={summary.failed} status="failed" />
        ) : null}
        {summary.flaky > 0 ? (
          <SummaryStat n={summary.flaky} status="flaky" />
        ) : null}
        {summary.skipped > 0 ? (
          <SummaryStat n={summary.skipped} status="skipped" />
        ) : null}
      </div>

      <div className="mt-2.5">
        <OutcomeBar
          failed={summary.failed}
          flaky={summary.flaky}
          height={6}
          passed={summary.passed}
          skipped={summary.skipped}
          total={total}
        />
      </div>
    </>
  );
}

/**
 * One per-status summary tile (dot + count + label). Presentational only;
 * exported so the run-detail header and the live island share one definition.
 */
function SummaryStat({
  status,
  n,
}: {
  status: "passed" | "failed" | "flaky" | "skipped";
  n: number;
}): React.ReactElement {
  const color = `var(--${status})`;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="inline-block size-1.5 rounded-full"
        style={{ background: color }}
      />
      <span style={{ color }}>{n}</span>
      <span className="capitalize text-fg-3">{status}</span>
    </span>
  );
}
