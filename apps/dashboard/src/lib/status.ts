// Single status registry for the whole dashboard UI. Every presentation
// concern keyed off a test/run status — the colour token, the human label,
// and the worst-status sort order — lives here, so a
// maintainer adding a new Playwright status or renaming a token edits one
// record instead of hunting ~10 components.
//
// The collapse rule that folds `timedout → failed` / `interrupted → flaky` is
// NOT defined here: it lives in the dependency-free `./status-buckets`
// (`STATUS_BUCKETS` / `statusGroupKey`), the single source of truth shared with
// ingest's server-side aggregate buckets (`STATUS_BUCKET_MEMBERS`) so the two
// can't drift. This module re-exports `statusGroupKey` + `StatusGroupKey` so
// existing `@/lib/status` importers are unaffected.
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

export { statusGroupKey } from "./status-buckets";
export type { StatusGroupKey } from "./status-buckets";

export type Status =
  | "passed"
  | "failed"
  | "flaky"
  | "skipped"
  | "timedout"
  | "interrupted";

interface StatusEntry {
  /** CSS custom-property name (no `var(...)` wrapper). styles.css owns the value. */
  cssVar: `--${string}`;
  /** Human-readable label (sentence case). */
  label: string;
  /**
   * Worst-status-first sort key (lower = worse). Drives group ordering and
   * within-group row ordering. `timedout` slots just after `failed`.
   */
  sortKey: number;
}

export const STATUS = {
  failed: {
    cssVar: "--fail",
    label: "Failed",
    sortKey: 0,
  },
  timedout: {
    cssVar: "--fail",
    label: "Timed out",
    sortKey: 1,
  },
  flaky: {
    cssVar: "--flaky",
    label: "Flaky",
    sortKey: 2,
  },
  interrupted: {
    cssVar: "--flaky",
    label: "Interrupted",
    sortKey: 3,
  },
  skipped: {
    cssVar: "--skipped",
    label: "Skipped",
    sortKey: 4,
  },
  passed: {
    cssVar: "--pass",
    label: "Passed",
    sortKey: 5,
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

/**
 * CSS custom-property NAME for a status (e.g. `--fail`) — for `<StatusPill>`,
 * which derives both the `-soft` tint and the text colour from it. Unknown
 * statuses fall back to the neutral `--skipped` pair.
 */
export function statusCssVar(status: string): `--${string}` {
  return isStatus(status) ? STATUS[status].cssVar : "--skipped";
}

/** Worst-status-first sort key (lower = worse). Unknown → trailing. */
export function statusSortKey(status: string): number {
  return isStatus(status) ? STATUS[status].sortKey : FALLBACK_SORT_KEY;
}
