import { statusToken } from "@/lib/status";

interface OutcomeBarProps {
  passed?: number;
  failed?: number;
  flaky?: number;
  skipped?: number;
  /** Bar height in px. Reference uses 6 for tables and 7-8 for hero contexts. */
  height?: number;
  /** Override the denominator when the bar reflects a fraction of a larger total. */
  total?: number;
  /** Min width in px. Default 80, matches the design bundle. */
  minWidth?: number;
  /** Max width in px. Unset = no cap (bar stretches to its container). */
  maxWidth?: number;
  /**
   * When the bucket counts (and `total`) are all zero, render a muted em-dash
   * instead of an empty track. Used by the tests catalog, where a no-data row
   * reads more clearly as "—" than as a blank bar.
   */
  emptyDash?: boolean;
}

interface OutcomeSegment {
  key: "passed" | "flaky" | "failed" | "skipped";
  n: number;
  /** Width as a percentage of the (possibly overridden) denominator. */
  widthPercent: number;
  /** CSS `var(...)` colour token from the status registry. */
  color: string;
}

/**
 * Pure layout for the stacked outcome bar: turns the four bucket counts (plus an
 * optional `total` override) into proportionally-sized segments in the canonical
 * pass → flaky → fail → skipped order. Extracted so the proportional-width math
 * and zero-total handling are unit-testable without rendering. Colours come from
 * the status registry (`statusToken`), so the bar stays theme-aware.
 */
export function outcomeBarSegments({
  passed = 0,
  failed = 0,
  flaky = 0,
  skipped = 0,
  total,
}: Pick<
  OutcomeBarProps,
  "passed" | "failed" | "flaky" | "skipped" | "total"
>): OutcomeSegment[] {
  const sum = total ?? passed + failed + flaky + skipped;
  const denom = sum === 0 ? 1 : sum;
  const segments: { key: OutcomeSegment["key"]; n: number }[] = [
    { key: "passed", n: passed },
    { key: "flaky", n: flaky },
    { key: "failed", n: failed },
    { key: "skipped", n: skipped },
  ];
  return segments.map((s) => ({
    key: s.key,
    n: s.n,
    widthPercent: (s.n / denom) * 100,
    color: statusToken(s.key),
  }));
}

/** Whether all four buckets (and any `total` override) are zero. */
export function isOutcomeEmpty({
  passed = 0,
  failed = 0,
  flaky = 0,
  skipped = 0,
  total,
}: Pick<
  OutcomeBarProps,
  "passed" | "failed" | "flaky" | "skipped" | "total"
>): boolean {
  return (total ?? passed + failed + flaky + skipped) === 0;
}

/**
 * Stacked horizontal outcome bar (pass / flaky / fail / skipped). Ports
 * `OutcomeBar` from `wrightful/project/primitives.jsx:115-130`. Background
 * is `--bg-3` (the "raised tint" surface) — segments overlay it
 * proportionally; empty buckets render no segment. The lone canonical
 * stacked-status-bar: the tests catalog renders this too (via `emptyDash`),
 * rather than forking its own.
 */
export function OutcomeBar({
  passed = 0,
  failed = 0,
  flaky = 0,
  skipped = 0,
  height = 6,
  total,
  minWidth = 80,
  maxWidth,
  emptyDash = false,
}: OutcomeBarProps) {
  if (emptyDash && isOutcomeEmpty({ passed, failed, flaky, skipped, total })) {
    return <div className="font-mono text-micro text-fg-3">—</div>;
  }
  const segments = outcomeBarSegments({
    passed,
    failed,
    flaky,
    skipped,
    total,
  });
  return (
    <div
      className="flex w-full overflow-hidden rounded-full bg-bg-3"
      role="img"
      aria-label={`${passed} passed, ${failed} failed, ${flaky} flaky, ${skipped} skipped`}
      style={{ height, minWidth, maxWidth }}
      title={`${passed} passed · ${failed} failed · ${flaky} flaky · ${skipped} skipped`}
    >
      {segments.map((s) => (
        <div
          key={s.key}
          className="transition-[width] duration-200 ease-out motion-reduce:transition-none"
          style={{
            width: `${s.widthPercent}%`,
            background: s.color,
          }}
        />
      ))}
    </div>
  );
}
