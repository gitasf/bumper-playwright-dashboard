export type Segment = "day" | "week" | "month";

export const SEGMENTS: readonly Segment[] = ["day", "week", "month"];

export const DAY_SEC = 86_400;
export const WEEK_SEC = 604_800;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function dayLabel(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function monthLabel(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
}

export function parseSegment(value: string | null, fallback: Segment): Segment {
  return value === "day" || value === "week" || value === "month"
    ? value
    : fallback;
}

/**
 * Build the empty skeleton of buckets covering [windowStartSec, nowSec].
 *
 * Day/week buckets are integer divisions of unix seconds; month buckets
 * use calendar alignment (strftime("%Y-%m") in SQL, matching
 * `${year}-${pad2(month)}` here). Keys are always strings.
 */
export function buildEmptyBuckets(
  segment: Segment,
  windowStartSec: number,
  nowSec: number,
): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  if (segment === "day") {
    const first = Math.floor(windowStartSec / DAY_SEC);
    const last = Math.floor(nowSec / DAY_SEC);
    for (let i = first; i <= last; i++) {
      out.push({
        key: String(i),
        label: dayLabel(new Date(i * DAY_SEC * 1000)),
      });
    }
    return out;
  }
  if (segment === "week") {
    const first = Math.floor(windowStartSec / WEEK_SEC);
    const last = Math.floor(nowSec / WEEK_SEC);
    for (let i = first; i <= last; i++) {
      out.push({
        key: String(i),
        label: dayLabel(new Date(i * WEEK_SEC * 1000)),
      });
    }
    return out;
  }
  const start = new Date(windowStartSec * 1000);
  const end = new Date(nowSec * 1000);
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1),
  );
  while (cursor.getTime() <= end.getTime()) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    out.push({ key: `${y}-${pad2(m)}`, label: monthLabel(cursor) });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

/**
 * Normalize a bucket value from a SQL row to the string form produced
 * by `buildEmptyBuckets`. Day/week come back as JS numbers from the
 * integer division; month as a "YYYY-MM" string.
 */
export function bucketKey(v: number | string): string {
  return String(v);
}

/**
 * Left-join SQL aggregate rows onto the empty bucket skeleton.
 *
 * This is the single home of the otherwise-implicit key-format contract
 * between `bucketExpr` (SQL side, in bucketing-sql.ts) and
 * `buildEmptyBuckets`/`bucketKey` (this file): every row carries a `bucket`
 * column produced by `bucketExpr`, and the only correct way to align it with
 * a skeleton slot is `bucketKey(r.bucket) === shell.key`. The join key is
 * therefore FIXED (no caller-supplied `keyOf`) — a free key selector would
 * reopen the exact drift this concentrates. Per-row projection stays in the
 * caller; this only returns each shell decorated with its matched row (or
 * `undefined` for an empty bucket).
 */
export function alignBuckets<R extends { bucket: number | string }>(
  segment: Segment,
  windowStartSec: number,
  nowSec: number,
  rows: readonly R[],
): { key: string; label: string; row: R | undefined }[] {
  const shells = buildEmptyBuckets(segment, windowStartSec, nowSec);
  const byKey = new Map(rows.map((r) => [bucketKey(r.bucket), r]));
  return shells.map((s) => ({
    key: s.key,
    label: s.label,
    row: byKey.get(s.key),
  }));
}
