import { and, eq, ne, sql } from "void/db";
import { runs, testResults } from "@schema";
import { escapeLike } from "@/lib/runs-filters-where";
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
 * this needs `runs` for its branch filter or a `runs.createdAt` window.
 * Raw-SQL passes that don't need the tenant WHERE built in (flaky's sparkline,
 * suite-size's tests-added) pair {@link ciRunsJoinFragment} with their own
 * predicate instead — the join text (and its synthetic exclusion) must stay
 * identical between the two.
 */
export function testResultsScopeJoin(scope: TenantScope): SqlFilterFragment {
  // `origin <> 'synthetic'` keeps monitor traffic out of every analytics
  // surface that routes through this join (tests catalog, flaky, insights):
  // a 1-minute monitor writes 1,440 runs/day of testResults that would skew
  // flakiness/duration aggregates computed over CI history.
  return sql`inner join runs on runs.id = tr."runId" and runs.origin <> 'synthetic'
      where tr."projectId" = ${scope.projectId}`;
}

/**
 * The runs-table sibling of {@link testResultsScopeJoin}, for the percentile
 * loaders (run-duration) that aggregate over `runs` DIRECTLY rather than
 * `testResults`→`runs`. Emits `where runs."projectId" = ? and runs."teamId" = ?
 * and runs.origin <> 'synthetic'`.
 *
 * Before this fragment existed there was no member of the CI-scope family for
 * the raw-SQL runs-table case, so run-duration hand-rolled the predicate and
 * bound `projectId` ALONE — dropping the `(teamId, projectId)` pair every other
 * runs reader carries via the branded `runScopeWhere`/`ciRunsScopeWhere` in
 * `scope.ts`. That's not exploitable (`runs.id` is a unique ULID PK) but it sat
 * OUTSIDE the brand the `AuthorizedProjectId`/`AuthorizedTeamId` design exists
 * to enforce. Both ids are BOUND parameters off the branded {@link TenantScope}
 * (so a raw `string` can't reach the loader and the team half can't be silently
 * dropped). Like {@link testResultsScopeJoin} it emits the leading
 * `where … and runs.origin <> 'synthetic'`; callers continue the WHERE with
 * `and …` fragments (duration filter, time window, branch).
 */
export function ciRunsScopeRawWhere(scope: TenantScope): SqlFilterFragment {
  return sql`where runs."projectId" = ${scope.projectId} and runs."teamId" = ${scope.teamId} and runs.origin <> 'synthetic'`;
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
 * Unconditional `testResults`→`runs` join for raw-SQL analytics passes, with
 * the CI-analytics policy clause (`runs.origin <> 'synthetic'`) baked into the
 * ON clause — the same join {@link testResultsScopeJoin} opens with, minus the
 * tenant WHERE (callers that build their own predicate use this).
 *
 * Replaces the old `branchJoinFragment(branch)`, which only joined `runs` when
 * a branch filter was active. That conditionality was a perf nicety (skip a PK
 * probe when `runs` wasn't referenced) that became a correctness hole once the
 * synthetic exclusion moved into the join: every analytics pass needs `runs`
 * now, branch filter or not, or monitor traffic leaks into the aggregates
 * (e.g. monitor tests ranking on the flaky page). Pair it with
 * `${branchFragment(branch)}` in the WHERE clause as before.
 */
export function ciRunsJoinFragment(): SqlFilterFragment {
  return sql`inner join runs on runs.id = tr."runId" and runs.origin <> 'synthetic'`;
}

/** A non-undefined Drizzle condition, suitable for `.innerJoin(runs, …)`. */
type JoinCondition = NonNullable<ReturnType<typeof and>>;

/**
 * {@link ciRunsJoinFragment} for query-builder passes: the ON condition for an
 * unconditional `.innerJoin(runs, ciRunsJoinOn())` from `testResults`, with the
 * same synthetic-traffic exclusion. Used by the Drizzle-built aggregates that
 * previously joined `runs` only when a branch filter was active (flaky's
 * ranking pass, suite-size's file/tag distributions) — same correctness story
 * as the raw-SQL fragment above.
 */
export function ciRunsJoinOn(): JoinCondition {
  return and(eq(runs.id, testResults.runId), ne(runs.origin, "synthetic"))!;
}

/**
 * Optional `and (tr.title like <pattern> or tr.file like <pattern>)` predicate
 * for the test-catalog search box (tests / slowest-tests). Takes the raw,
 * already-trimmed search term; a falsy term yields an empty fragment.
 *
 * The term goes through `escapeLike` and the LIKEs carry `ESCAPE '\'`, so
 * `%`/`_`/`\` in a search match literally — the same semantics as the runs
 * list search (`@/lib/runs-filters-where`), which previously diverged (this
 * fragment used to pass wildcards through raw). Emitted as a BOUND parameter.
 */
export function searchFragment(query: string | null): SqlFilterFragment {
  if (!query) return sql``;
  const pattern = `%${escapeLike(query)}%`;
  // `ILIKE` (Postgres case-insensitive LIKE) so the test-catalog search is
  // case-insensitive.
  return sql`and (tr.title ilike ${pattern} escape '\\' or tr.file ilike ${pattern} escape '\\')`;
}

/**
 * Optional `and exists (… testTags …)` predicate for the test-catalog tag
 * filter: keep only tests that carry ANY of `tags` on at least one of their
 * results. An empty list yields an empty fragment so it drops out of the
 * surrounding WHERE.
 *
 * Correlates on `tr.id` (the testResults row), so D1 seeks the tag rows for
 * each candidate via `testTags_testResultId_idx`. Each tag is a BOUND parameter
 * (`sql\`${t}\``) — never interpolated — so the filter is injection-safe like
 * its sibling fragments. ANY-match (`tag in (…)`) rather than ALL: selecting two
 * tags broadens the catalog, matching how list filters conventionally behave.
 */
export function tagFragment(tags: readonly string[]): SqlFilterFragment {
  if (tags.length === 0) return sql``;
  const list = sql.join(
    tags.map((t) => sql`${t}`),
    sql`, `,
  );
  return sql`and exists (select 1 from "testTags" tt where tt."testResultId" = tr.id and tt.tag in (${list}))`;
}
