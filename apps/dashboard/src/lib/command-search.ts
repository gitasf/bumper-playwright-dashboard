import { and, or } from "void/db";
import { tests } from "@schema";
import { escapeLike, likeEscaped } from "@/lib/runs/filters-where";
import {
  childProjectScopeWhere,
  runScopeWhere,
  type TenantScope,
} from "@/lib/scope";

type SqlFragment = NonNullable<ReturnType<typeof and>>;

/**
 * WHERE-construction for the ⌘K command-menu search (roadmap 4.1c). Both halves
 * are pure (no DB) so the route's tenant-scoping is a unit-test surface — see
 * `command-search.test.ts`, which mirrors `export-where.test.ts`'s void/db-stub
 * idiom.
 *
 * The security invariant: EVERY query is project-scoped. Recent runs AND the
 * test search ALWAYS AND the scope predicate, so a project-A search can never
 * surface project-B rows. The branded `TenantScope` makes a raw-string
 * projectId untypeable here.
 */

/** Tenant predicate for the recent-runs group — the `runs` `(teamId, projectId)` pair. */
export function buildRecentRunsWhere(scope: TenantScope): SqlFragment {
  return runScopeWhere(scope);
}

/**
 * Tenant + search predicate for the test group: the `tests` catalog project
 * scope ANDed with a `title`/`file` substring match. Reads the identity table
 * (one row per test, trigram-indexed) rather than the `testResults` fact table,
 * so the search cost is bounded by suite size, not retained-result history.
 *
 * The term goes through {@link escapeLike} and the LIKEs carry `ESCAPE '\'`
 * ({@link likeEscaped}), so `%`/`_`/`\` in a search match literally — no
 * LIKE-metacharacter injection. A blank term yields the scope predicate alone.
 */
export function buildTestSearchWhere(
  scope: TenantScope,
  query: string,
): SqlFragment {
  const scopeClause = childProjectScopeWhere(tests.projectId, scope);
  const trimmed = query.trim();
  if (!trimmed) return scopeClause;

  const pattern = `%${escapeLike(trimmed)}%`;
  const match = or(
    likeEscaped(tests.title, pattern),
    likeEscaped(tests.file, pattern),
  );
  return match ? and(scopeClause, match)! : scopeClause;
}
