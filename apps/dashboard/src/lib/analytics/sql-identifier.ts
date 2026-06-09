/**
 * Defense-in-depth guard for SQL identifiers spliced into `sql.raw(...)` by the
 * analytics fragment builders (`per-test.ts`, `bucketing-sql.ts`).
 *
 * Those builders inline column/alias names as RAW SQL text rather than bound
 * parameters — D1's bound-parameter pipeline applies text affinity that corrupts
 * identifiers and the percentile/window arithmetic (see `bucketExpr`). That makes
 * the identifier arguments injection-prone *by construction*: a caller that ever
 * passed request-derived input as a column name would open a hole.
 *
 * Every current caller passes in-code string literals, so there is no live
 * vulnerability. This guard turns that "callers must only pass literals"
 * convention into an enforced invariant: it rejects anything that isn't a bare,
 * double-quoted, or table-qualified identifier (letters, digits, `_`, `.`, `"`),
 * so a value carrying spaces, parens, commas, or string quotes — i.e. an
 * injection payload — throws instead of reaching the database.
 *
 * It is NOT a general SQL sanitizer; it whitelists the exact identifier shapes
 * the analytics builders use (`status`, `tr."testId"`, `"latestRunId"`, …).
 */
const SAFE_SQL_IDENTIFIER = /^[\w".]+$/;

export function assertSqlIdentifier(identifier: string): string {
  if (!SAFE_SQL_IDENTIFIER.test(identifier)) {
    throw new Error(`unsafe SQL identifier: ${JSON.stringify(identifier)}`);
  }
  return identifier;
}
