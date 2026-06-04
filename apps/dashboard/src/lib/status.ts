// Single status registry for the whole dashboard UI. Every presentation
// concern keyed off a test/run status — the colour token, the human label,
// the Badge variant, the worst-status sort order, and the collapse rule that
// folds `timedout → failed` / `interrupted → flaky` — lives here, so a
// maintainer adding a new Playwright status or renaming a token edits one
// record instead of hunting ~10 components.
//
// IMPORTANT: this registry stores a CSS custom-property NAME (`cssVar`), never
// a raw colour literal. `styles.css` (the `@theme` + light/dark blocks) remains
// the sole owner of the actual oklch values, so theming and dark-mode keep
// working. `statusToken()` returns `var(--pass)` for use in inline `style` and
// SVG `fill`/`stroke`/`background`.
//
// Unknown statuses (e.g. a future Playwright status we don't yet model) fall
// back to a muted, neutral presentation so the surprise never reads as a real
// failure.

export type Status =
  | "passed"
  | "failed"
  | "flaky"
  | "skipped"
  | "timedout"
  | "interrupted";

/** The four user-facing buckets statuses collapse into for grouping/counts. */
export type StatusGroupKey = "passed" | "failed" | "flaky" | "skipped";

/** Badge variant a status maps to — a subset of the `ui/badge` variants. */
export type StatusBadgeVariant = "success" | "error" | "warning" | "secondary";

interface StatusEntry {
  /** CSS custom-property name (no `var(...)` wrapper). styles.css owns the value. */
  cssVar: `--${string}`;
  /** Human-readable label (sentence case). */
  label: string;
  /** Variant for `<StatusBadge>` / `ui/badge`. */
  badge: StatusBadgeVariant;
  /**
   * Worst-status-first sort key (lower = worse). Drives group ordering and
   * within-group row ordering. `timedout` slots just after `failed`.
   */
  sortKey: number;
  /** Bucket the status collapses into for counts and filtering. */
  groupKey: StatusGroupKey;
}

export const STATUS = {
  failed: {
    cssVar: "--fail",
    label: "Failed",
    badge: "error",
    sortKey: 0,
    groupKey: "failed",
  },
  timedout: {
    cssVar: "--fail",
    label: "Timed out",
    badge: "error",
    sortKey: 1,
    groupKey: "failed",
  },
  flaky: {
    cssVar: "--flaky",
    label: "Flaky",
    badge: "warning",
    sortKey: 2,
    groupKey: "flaky",
  },
  interrupted: {
    cssVar: "--flaky",
    label: "Interrupted",
    badge: "warning",
    sortKey: 3,
    groupKey: "flaky",
  },
  skipped: {
    cssVar: "--skipped",
    label: "Skipped",
    badge: "secondary",
    sortKey: 4,
    groupKey: "skipped",
  },
  passed: {
    cssVar: "--pass",
    label: "Passed",
    badge: "success",
    sortKey: 5,
    groupKey: "passed",
  },
} as const satisfies Record<Status, StatusEntry>;

const FALLBACK_SORT_KEY = 99;

function isStatus(s: string): s is Status {
  return s in STATUS;
}

/**
 * CSS `var(...)` reference for a status's colour token (e.g. `var(--fail)`).
 * Unknown statuses fall back to a muted neutral. Use this in inline `style`
 * and SVG paint attributes — styles.css owns the resolved colour so charts
 * theme and match the rest of the UI.
 */
export function statusToken(status: string): string {
  return isStatus(status)
    ? `var(${STATUS[status].cssVar})`
    : "var(--muted-foreground)";
}

/** Human-readable label (e.g. "Timed out"). Title-cases unknown statuses. */
export function statusLabel(status: string): string {
  if (isStatus(status)) return STATUS[status].label;
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Badge variant for `<StatusBadge>` / `ui/badge`. Unknown → `outline`. */
export function statusBadgeVariant(
  status: string,
): StatusBadgeVariant | "outline" {
  return isStatus(status) ? STATUS[status].badge : "outline";
}

/** Worst-status-first sort key (lower = worse). Unknown → trailing. */
export function statusSortKey(status: string): number {
  return isStatus(status) ? STATUS[status].sortKey : FALLBACK_SORT_KEY;
}

/**
 * Bucket a status collapses into for counts/filtering:
 * `timedout → failed`, `interrupted → flaky`.
 *
 * Returns `null` for any status that is NOT in the registry — importantly,
 * `"queued"` (the in-flight placeholder prefilled by ingest before a test
 * starts) returns `null` so that in-progress runs never inflate any of the
 * four user-facing chips. Callers skip null when accumulating counts or
 * applying a status filter.
 */
export function statusGroupKey(status: string): StatusGroupKey | null {
  return isStatus(status) ? STATUS[status].groupKey : null;
}
