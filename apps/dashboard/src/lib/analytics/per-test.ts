import { sql } from "void/db";
import type { SqlFilterFragment } from "./filters";
import { assertSqlIdentifier } from "./sql-identifier";

/**
 * The "latest result per test" + per-test status-counter idioms, concentrated.
 *
 * Three analytics loaders (tests / slowest-tests / flaky) hand-write multi-CTE
 * raw SQL that recurs verbatim in two error-prone ways:
 *
 *   1. A `row_number() over (partition by <testId> order by <createdAt> desc)`
 *      window to pick the LATEST row per test (its title/file/status/runId).
 *      Re-stated across tests.server.ts (`runAggregateQuery`),
 *      flaky.server.ts (`loadSparklinesAndMeta`, `loadRecentFailures`).
 *   2. Per-test `sum(case when status = … then 1 else 0 end)` counters whose
 *      "fail" definition (`status in ('failed','timedout')`) and "flaky"
 *      definition were maintained by eye across tests.server.ts and
 *      slowest-tests.server.ts.
 *
 * A maintainer changing how "latest per test" or "flaky vs failed" is computed
 * previously had to find and edit 4-6 separate SQL string literals and keep
 * them consistent. These builders give the two idioms a single owner.
 *
 * They are SQL *fragments*, not full queries: the loaders still own their CTE
 * shapes (rnDur vs rnTime, the columns they project, their join/where clauses),
 * which genuinely differ. Returning fragments rather than `db`-bound queries
 * also keeps the canonical definitions unit-testable under the void/db stub —
 * the real-DB query harness is outstanding, so a copy-lift of the whole query
 * couldn't be tested today.
 */

/**
 * The `row_number() over (partition by <testIdCol> order by <orderByCol> desc)`
 * window expression — the ranked-CTE ordering that picks the LATEST row per
 * test. The caller supplies the partition + order columns and the output alias,
 * because the three call sites differ on all three:
 *
 *   - tests.server.ts: `partition by tr."testId" order by tr."createdAt"` → `"rnTime"`
 *   - flaky sparkline / recent-failures: same columns → `rn`
 *
 * Column refs are emitted as raw SQL identifiers (`sql.raw`), never bound
 * params — D1's bound-parameter pipeline applies text affinity that would
 * corrupt an identifier, the same reason `bucketExpr` inlines its divisors.
 * Pass already-quoted, table-qualified identifiers (e.g. `tr."testId"`).
 *
 * @param alias       output column name (e.g. `"rnTime"`, `rn`).
 * @param opts.testIdCol    partition column (default `tr."testId"`).
 * @param opts.orderByCol   recency column ordered DESC (default `tr."createdAt"`).
 */
export function latestPerTestRn(
  alias: string,
  opts: { testIdCol?: string; orderByCol?: string } = {},
): SqlFilterFragment {
  const { testIdCol = 'tr."testId"', orderByCol = 'tr."createdAt"' } = opts;
  // `row_number()` is `int8` on Postgres, which node-postgres returns as a
  // STRING (pglite returns a number, hiding this in the fast test lane);
  // casting to `int4` (`cast(… as integer)`, same idiom as `statusCounter`
  // below) makes both drivers hand back a JS number. Load-bearing for
  // flaky.server.ts's `loadSparklinesAndMeta`, which reads the alias back in
  // JS and does `r.rn === 1` — that strict compare is silently dead on real
  // pg without this cast. A per-test rank comfortably fits int4.
  return sql.raw(
    `cast(row_number() over (partition by ${assertSqlIdentifier(testIdCol)} order by ${assertSqlIdentifier(orderByCol)} desc) as integer) as ${assertSqlIdentifier(alias)}`,
  ) as SqlFilterFragment;
}

/**
 * The reader half of the ranked-CTE "latest row per test" idiom:
 * `max(case when "rnTime" = 1 then <col> end)`, optionally aliased. Pairs with
 * {@link latestPerTestRn}, which emits the `row_number() … as "rnTime"` window
 * the picker reads back. Both the tests catalog (`runAggregateQuery`, 5 picks)
 * and slowest-tests (`bottlenecks`, 4 picks) project the latest title / file /
 * status / runId / testResultId this way; the `rn = 1` rank-of-latest convention
 * (mirroring `latestPerTestRn`'s DESC ordering) now has one owner instead of
 * being re-typed per projected column.
 *
 * Emitted as raw SQL — the column and alias are SQL identifiers, not user input
 * or bound params, matching the text the loaders inlined. The default rank
 * column `"rnTime"` matches the alias both loaders pass to `latestPerTestRn`.
 *
 * @param col          the ranked-CTE column to read at the latest row (e.g.
 *                     `title`, `"runId"`). Pass already-quoted identifiers.
 * @param opts.alias   optional output column name (e.g. `"latestRunId"`).
 * @param opts.rnCol   the `row_number()` alias to gate on (default `"rnTime"`).
 */
export function latestPerTestValue(
  col: string,
  opts: { alias?: string; rnCol?: string } = {},
): SqlFilterFragment {
  const { alias, rnCol = `"rnTime"` } = opts;
  const expr = `max(case when ${assertSqlIdentifier(rnCol)} = 1 then ${assertSqlIdentifier(col)} end)`;
  return sql.raw(
    alias ? `${expr} as ${assertSqlIdentifier(alias)}` : expr,
  ) as SqlFilterFragment;
}

/** The four canonical per-test status buckets. */
export type StatusCounterKind = "passed" | "flaky" | "fail" | "skipped";

/**
 * Single canonical SQL predicate for each status bucket — the one place
 * "fail" means `status in ('failed','timedout')` and "flaky" means
 * `status = 'flaky'`. Reading off a `status` column that may be either the
 * bare identifier (`status`, after a CTE projection) or a table-qualified one
 * (`tr.status`), parameterized via `statusCol`.
 */
function statusPredicate(kind: StatusCounterKind, statusCol: string): string {
  switch (kind) {
    case "passed":
      return `${statusCol} = 'passed'`;
    case "flaky":
      return `${statusCol} = 'flaky'`;
    case "fail":
      return `${statusCol} in ('failed','timedout')`;
    case "skipped":
      return `${statusCol} = 'skipped'`;
  }
}

/**
 * A per-test status counter: `sum(case when <predicate> then 1 else 0 end)`,
 * optionally aliased. The canonical "fail"/"flaky"/etc. definitions live in
 * {@link statusPredicate}, so changing flaky-vs-failed semantics is a one-line
 * edit here instead of an N-literal hunt across the loaders.
 *
 * Emitted as raw SQL (status values are SQL literals, not user input), matching
 * the `sum(case when status = '…' …)` text the loaders inlined.
 *
 * @param kind         which status bucket to count.
 * @param opts.alias   optional output column name (e.g. `"failCount"`).
 * @param opts.statusCol  the status column to read (default `status`, i.e. a
 *                        CTE-projected column; pass `tr.status` to read the
 *                        joined table directly).
 */
export function statusCounter(
  kind: StatusCounterKind,
  opts: { alias?: string; statusCol?: string } = {},
): SqlFilterFragment {
  const { alias, statusCol = "status" } = opts;
  const predicate = statusPredicate(kind, assertSqlIdentifier(statusCol));
  // `cast(… as integer)`: `sum(int)` is `int8` on Postgres, which node-postgres
  // returns as a STRING; casting to `int4` makes BOTH drivers parse it to a JS
  // number. (These counters run through the raw `runRows` path, which bypasses
  // Drizzle's field decoders — so the cast must be in SQL, not `.mapWith`.)
  // Per-test status counts comfortably fit int4.
  const expr = `cast(sum(case when ${predicate} then 1 else 0 end) as integer)`;
  return sql.raw(
    alias ? `${expr} as ${assertSqlIdentifier(alias)}` : expr,
  ) as SqlFilterFragment;
}
