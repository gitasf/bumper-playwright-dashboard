import { sql } from "void/db";
import type { Segment } from "./bucketing";
import { assertSqlIdentifier } from "./sql-identifier";

/** Drizzle `SQL` fragment — the exact return type of `sql\`…\`` template literal. */
export type SqlBucketExpr = ReturnType<typeof sql<number | string>>;

/**
 * A table-qualified column fragment accepted by {@link bucketExpr}, e.g.
 * `sql\`runs."createdAt"\`` or `sql\`tr."createdAt"\``. Widened from
 * {@link SqlBucketExpr} so an untyped `sql\`…\`` literal assigns without a cast.
 */
export type SqlColumnRef = ReturnType<typeof sql>;

/**
 * Default timestamp column the bucket expression divides — the runs table's
 * `createdAt`, used by every run-scoped insights loader (index / run-duration /
 * suite-size). Callers bucketing a different table (e.g. slowest-tests'
 * sparkline over `testResults`) pass their own column fragment.
 *
 * It is a `sql` *fragment* (not an interpolated value) so it renders as raw
 * identifier text, not a bound parameter — see the divisor note below.
 */
const RUNS_CREATED_AT: SqlColumnRef = sql`runs."createdAt"`;

/**
 * Bucket-expression for SQL aggregation. Returns a Drizzle `SQL` fragment
 * usable in `.select({ bucket: expr })` and `.groupBy(expr)`.
 *
 * The timestamp column is parameterized via `col` (default: `runs."createdAt"`)
 * so the same day/week/month bucketing — and, crucially, the text-affinity
 * caveat below — lives in exactly one place across both the run-scoped loaders
 * and any other table that needs a unix-second bucket (e.g. the slowest-tests
 * sparkline over `testResults`).
 *
 * Divisors are inlined as literals — D1's bound-parameter pipeline applies
 * text affinity to numeric params, which can silently turn integer division
 * into string concatenation. Matches the same pattern the rwsdk version
 * used against the DO-SQLite driver. (The day/week divisors here intentionally
 * stay raw SQL text, not the {@link DAY_SEC}/{@link WEEK_SEC} JS constants
 * interpolated in, for exactly this reason — interpolating them would re-bind
 * them as params. The `bucketing.test.ts` parity test pins the two sides
 * together.)
 *
 * `col` is interpolated as a `sql` fragment so it renders as raw identifier
 * text, not a bound param; pass `sql\`tr."createdAt"\`` and friends, never a
 * bare value.
 */
export function bucketExpr(
  segment: Segment,
  col: SqlColumnRef = RUNS_CREATED_AT,
): SqlBucketExpr {
  // Day/week buckets are integer division of a non-negative unix epoch by a
  // constant (the divisor stays inlined raw text — see the text-affinity note
  // above). The month bucket can't be fixed-second division, so it uses
  // `to_char(to_timestamp(ts) AT TIME ZONE 'UTC', 'YYYY-MM')`. `to_timestamp`
  // returns a `timestamptz` that `to_char` would otherwise render in the session
  // TimeZone; the `AT TIME ZONE 'UTC'` pin labels in UTC instead, matching the
  // JS skeleton (`buildEmptyBuckets` uses getUTC*) so `bucketing.ts` stays
  // timezone-agnostic.
  if (segment === "day") return sql<number | string>`${col} / 86400`;
  if (segment === "week") return sql<number | string>`${col} / 604800`;
  return sql<
    number | string
  >`to_char(to_timestamp(${col}) AT TIME ZONE 'UTC', 'YYYY-MM')`;
}

/** Column names a {@link percentilePick} reads off the upstream ranked CTE. */
export interface PercentilePickCols {
  /** `row_number()` column, ordered ASC by the value being percentile'd. */
  rn?: string;
  /** `count(*) over (…)` column over the SAME partition as `rn`. */
  cnt?: string;
  /** The value column whose percentile is selected (e.g. a duration). */
  value?: string;
}

/**
 * Discrete-percentile picker over a pre-ranked CTE.
 *
 * Emits the fiddly, correctness-sensitive idiom
 * `min(case when <rn> = greatest(1, cast(round(<cnt> * q) as integer)) then <value> end)`
 * once, so callers don't re-state it per pick. It selects the value at the
 * discrete rank `round(cnt * q)`, clamped to `[1..cnt]` by the `greatest(1, …)`
 * (Postgres's scalar max — bare 2-arg `max` is SQLite-only) so a single-row
 * partition still resolves (rank 0 would never match `rn`).
 *
 * UPSTREAM INVARIANT — the caller's CTE must define, over one partition:
 *   - `<rn>` = `row_number() over (partition by … order by <value>)` (ASC), and
 *   - `<cnt>` = `count(*) over (partition by …)` over that SAME partition.
 * The picker can't see the CTE, so this contract is the caller's to uphold.
 *
 * The quantile and column names are inlined as raw SQL — not bound params —
 * for the same reason {@link bucketExpr} inlines its divisors: D1's
 * bound-parameter pipeline applies text affinity to numeric params, which would
 * corrupt the arithmetic. The quantile is rendered to two decimals to keep the
 * emitted literal stable (e.g. `0.50`, `0.95`).
 *
 * @param quantile  fraction in (0, 1], e.g. `0.95` for p95.
 * @param cols      column names on the ranked CTE; defaults match the
 *                  run-duration loader (`rn` / `cnt` / `duration`).
 */
export function percentilePick(
  quantile: number,
  cols: PercentilePickCols = {},
): SqlBucketExpr {
  const rn = assertSqlIdentifier(cols.rn ?? "rn");
  const cnt = assertSqlIdentifier(cols.cnt ?? "cnt");
  const value = assertSqlIdentifier(cols.value ?? "duration");
  const q = quantile.toFixed(2);
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- retypes sql.raw's `SQL<unknown>` to the bucket-expr generic; column refs are guarded (assertSqlIdentifier) and the raw text stays byte-for-byte (a `sql\`${raw}\`` wrapper would change the emitted SQL)
  return sql.raw(
    `min(case when ${rn} = greatest(1, cast(round(${cnt} * ${q}) as integer)) then ${value} end)`,
  ) as SqlBucketExpr;
}
