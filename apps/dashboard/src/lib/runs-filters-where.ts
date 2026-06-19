import { parseISO } from "date-fns";
import { and, eq, gte, inArray, like, lte, or, sql } from "void/db";
import { runs } from "@schema";
import type { RunsFilters } from "@/lib/runs-filters";
import { runScopeWhere, type TenantScope } from "@/lib/scope";

type SqlFragment = NonNullable<ReturnType<typeof and>>;
type LikeColumn = Parameters<typeof like>[0];

/**
 * Escape the LIKE wildcard metacharacters (`\`, `%`, `_`) in a user-supplied
 * search term so they match literally inside the `%…%` pattern this module
 * builds. Only meaningful when the consuming LIKE carries an `ESCAPE '\'`
 * clause — SQLite has NO default escape character, so a bare `like()` would
 * treat the inserted `\` as a literal byte and break the match. Always pair
 * with {@link likeEscaped}; both halves are unit-tested together
 * (`runs-filters-where.test.ts`).
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * `column LIKE ? ESCAPE '\'` — the only correct partner for a pattern built
 * with {@link escapeLike}. Drizzle's `like()` emits no ESCAPE clause and
 * SQLite defines no default escape character, so without this fragment a
 * search for `100%` compiled to `%100\%%`, which matches a literal backslash
 * followed by anything — i.e. effectively nothing.
 *
 * Uses `ILIKE` (Postgres case-insensitive LIKE) so the comparison is
 * case-insensitive, matching how the search box is expected to behave.
 */
export function likeEscaped(column: LikeColumn, pattern: string) {
  return sql`${column} ilike ${pattern} escape '\\'`;
}

/**
 * Build a Drizzle `WHERE` clause from the filter-bar state. The tenant scope
 * is the caller's responsibility — `scopedRunsWhere` below ANDs this function's
 * output with the scope predicate from `runScopeWhere`.
 *
 * Timestamps are stored as unix seconds; date-range filters convert the ISO
 * YYYY-MM-DD bounds to seconds at the UTC day boundary.
 */
export function buildRunsWhere(filters: RunsFilters): SqlFragment | undefined {
  const clauses: SqlFragment[] = [];

  if (filters.status.length > 0) {
    clauses.push(inArray(runs.status, filters.status));
  }
  if (filters.branch.length > 0) {
    clauses.push(inArray(runs.branch, filters.branch));
  }
  if (filters.actor.length > 0) {
    clauses.push(inArray(runs.actor, filters.actor));
  }
  if (filters.environment.length > 0) {
    clauses.push(inArray(runs.environment, filters.environment));
  }
  if (filters.from) {
    const fromSeconds = Math.floor(
      parseISO(`${filters.from}T00:00:00.000Z`).getTime() / 1000,
    );
    clauses.push(gte(runs.createdAt, fromSeconds));
  }
  if (filters.to) {
    const toSeconds = Math.floor(
      parseISO(`${filters.to}T23:59:59.999Z`).getTime() / 1000,
    );
    clauses.push(lte(runs.createdAt, toSeconds));
  }
  if (filters.q) {
    const pattern = `%${escapeLike(filters.q)}%`;
    const orClause = or(
      likeEscaped(runs.commitMessage, pattern),
      likeEscaped(runs.commitSha, pattern),
      likeEscaped(runs.branch, pattern),
    );
    if (orClause) clauses.push(orClause);
  }
  // Default view excludes synthetic monitor traffic — a 1-minute monitor mints
  // 1,440 runs/day, which would otherwise drown the CI history. `all` drops
  // the clause; `synthetic` flips the view to monitor runs only.
  if (filters.origin !== "all") {
    clauses.push(eq(runs.origin, filters.origin));
  }

  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : and(...clauses);
}

/**
 * Convenience helper that combines the tenant scope predicate with the
 * filter clauses so call sites don't have to. Returns a single Drizzle
 * SqlFragment fragment suitable for `.where(...)`.
 *
 * Takes a `TenantScope` (not raw `teamId`/`projectId` strings) so the brand
 * stays load-bearing all the way to the WHERE clause — the scope half of the
 * predicate is delegated to {@link runScopeWhere}, the single owner of the
 * `runs` `(teamId, projectId)` shape.
 */
export function scopedRunsWhere(
  scope: TenantScope,
  filters: RunsFilters,
): SqlFragment {
  const scopeClause = runScopeWhere(scope);
  const filterClause = buildRunsWhere(filters);
  return filterClause ? and(scopeClause, filterClause)! : scopeClause;
}
