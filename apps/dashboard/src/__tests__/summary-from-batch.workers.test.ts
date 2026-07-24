import { describe, it, expect } from "vite-plus/test";
import {
  statementChangedRows,
  summaryFromBatchResults,
  type RunAggregateSummary,
} from "@/lib/ingest";

/**
 * Guards the summary-extraction convention shared by appendRunResults /
 * completeRun / finalizeStaleRun: the summary-producing statement (a
 * `.returning()` UPDATE) is always run LAST in the batch, so the broadcast
 * summary is `batchResults[last][0]`.
 *
 * Before this seam existed each caller hand-transcribed `batchResults[len-1] as
 * RunAggregateSummary[] | undefined` then `?.[0]`. A trailing non-returning
 * statement (or an off-by-one) made that read `undefined`, silently publishing
 * the wrong row (or, in appendRunResults, returning a spurious notFound). These
 * tests pin the positional read + null-normalization in its one home.
 *
 * The `db.batch` round-trip (append-last + transaction) in `runBatchWithSummary`
 * needs the real-D1 harness to assert end-to-end; this covers the pure
 * extraction half that holds the footgun.
 */
describe("summaryFromBatchResults", () => {
  const summary: RunAggregateSummary = {
    totalTests: 12,
    expectedTotalTests: null,
    passed: 9,
    failed: 1,
    flaky: 1,
    skipped: 1,
    durationMs: 4200,
    status: "failed",
    completedAt: null,
  };

  it("returns the first row of the LAST batch result (the summary statement)", () => {
    // Earlier results are per-test insert/update outcomes; the summary is last.
    const batchResults: unknown[] = [
      [{ id: "row-a" }],
      [{ id: "row-b" }],
      [summary],
    ];
    expect(summaryFromBatchResults(batchResults)).toEqual(summary);
  });

  it("reads the summary regardless of how many writes precede it", () => {
    const single: unknown[] = [[summary]];
    expect(summaryFromBatchResults(single)).toEqual(summary);
  });

  it("returns null (never undefined) when the final statement produced no row", () => {
    // The run vanished between the ownership check and the batch: a
    // `.returning()` UPDATE that matched nothing yields an empty array. Before
    // the seam this surfaced as `undefined` → a spurious notFound / skipped
    // broadcast; the helper normalizes it to a single nullable sentinel.
    const noMatch: unknown[] = [[{ id: "write" }], []];
    expect(summaryFromBatchResults(noMatch)).toBeNull();
  });

  it("returns null when the batch is empty", () => {
    expect(summaryFromBatchResults([])).toBeNull();
  });

  it("ignores rows from non-final statements (the convention is positional)", () => {
    // A row sitting in a non-last position must NOT be mistaken for the summary;
    // only the final statement is the summary producer.
    const summaryNotLast: unknown[] = [[summary], []];
    expect(summaryFromBatchResults(summaryNotLast)).toBeNull();
  });
});

/**
 * Head-of-batch counterpart to `summaryFromBatchResults`: reads how many rows a
 * non-`.returning()` statement (e.g. `finalizeStaleRun`'s guarded status flip)
 * changed — `rowCount` on node-postgres, `affectedRows` on pglite.
 * `reconcileAndBroadcast` uses this to suppress the redundant terminal broadcast
 * on a no-op finalize, so the read shape + missing-count fallback get pinned in
 * one place.
 */
describe("statementChangedRows", () => {
  it("reads rowCount (node-postgres) when the flip matched rows", () => {
    expect(statementChangedRows({ rowCount: 1 })).toBe(1);
  });

  it("reads affectedRows (pglite) when the flip matched rows", () => {
    expect(statementChangedRows({ affectedRows: 1 })).toBe(1);
  });

  it("returns 0 when a guarded WHERE matched nothing (the no-op finalize)", () => {
    expect(statementChangedRows({ rowCount: 0 })).toBe(0);
  });

  it("defaults to 0 for shapes without a count (conservative no-op)", () => {
    // A `.returning()` UPDATE yields a rows array, not a driver result; an absent
    // or non-numeric count must read as "nothing changed" so a broadcast guarded
    // on ">0" stays silent rather than firing on a malformed result.
    expect(statementChangedRows([{ id: "row" }])).toBe(0);
    expect(statementChangedRows(undefined)).toBe(0);
    expect(statementChangedRows({})).toBe(0);
    expect(statementChangedRows({ rowCount: "1" })).toBe(0);
  });
});
