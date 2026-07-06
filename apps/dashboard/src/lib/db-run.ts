import { db, sql } from "void/db";
import { buildTagComment, type QueryTags } from "@/lib/db/query-tags";

/** A raw Drizzle SQL query — the `sql\`…\`` tagged-template result. */
type SqlQuery = ReturnType<typeof sql>;

export type { QueryTags };

/**
 * Append an opt-in SQLCommenter tag comment to a raw query for PlanetScale
 * Query Insights / Traffic Control attribution. No tags → the query is returned
 * unchanged (byte-for-byte), so untagged call sites are unaffected. See
 * `src/lib/db/query-tags.ts` for the tag policy and why only the raw-SQL
 * boundary is tagged.
 */
function withTags(query: SqlQuery, tags: QueryTags | undefined): SqlQuery {
  if (!tags) return query;
  return sql`${query} ${sql.raw(buildTagComment(tags))}`;
}

/**
 * Typed-row wrapper over Postgres's raw-SQL executor.
 *
 * The analytics/insights loaders issue hand-written `sql` queries (window
 * functions, percentiles, dynamic `in (…)` lists) that Drizzle's query builder
 * can't express. node-postgres / pglite return rows via `db.execute(sql)` →
 * `{ rows }`. Callers pass the query and row type; the SELECT's column list is
 * the caller's contract (not validated at runtime).
 *
 * Pass `tags` to attribute the query in PlanetScale Insights (opt-in; see
 * {@link QueryTags}).
 */
export async function runRows<T>(
  query: SqlQuery,
  tags?: QueryTags,
): Promise<T[]> {
  const { rows } = await db.execute(withTags(query, tags));
  return (rows as T[] | undefined) ?? [];
}

/**
 * {@link runRows} for a query expected to return at most one row; returns the
 * first row or `undefined`.
 */
export async function runRow<T>(
  query: SqlQuery,
  tags?: QueryTags,
): Promise<T | undefined> {
  return (await runRows<T>(query, tags))[0];
}
