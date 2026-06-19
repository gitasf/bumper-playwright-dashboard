import { db, sql } from "void/db";

/** A raw Drizzle SQL query — the `sql\`…\`` tagged-template result. */
type SqlQuery = ReturnType<typeof sql>;

/**
 * Typed-row wrapper over Postgres's raw-SQL executor.
 *
 * The analytics/insights loaders issue hand-written `sql` queries (window
 * functions, percentiles, dynamic `in (…)` lists) that Drizzle's query builder
 * can't express. node-postgres / pglite return rows via `db.execute(sql)` →
 * `{ rows }`. Callers pass the query and row type; the SELECT's column list is
 * the caller's contract (not validated at runtime).
 */
export async function runRows<T>(query: SqlQuery): Promise<T[]> {
  const { rows } = await db.execute(query);
  return (rows as T[] | undefined) ?? [];
}

/**
 * {@link runRows} for a query expected to return at most one row; returns the
 * first row or `undefined`.
 */
export async function runRow<T>(query: SqlQuery): Promise<T | undefined> {
  return (await runRows<T>(query))[0];
}
