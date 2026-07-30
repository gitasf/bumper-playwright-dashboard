/**
 * Fixed-size and bound-parameter-aware chunking for multi-row Postgres writes.
 *
 * This lives beside `db/batch.ts` rather than inside the ingest pipeline because
 * nothing here is ingest-specific: retention sweeps, artifact deletes, and the
 * stale-run watchdog all chunk for the same reason. Keeping it here means those
 * callers no longer pull the whole ingest graph (realtime publish, owners-repo,
 * github run surfaces, usage metering) just to obtain a chunk size.
 */

/**
 * Postgres's per-statement bound-parameter ceiling (65535). Drives multi-row
 * insert chunk size: each statement in a `db.transaction` is its own round-trip,
 * so the large ceiling keeps a big flush to a couple of statements (~4600 rows
 * each) rather than hundreds of round-trips.
 */
export const PG_MAX_BOUND_PARAMS = 65_535;

/**
 * Slice `items` into consecutive sub-arrays of at most `size` (always a finite
 * integer ≥1, so a pathological `size <= 0` still makes progress one item at a
 * time rather than looping forever). The single home for fixed-size chunking —
 * both the param-cap chunker ({@link chunkByParams}) and the watchdog's
 * bounded-concurrency drain (`drainStaleRuns`) compute their per-chunk count and
 * hand it here.
 *
 * `NaN` normalizes to 1 rather than falling through `Math.max`, which returns
 * `NaN` and makes the loop's first comparison false — yielding zero chunks for
 * a non-empty input, so every row the caller meant to write is dropped with no
 * error. A degenerate size should be slow, never silent.
 */
export function chunkBySize<T>(items: T[], size: number): T[][] {
  const step = Number.isFinite(size) ? Math.max(1, Math.floor(size)) : 1;
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += step) {
    chunks.push(items.slice(i, i + step));
  }
  return chunks;
}

/**
 * Split `rows` into sub-arrays whose `.values(chunk)` multi-row insert stays
 * under Postgres's per-statement parameter ceiling, given the number of columns
 * each row binds. Hides the `Math.floor(maxParams / columnsPerRow)` arithmetic
 * behind one call so the cap lives in exactly one place.
 *
 * Prefer {@link chunkInsertRows} for real inserts — it derives `columnsPerRow`
 * from the row shape so the count can't drift from the row literal. This
 * lower-level form is kept for the unit test that asserts the chunking math
 * directly, and for callers that know their column count without a row in hand.
 */
export function chunkByParams<T>(
  rows: T[],
  columnsPerRow: number,
  maxParams: number = PG_MAX_BOUND_PARAMS,
): T[][] {
  return chunkBySize(rows, Math.floor(maxParams / columnsPerRow));
}

/**
 * Chunk insert rows for a multi-row `db.insert(table).values(chunk)`, deriving
 * the per-row column count from the row object itself (`Object.keys(row).length`)
 * — the SAME object that is handed to `.values()`. There is therefore no
 * separate hand-counted column constant that can silently drift from the row
 * shape when a column is added (the classic footgun: a nullable column makes
 * `$inferInsert` optional, so it lands in the row literal with no compile error,
 * and a stale literal count would then pack rows past Postgres's per-statement
 * bound-param ceiling and the statement would be rejected at runtime).
 *
 * Every row in a batch binds the same columns (they all flow through one
 * builder), so the first row's key count governs the whole array. An empty array
 * has nothing to bind and returns no chunks.
 */
export function chunkInsertRows<T extends Record<string, unknown>>(
  rows: T[],
): T[][] {
  if (rows.length === 0) return [];
  return chunkByParams(rows, Object.keys(rows[0]).length);
}
