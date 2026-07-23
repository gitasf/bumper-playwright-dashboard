/**
 * Pure date-range preset computation for the runs filter bar's `DateRangeFilter`.
 *
 * The filter stores `from`/`to` as `yyyy-MM-dd` strings, which
 * `buildRunsWhere` (`@/lib/runs/filters-where`) interprets at the UTC day
 * boundary — `from` at `T00:00:00.000Z`, `to` at `T23:59:59.999Z`. To stay in
 * lockstep with that interpretation, the bounds here are computed against the
 * UTC calendar day, not the viewer's local day. (A local-day boundary would
 * drift the window by a day for users west/east of UTC, since the WHERE clause
 * always reads the date as UTC midnight.)
 *
 * Every preset is an INCLUSIVE day window ending on "today" (the UTC day
 * containing `now`):
 *   - 24h        → today only (today → today)
 *   - 7d         → the last 7 calendar days (today − 6 → today)
 *   - 30d        → the last 30 calendar days (today − 29 → today)
 *   - this-month → the 1st of the current month → today
 *
 * Takes an explicit `now` (defaulting to the current time) so the boundary math
 * is deterministically unit-testable — see `date-range-presets.test.ts`.
 */
export type DateRangePresetId = "24h" | "7d" | "30d" | "this-month";

export interface DateRangePreset {
  id: DateRangePresetId;
  label: string;
}

/** The presets surfaced in the popover, in display order. */
export const DATE_RANGE_PRESETS: readonly DateRangePreset[] = [
  // "Today" not "Last 24 hours" — the 24h preset is today→today, a whole UTC
  // calendar day, not a rolling 24-hour window (see the boundary doc above).
  { id: "24h", label: "Today" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "this-month", label: "This month" },
];

/** Format a Date's UTC calendar day as `yyyy-MM-dd`. */
function toUtcIsoDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** A `[from, to]` pair of `yyyy-MM-dd` strings (the `onApply` argument shape). */
export interface PresetRange {
  from: string;
  to: string;
}

/**
 * Resolve a preset id to its `{ from, to }` `yyyy-MM-dd` bounds for the UTC day
 * containing `now`. Pure: `now` is injected so callers in tests can pin the day.
 */
export function presetRange(
  id: DateRangePresetId,
  now: Date = new Date(),
): PresetRange {
  // The UTC day containing `now`, at UTC midnight — the anchor every preset
  // measures back from. Mutating copies of this is safe (it's a fresh Date).
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const to = toUtcIsoDate(today);

  const daysBack = (n: number): Date => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - n);
    return d;
  };

  switch (id) {
    case "24h":
      return { from: to, to };
    case "7d":
      return { from: toUtcIsoDate(daysBack(6)), to };
    case "30d":
      return { from: toUtcIsoDate(daysBack(29)), to };
    case "this-month": {
      const firstOfMonth = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
      );
      return { from: toUtcIsoDate(firstOfMonth), to };
    }
  }
}
