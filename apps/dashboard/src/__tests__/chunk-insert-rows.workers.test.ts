import { describe, it, expect } from "vite-plus/test";
import {
  artifacts,
  testAnnotations,
  testResultAttempts,
  testResults,
  testTags,
} from "@schema";
import { chunkBySize, chunkByParams, chunkInsertRows } from "@/lib/ingest";

/**
 * Guards F02: the param-chunk column count used to be a hand-typed literal per
 * table (TEST_RESULTS_COLUMNS=14 …) that could silently drift from the row
 * shape it protects — add a nullable column and the row literal grows with no
 * compile error, but the literal stays stale and the chunk overflows Postgres's
 * 65535-param ceiling at runtime. `chunkInsertRows` derives the column count from
 * the row object itself, so there is nothing left to drift.
 *
 * These tests anchor the guarantee to the REAL `$inferInsert` insert shapes:
 * the max-width sample rows below are typed `typeof table.$inferInsert`, so a
 * new NOT-NULL column makes them fail to compile until updated, and a new
 * nullable column that lands in the ingest row literals is still chunked by its
 * actual key count. Either way no chunk can exceed 65535 params.
 */

// Postgres's per-statement bound-parameter ceiling. Must match
// PG_MAX_BOUND_PARAMS in src/lib/ingest.ts (kept private there; restated here as
// the invariant under test).
const MAX_PARAMS_PER_STATEMENT = 65_535;

/** A row whose every column binds a parameter — the widest a real insert gets. */
const maxWidthRows = {
  testResults: {
    id: "r",
    projectId: "p",
    runId: "run",
    testId: "t",
    title: "title",
    file: "file.spec.ts",
    projectName: "chromium",
    status: "passed",
    durationMs: 1,
    retryCount: 0,
    errorMessage: "err",
    errorStack: "stack",
    workerIndex: 0,
    createdAt: 0,
  } satisfies typeof testResults.$inferInsert,
  testTags: {
    id: "tag",
    projectId: "p",
    testResultId: "tr",
    tag: "@smoke",
  } satisfies typeof testTags.$inferInsert,
  testAnnotations: {
    id: "an",
    projectId: "p",
    testResultId: "tr",
    type: "issue",
    description: "desc",
  } satisfies typeof testAnnotations.$inferInsert,
  testResultAttempts: {
    id: "at",
    projectId: "p",
    testResultId: "tr",
    attempt: 0,
    status: "failed",
    durationMs: 1,
    errorMessage: "err",
    errorStack: "stack",
    createdAt: 0,
  } satisfies typeof testResultAttempts.$inferInsert,
  artifacts: {
    id: "ar",
    projectId: "p",
    testResultId: "tr",
    type: "video",
    name: "video.webm",
    contentType: "video/webm",
    sizeBytes: 10,
    r2Key: "key",
    attempt: 0,
    role: "actual",
    snapshotName: "snap",
    createdAt: 0,
  } satisfies typeof artifacts.$inferInsert,
} as const;

describe("chunkInsertRows", () => {
  it("returns no chunks for an empty array", () => {
    expect(chunkInsertRows([])).toEqual([]);
  });

  it.each(Object.entries(maxWidthRows))(
    "keeps every %s chunk under the 65535-param ceiling at the widest row shape",
    (_table, sampleRow) => {
      const columns = Object.keys(sampleRow).length;
      // 20000 rows forces multiple chunks for every table width: the narrowest
      // table (4 cols) packs floor(65535/4)=16383 rows/chunk, so 20000 overflows.
      const rows = Array.from({ length: 20_000 }, () => ({ ...sampleRow }));
      const chunks = chunkInsertRows(rows);

      expect(chunks.length).toBeGreaterThan(1);
      // No params dropped or duplicated across chunks.
      expect(chunks.reduce((n, c) => n + c.length, 0)).toBe(rows.length);
      for (const chunk of chunks) {
        expect(chunk.length * columns).toBeLessThanOrEqual(
          MAX_PARAMS_PER_STATEMENT,
        );
      }
    },
  );

  it("derives the per-row column count from the row object, not a literal", () => {
    // A two-column row packs 32767 rows per chunk (floor(65535/2)); a
    // four-column row packs 16383 (floor(65535/4)). The count comes from the row
    // shape alone — one extra row past the cap proves the first chunk fills to
    // exactly that per-row math.
    const twoCol = Array.from({ length: 32_768 }, (_, i) => ({ a: i, b: i }));
    expect(chunkInsertRows(twoCol)[0]).toHaveLength(32_767);

    const fourCol = Array.from({ length: 16_384 }, (_, i) => ({
      a: i,
      b: i,
      c: i,
      d: i,
    }));
    expect(chunkInsertRows(fourCol)[0]).toHaveLength(16_383);
  });

  it("packs a single full chunk when rows fit under the ceiling", () => {
    const rows = Array.from({ length: 3 }, () => ({
      ...maxWidthRows.testResults,
    }));
    expect(chunkInsertRows(rows)).toEqual([rows]);
  });
});

describe("chunkByParams", () => {
  it("packs floor(65535 / columnsPerRow) rows per chunk", () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => i);
    expect(chunkByParams(rows, 14)[0]).toHaveLength(4681); // floor(65535/14)
    expect(chunkByParams(rows, 5)[0]).toHaveLength(13_107); // floor(65535/5)
  });

  it("never drops to a zero-width chunk even past the ceiling", () => {
    // A pathological row wider than the ceiling still ships one row per
    // statement (it can't be split further; Postgres would reject it, but the
    // chunker must not loop forever on a 0 step).
    const rows = [1, 2, 3];
    expect(chunkByParams(rows, 70_000)).toEqual([[1], [2], [3]]);
  });
});

describe("chunkBySize", () => {
  it("slices into consecutive chunks of at most `size`", () => {
    expect(chunkBySize([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns no chunks for an empty array", () => {
    expect(chunkBySize([], 4)).toEqual([]);
  });

  it("fits everything in one chunk when size >= length", () => {
    expect(chunkBySize([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it("never loops forever on a non-positive size — steps one item at a time", () => {
    expect(chunkBySize([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
    expect(chunkBySize([1, 2], -5)).toEqual([[1], [2]]);
  });
});
