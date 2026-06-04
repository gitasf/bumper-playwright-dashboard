import { sql } from "void/db";
import type { TenantScope } from "@/lib/scope";

/** Drizzle `SQL` fragment — the exact return type of a `sql\`…\`` template literal. */
export type SqlFilterFragment = ReturnType<typeof sql>;

/**
 * The `testResults`→`runs` scope-join + tenant predicate the raw-SQL analytics
 * loaders all open with: `inner join runs on runs.id = tr."runId"` followed by
 * `where tr."projectId" = <projectId>`. This exact pair was hand-rebuilt at ~8
 * call sites across tests / slowest-tests / flaky — the most-smeared raw-SQL
 * idiom in the analytics loaders, and the one with the highest blast radius: a
 * dropped or misspelled `tr."projectId"` predicate is a cross-tenant data leak
 * that the raw `db.run(sql\`\`)` path hides from Drizzle's type checker.
 *
 * Concentrating it here makes the tenant boundary impossible to omit by accident
 * AND enforces the F13/scope.ts invariant — the parameter is a branded
 * {@link TenantScope}, so a raw `string` projectId can no longer reach a loader;
 * the auth-checked `scope.projectId` is the only thing that types. The id is
 * emitted as a BOUND parameter (`sql\`${scope.projectId}\``), never interpolated.
 *
 * Emits the join clause AND the leading `where tr."projectId" = ?` so callers
 * continue the WHERE with `and …` fragments (time window, branch, search,
 * testId-IN). The `runs` join is unconditional here — every caller that uses
 * this needs `runs` for its branch filter or a `runs.createdAt` window. The
 * sparkline pass in flaky.server.ts, which omits the join when no branch filter
 * is active, keeps its own {@link branchJoinFragment} pairing instead.
 */
export function testResultsScopeJoin(scope: TenantScope): SqlFilterFragment {
  return sql`inner join runs on runs.id = tr."runId"
      where tr."projectId" = ${scope.projectId}`;
}

/**
 * Optional `and runs.branch = <branch>` predicate for the raw-SQL analytics
 * loaders (tests / slowest-tests / run-duration / flaky). A `null` branch — the
 * "all branches" case, already normalized by `parseBranchParam` — yields an
 * empty fragment so it drops out of the surrounding `where … ${branchFragment}`.
 *
 * The branch value is emitted as a BOUND parameter (`sql\`${branch}\``), never
 * string-interpolated, so it stays injection-safe. This is the single home for
 * the `branch ? sql\`and runs.branch = ${branch}\` : sql\`\`` ternary that was
 * copy-pasted across the raw-SQL loaders.
 */
export function branchFragment(branch: string | null): SqlFilterFragment {
  return branch ? sql`and runs.branch = ${branch}` : sql``;
}

/**
 * Conditional `inner join runs` for queries that only need the `runs` table to
 * filter by branch (flaky's sparkline pass). When no branch filter is active
 * the join is omitted entirely — the query reads `testResults` alone.
 *
 * Sibling to {@link branchFragment}: pair `${branchJoinFragment(branch)}` in the
 * FROM clause with `${branchFragment(branch)}` in the WHERE clause.
 */
export function branchJoinFragment(branch: string | null): SqlFilterFragment {
  return branch ? sql`inner join runs on runs.id = tr."runId"` : sql``;
}

/**
 * Optional `and (tr.title like <pattern> or tr.file like <pattern>)` predicate
 * for the test-catalog search box (tests / slowest-tests). Takes the raw,
 * already-trimmed search term; a falsy term yields an empty fragment.
 *
 * Wraps the term in `%…%` and emits it as a BOUND parameter, mirroring the
 * `pattern ? sql\`…\` : sql\`\`` ternary the two loaders shared. Callers no
 * longer build the `%${q}%` pattern themselves.
 */
export function searchFragment(query: string | null): SqlFilterFragment {
  if (!query) return sql``;
  const pattern = `%${query}%`;
  return sql`and (tr.title like ${pattern} or tr.file like ${pattern})`;
}
