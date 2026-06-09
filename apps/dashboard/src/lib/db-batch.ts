import { db } from "void/db";

/**
 * Atomicity-preserving wrapper over Drizzle's `db.batch`.
 *
 * D1's batch runs every statement inside a single transaction on the writer
 * node — that all-or-nothing guarantee is durable decision #10 and is owned by
 * the call sites that assemble the batch (`ingest.ts` documents it as its
 * atomicity boundary; the settings/invite mutations rely on it to avoid
 * half-applied deletes/creates). This module does NOT own that decision; it
 * owns only the *type ergonomics* of the call.
 *
 * Drizzle types `db.batch` as a heterogeneous tuple of query builders
 * (`BatchItem[]`). Callers that build the batch dynamically — pushing a mix of
 * insert/update/delete builders into a `PromiseLike<unknown>[]` or assembling a
 * literal tuple whose element types Drizzle can't unify — cannot satisfy that
 * tuple type, so every call site reached for an `as never` cast to get past it.
 * That cast was copy-pasted at 7 batch call sites across 6 files, each an
 * un-narrowed type hole.
 *
 * `runBatch` confines that single unavoidable cast here: callers pass a plain
 * `PromiseLike<unknown>[]` (the same runtime shape — every element is a thenable
 * Drizzle query) and never cast themselves.
 *
 * Out of scope (stated honestly so the helper isn't oversold): the *per-element*
 * `as never` casts inside `buildResultInsertStatements` come from the array
 * ELEMENT type when pushing heterogeneous builders into `PromiseLike<unknown>[]`,
 * not from the `db.batch` call signature — `runBatch` does not remove those. The
 * `<=99`-param chunking discipline stays in `chunkByParams` / `chunkInsertRows`
 * (ingest.ts); this helper does not touch it. The summary-returning batch
 * (read-back of the final `.returning()` row) is owned by `runBatchWithSummary`
 * in ingest.ts.
 */
export async function runBatch(
  statements: PromiseLike<unknown>[],
): Promise<readonly unknown[]> {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- db.batch's heterogeneous-tuple signature can't be satisfied by a dynamic array; the single confined launder (see file doc)
  return (await db.batch(statements as never)) as readonly unknown[];
}
