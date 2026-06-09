import { db } from "void/db";

/**
 * Typed-row wrapper over Drizzle's `db.run(sql\`…\`)`.
 *
 * The analytics/insights loaders issue hand-written `sql` queries (window
 * functions, percentiles, dynamic `in (…)` lists) that Drizzle's query builder
 * can't express, so they go through `db.run`. D1 hands those rows back untyped —
 * `db.run(...).results` is `unknown[]` — so every call site reached for a
 * `result.results as Row[]` cast to name the SELECT's column shape. That cast
 * was copy-pasted across ~15 loaders, each an un-narrowed type hole.
 *
 * `runRows` confines that single unavoidable raw-SQL → row-shape cast here
 * (mirroring `runBatch` in `db-batch.ts`): callers pass the query and the row
 * type, and never assert themselves. The SELECT's column list remains the
 * caller's contract — this helper does NOT validate the shape at runtime; it
 * only centralizes the type assertion the raw-SQL boundary forces.
 */
export async function runRows<T>(
  query: Parameters<typeof db.run>[0],
): Promise<T[]> {
  const { results } = await db.run(query);
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- raw-SQL row-shape boundary; the single confined home for this cast (see above)
  return (results as T[] | undefined) ?? [];
}

/**
 * {@link runRows} for a query expected to return at most one row; returns the
 * first row or `undefined`.
 */
export async function runRow<T>(
  query: Parameters<typeof db.run>[0],
): Promise<T | undefined> {
  return (await runRows<T>(query))[0];
}
