import { describe, expect, it } from "vite-plus/test";
import { sql } from "void/db";
import {
  alignBuckets,
  buildEmptyBuckets,
  DAY_SEC,
  parseSegment,
  WEEK_SEC,
} from "@/lib/analytics/bucketing";
import { bucketExpr, percentilePick } from "@/lib/analytics/bucketing-sql";

/**
 * `parseSegment` + `buildEmptyBuckets` are the bucket-skeleton builders the
 * insights islands render against. The highest-value invariant here is the
 * cross-implementation contract: the JS month key `${y}-${pad2(m)}` emitted by
 * `buildEmptyBuckets` must byte-for-byte match the SQL side's
 * `strftime('%Y-%m', runs."createdAt", 'unixepoch')` in bucketing-sql.ts, or
 * SQL-row buckets silently fail to join their empty-skeleton slot. SQLite's
 * `'unixepoch'` reads the timestamp as UTC seconds, so the reference below
 * derives the same key from a UTC `Date` — exactly what the SQL emits.
 */

/**
 * Reference month key matching SQLite `strftime('%Y-%m', sec, 'unixepoch')`:
 * the UTC year and zero-padded 1-based month of a unix-second timestamp.
 */
function strftimeMonthKey(sec: number): string {
  const d = new Date(sec * 1000);
  const m = d.getUTCMonth() + 1;
  return `${d.getUTCFullYear()}-${m < 10 ? `0${m}` : m}`;
}

describe("parseSegment", () => {
  it("returns a recognized segment unchanged", () => {
    expect(parseSegment("day", "month")).toBe("day");
    expect(parseSegment("week", "month")).toBe("week");
    expect(parseSegment("month", "day")).toBe("month");
  });

  it("falls back for a null param (absent ?segment=)", () => {
    expect(parseSegment(null, "week")).toBe("week");
  });

  it("falls back for an unrecognized value", () => {
    expect(parseSegment("year", "day")).toBe("day");
    expect(parseSegment("", "month")).toBe("month");
  });
});

describe("buildEmptyBuckets — day/week", () => {
  it("emits one day bucket per UTC day in [start, now] via integer division", () => {
    // Three whole days starting at a day boundary.
    const start = 100 * DAY_SEC;
    const now = 102 * DAY_SEC;
    const buckets = buildEmptyBuckets("day", start, now);
    expect(buckets.map((b) => b.key)).toEqual(["100", "101", "102"]);
  });

  it("keys days by floor(sec / DAY_SEC), inclusive of partial start/end days", () => {
    // Mid-day start and mid-day now still land in their containing day bucket.
    const start = 100 * DAY_SEC + 5_000;
    const now = 101 * DAY_SEC + 80_000;
    const buckets = buildEmptyBuckets("day", start, now);
    expect(buckets.map((b) => b.key)).toEqual(["100", "101"]);
  });

  it("emits a single bucket when start and now fall in the same day", () => {
    const start = 100 * DAY_SEC + 1;
    const now = 100 * DAY_SEC + 2;
    expect(buildEmptyBuckets("day", start, now)).toHaveLength(1);
  });

  it("keys weeks by floor(sec / WEEK_SEC)", () => {
    const start = 10 * WEEK_SEC;
    const now = 12 * WEEK_SEC;
    const buckets = buildEmptyBuckets("week", start, now);
    expect(buckets.map((b) => b.key)).toEqual(["10", "11", "12"]);
  });
});

describe("buildEmptyBuckets — month (SQL strftime parity)", () => {
  it("emits zero-padded YYYY-MM keys for a window spanning a year boundary", () => {
    // 2023-11-15 -> 2024-02-15 (UTC): Nov, Dec, Jan, Feb. Crosses the year
    // rollover and exercises the single-digit -> zero-padded month transition.
    const start = Math.floor(Date.UTC(2023, 10, 15) / 1000);
    const now = Math.floor(Date.UTC(2024, 1, 15) / 1000);
    const buckets = buildEmptyBuckets("month", start, now);
    expect(buckets.map((b) => b.key)).toEqual([
      "2023-11",
      "2023-12",
      "2024-01",
      "2024-02",
    ]);
  });

  it("aligns the first bucket to the start of the start month, not the start instant", () => {
    // A mid-month start (Mar 20) still yields a bucket keyed to that month.
    const start = Math.floor(Date.UTC(2024, 2, 20) / 1000);
    const now = Math.floor(Date.UTC(2024, 2, 25) / 1000);
    const buckets = buildEmptyBuckets("month", start, now);
    expect(buckets.map((b) => b.key)).toEqual(["2024-03"]);
  });

  it("matches the SQL strftime('%Y-%m') key for every month in the window", () => {
    // The load-bearing contract: each JS key equals what strftime would emit
    // for a timestamp inside that month. Walk a 14-month window and compare
    // each bucket's key against the UTC-derived reference.
    const start = Math.floor(Date.UTC(2023, 11, 1) / 1000); // 2023-12
    const now = Math.floor(Date.UTC(2025, 0, 31) / 1000); // 2025-01
    const buckets = buildEmptyBuckets("month", start, now);

    expect(buckets).toHaveLength(14);
    for (const b of buckets) {
      const [y, m] = b.key.split("-").map(Number);
      // A mid-month instant in this bucket's month, fed through the strftime
      // reference, must reproduce the same key the builder emitted.
      const midMonthSec = Math.floor(Date.UTC(y, m - 1, 15) / 1000);
      expect(strftimeMonthKey(midMonthSec)).toBe(b.key);
    }
    // Spot-check the boundary keys are zero-padded across the year rollover.
    expect(buckets[0].key).toBe("2023-12");
    expect(buckets[1].key).toBe("2024-01");
    expect(buckets.at(-1)?.key).toBe("2025-01");
  });

  it("includes the current month when start and now share it", () => {
    const start = Math.floor(Date.UTC(2024, 5, 3) / 1000);
    const now = Math.floor(Date.UTC(2024, 5, 28) / 1000);
    const buckets = buildEmptyBuckets("month", start, now);
    expect(buckets.map((b) => b.key)).toEqual(["2024-06"]);
  });
});

/**
 * The load-bearing F46 invariant: the day/week divisors are NOT shared imports
 * (`bucketExpr` inlines them as SQL literals on purpose — D1's bound-parameter
 * pipeline applies text affinity that would turn integer division into string
 * concatenation). Because they live in two files, the only thing stopping them
 * from drifting is a test that derives the expected SQL literal FROM the JS
 * constant `buildEmptyBuckets` divides by. If `DAY_SEC` changes but the SQL
 * literal does not (or vice versa), `bucketKey(row.bucket)` no longer matches
 * any skeleton key and every chart silently renders empty — no type error, no
 * exception. This block fails loudly the instant the two sides disagree.
 *
 * Under the void/db stub, `sql` records its template parts as `{ strings, args }`
 * so we can read back the rendered fragment without a real database.
 */
describe("bucketExpr ⟷ buildEmptyBuckets divisor parity", () => {
  type SqlChunk = { strings: readonly string[]; args: readonly unknown[] };

  function rendered(expr: unknown): SqlChunk {
    return expr as SqlChunk;
  }

  /**
   * The load-bearing invariant: the day/week DIVISOR is inline literal SQL
   * text, never a bound numeric arg (D1 text affinity would corrupt it). The
   * column is interpolated as a nested `sql` fragment — that is the ONLY arg,
   * and it is a fragment object, not a primitive number/string param. So we
   * assert (a) the divisor is present as inline text and (b) no arg is a bound
   * primitive.
   */
  function assertNoBoundPrimitive(chunk: SqlChunk) {
    for (const a of chunk.args) {
      expect(typeof a).not.toBe("number");
      expect(typeof a).not.toBe("string");
    }
  }

  it("inlines the day divisor as exactly String(DAY_SEC), with no bound primitive", () => {
    const chunk = rendered(bucketExpr("day"));
    assertNoBoundPrimitive(chunk);
    expect(chunk.strings.join("")).toContain(`/ ${DAY_SEC}`);
  });

  it("inlines the week divisor as exactly String(WEEK_SEC), with no bound primitive", () => {
    const chunk = rendered(bucketExpr("week"));
    assertNoBoundPrimitive(chunk);
    expect(chunk.strings.join("")).toContain(`/ ${WEEK_SEC}`);
  });

  it("renders the month bucket via strftime('%Y-%m'), matching the JS YYYY-MM key", () => {
    const chunk = rendered(bucketExpr("month"));
    assertNoBoundPrimitive(chunk);
    expect(chunk.strings.join("")).toContain("strftime('%Y-%m'");
  });

  it('defaults the bucketed column to runs."createdAt" (the run-scoped loaders)', () => {
    // The default column fragment must render the runs timestamp identifier;
    // the three run-scoped loaders rely on this default.
    const col = rendered(bucketExpr("day")).args[0] as SqlChunk;
    expect(col.strings.join("")).toContain('runs."createdAt"');
  });

  it("threads a caller-supplied column fragment (slowest-tests sparkline over testResults)", () => {
    // slowest-tests buckets `tr."createdAt"` instead of the runs column; the
    // same day divisor + affinity caveat must apply via the same seam.
    const chunk = rendered(bucketExpr("day", sql`tr."createdAt"`));
    assertNoBoundPrimitive(chunk);
    expect(chunk.strings.join("")).toContain(`/ ${DAY_SEC}`);
    const col = chunk.args[0] as SqlChunk;
    expect(col.strings.join("")).toContain('tr."createdAt"');
  });
});

/**
 * `percentilePick` concentrates the discrete-percentile idiom that was
 * previously re-stated 7× across the run-duration and slowest-tests loaders:
 * `min(case when <rn> = max(1, cast(round(<cnt> * q) as integer)) then <value> end)`.
 * The correctness-sensitive parts are (a) the `max(1, …)` clamp that keeps a
 * single-row partition resolvable and (b) the `round`-based discrete rank. These
 * assertions pin the emitted SQL so a maintainer changing the rounding /
 * interpolation rule edits one place and this fails loudly if the shape drifts.
 *
 * The picker inlines the quantile + column names as raw SQL (no bound params),
 * for the same text-affinity reason `bucketExpr` inlines its divisors. Under the
 * void/db stub, `sql.raw(s)` records `s` verbatim so we can read it back.
 */
describe("percentilePick", () => {
  function rawText(expr: unknown): string {
    const chunk = expr as { strings: unknown; args: readonly unknown[] };
    // `sql.raw(s)` stores the string in `strings`; a tagged template stores a
    // string[]. Normalize both to a single rendered string.
    const s = chunk.strings;
    return Array.isArray(s) ? s.join("") : String(s);
  }

  it("defaults to the run-duration columns (rn / cnt / duration)", () => {
    expect(rawText(percentilePick(0.5))).toBe(
      "min(case when rn = max(1, cast(round(cnt * 0.50) as integer)) then duration end)",
    );
  });

  it("renders the quantile to two decimals (0.50 / 0.90 / 0.95), no bound args", () => {
    const chunk = percentilePick(0.9) as unknown as {
      args: readonly unknown[];
    };
    expect(chunk.args).toHaveLength(0);
    expect(rawText(percentilePick(0.9))).toContain("round(cnt * 0.90)");
    expect(rawText(percentilePick(0.95))).toContain("round(cnt * 0.95)");
  });

  it("keeps the max(1, …) clamp so a single-row partition still resolves", () => {
    expect(rawText(percentilePick(0.95))).toContain("max(1, cast(round(");
  });

  it("threads custom rn / cnt / value column names verbatim (slowest-tests p95)", () => {
    // slowest-tests ranks duration as "rnDur" and reads the value column
    // "durationMs"; the quoted identifiers must pass through unaltered.
    expect(
      rawText(
        percentilePick(0.95, {
          rn: `"rnDur"`,
          cnt: "cnt",
          value: `"durationMs"`,
        }),
      ),
    ).toBe(
      `min(case when "rnDur" = max(1, cast(round(cnt * 0.95) as integer)) then "durationMs" end)`,
    );
  });

  it("matches, byte-for-byte, the literal idiom the loaders previously inlined", () => {
    // The exact strings that lived at run-duration.server.ts:83-85 and 105-107.
    expect(rawText(percentilePick(0.5))).toBe(
      "min(case when rn = max(1, cast(round(cnt * 0.50) as integer)) then duration end)",
    );
    expect(rawText(percentilePick(0.9))).toBe(
      "min(case when rn = max(1, cast(round(cnt * 0.90) as integer)) then duration end)",
    );
    expect(rawText(percentilePick(0.95))).toBe(
      "min(case when rn = max(1, cast(round(cnt * 0.95) as integer)) then duration end)",
    );
  });
});

/**
 * `alignBuckets` is the single home of the SQL→JS left-join: build the empty
 * skeleton, then attach each SQL aggregate row to its slot via the FIXED join
 * key `bucketKey(row.bucket)`. It does not project — callers read their own
 * columns off `row` — so this only pins the join contract.
 */
describe("alignBuckets", () => {
  it("attaches each row to its matching skeleton slot, undefined for empty buckets", () => {
    const start = 100 * DAY_SEC;
    const now = 102 * DAY_SEC;
    // Rows for day 100 and 102; day 101 has no row. SQL day buckets come back
    // as JS numbers, so a numeric `bucket` must still match the String() key.
    const rows = [
      { bucket: 100, count: 5 },
      { bucket: 102, count: 9 },
    ];
    const aligned = alignBuckets("day", start, now, rows);

    expect(aligned.map((s) => s.key)).toEqual(["100", "101", "102"]);
    expect(aligned.map((s) => s.row?.count ?? null)).toEqual([5, null, 9]);
  });

  it("matches month rows whose bucket is already a YYYY-MM string", () => {
    const start = Math.floor(Date.UTC(2024, 0, 15) / 1000);
    const now = Math.floor(Date.UTC(2024, 2, 15) / 1000);
    const rows = [{ bucket: "2024-02", peak: 42 }];
    const aligned = alignBuckets("month", start, now, rows);

    expect(aligned.map((s) => s.key)).toEqual([
      "2024-01",
      "2024-02",
      "2024-03",
    ]);
    expect(aligned.map((s) => s.row?.peak ?? null)).toEqual([null, 42, null]);
  });

  it("preserves skeleton order regardless of row order", () => {
    const start = 10 * WEEK_SEC;
    const now = 12 * WEEK_SEC;
    const rows = [{ bucket: 12 }, { bucket: 10 }];
    const aligned = alignBuckets("week", start, now, rows);
    expect(aligned.map((s) => s.key)).toEqual(["10", "11", "12"]);
  });
});
