import { describe, expect, it } from "vite-plus/test";
import { paginateOffsetTable, resolveOffsetPage } from "@/lib/page-window";

describe("resolveOffsetPage", () => {
  it("resolves the first page of a full set", () => {
    expect(
      resolveOffsetPage({
        total: 120,
        pageSize: 50,
        requestedPage: 1,
        rowCount: 50,
      }),
    ).toEqual({
      currentPage: 1,
      totalPages: 3,
      offset: 0,
      fromRow: 1,
      toRow: 50,
    });
  });

  it("resolves a middle page (offset + row range)", () => {
    expect(
      resolveOffsetPage({
        total: 120,
        pageSize: 50,
        requestedPage: 2,
        rowCount: 50,
      }),
    ).toEqual({
      currentPage: 2,
      totalPages: 3,
      offset: 50,
      fromRow: 51,
      toRow: 100,
    });
  });

  it("resolves the partial last page", () => {
    expect(
      resolveOffsetPage({
        total: 120,
        pageSize: 50,
        requestedPage: 3,
        rowCount: 20,
      }),
    ).toEqual({
      currentPage: 3,
      totalPages: 3,
      offset: 100,
      fromRow: 101,
      toRow: 120,
    });
  });

  it("reports 1 total page and zero rows for an empty set", () => {
    expect(
      resolveOffsetPage({
        total: 0,
        pageSize: 50,
        requestedPage: 1,
        rowCount: 0,
      }),
    ).toEqual({
      currentPage: 1,
      totalPages: 1,
      offset: 0,
      fromRow: 0,
      toRow: 0,
    });
  });

  it("clamps an over-the-end page to the last page and shows its window", () => {
    // 120 rows / 50 per page → 3 pages. Asking for page 99 lands on page 3,
    // and fromRow/toRow reflect the clamped page (NOT "Showing 0 of N").
    expect(
      resolveOffsetPage({
        total: 120,
        pageSize: 50,
        requestedPage: 99,
        rowCount: 20,
      }),
    ).toEqual({
      currentPage: 3,
      totalPages: 3,
      offset: 100,
      fromRow: 101,
      toRow: 120,
    });
  });

  it("clamps a requested page below 1 up to page 1", () => {
    expect(
      resolveOffsetPage({
        total: 30,
        pageSize: 50,
        requestedPage: 0,
        rowCount: 30,
      }),
    ).toEqual({
      currentPage: 1,
      totalPages: 1,
      offset: 0,
      fromRow: 1,
      toRow: 30,
    });
  });

  it("rounds totalPages up for a non-multiple total", () => {
    expect(
      resolveOffsetPage({ total: 101, pageSize: 50, requestedPage: 1 })
        .totalPages,
    ).toBe(3);
    expect(
      resolveOffsetPage({ total: 100, pageSize: 50, requestedPage: 1 })
        .totalPages,
    ).toBe(2);
    expect(
      resolveOffsetPage({ total: 1, pageSize: 50, requestedPage: 1 })
        .totalPages,
    ).toBe(1);
  });

  it("honours a distinct page size", () => {
    expect(
      resolveOffsetPage({
        total: 45,
        pageSize: 20,
        requestedPage: 3,
        rowCount: 5,
      }),
    ).toEqual({
      currentPage: 3,
      totalPages: 3,
      offset: 40,
      fromRow: 41,
      toRow: 45,
    });
  });

  it("yields the loader half (toRow === offset) when rowCount is omitted", () => {
    // Callers that only need currentPage/totalPages/offset to drive a query
    // don't pass rowCount; toRow falls back to offset (the row before the slice).
    expect(
      resolveOffsetPage({ total: 120, pageSize: 50, requestedPage: 2 }),
    ).toEqual({
      currentPage: 2,
      totalPages: 3,
      offset: 50,
      fromRow: 51,
      toRow: 50,
    });
  });

  it("treats null rowCount the same as omitted", () => {
    expect(
      resolveOffsetPage({
        total: 120,
        pageSize: 50,
        requestedPage: 2,
        rowCount: null,
      }).toRow,
    ).toBe(50);
  });
});

describe("paginateOffsetTable", () => {
  interface Row {
    id: number;
  }

  /**
   * Build a fake `pageQuery` over a virtual table of `total` sequential rows.
   * Records every `(offset)` it's called at so a test can assert the clamp /
   * refetch behaviour, and slices the virtual table like a real `LIMIT/OFFSET`.
   */
  function fakeTable(total: number, pageSize: number) {
    const offsets: number[] = [];
    const pageQuery = (offset: number, limit: number): Promise<Row[]> => {
      offsets.push(offset);
      expect(limit).toBe(pageSize);
      const rows: Row[] = [];
      for (let i = offset; i < Math.min(offset + limit, total); i++) {
        rows.push({ id: i });
      }
      return Promise.resolve(rows);
    };
    return { offsets, pageQuery };
  }

  const identity = (rows: Row[]): Row[] => rows;

  describe("known-number count", () => {
    it("resolves a middle page's offset, fromRow/toRow, and hasPrev/hasNext", async () => {
      const { offsets, pageQuery } = fakeTable(120, 50);
      const page = await paginateOffsetTable({
        page: 2,
        pageSize: 50,
        count: 120,
        pageQuery,
        mapRows: identity,
      });
      expect(offsets).toEqual([50]);
      expect(page.rows).toHaveLength(50);
      expect(page).toMatchObject({
        total: 120,
        currentPage: 2,
        totalPages: 3,
        fromRow: 51,
        toRow: 100,
        hasPrev: true,
        hasNext: true,
      });
    });

    it("skips the query entirely for a known-empty table", async () => {
      const { offsets, pageQuery } = fakeTable(0, 50);
      const page = await paginateOffsetTable({
        page: 1,
        pageSize: 50,
        count: 0,
        pageQuery,
        mapRows: identity,
      });
      // total is known to be 0 → no slice query is issued.
      expect(offsets).toEqual([]);
      expect(page.rows).toEqual([]);
      expect(page).toMatchObject({
        total: 0,
        currentPage: 1,
        totalPages: 1,
        fromRow: 0,
        toRow: 0,
        hasPrev: false,
        hasNext: false,
      });
    });

    it("clamps an over-the-end page and fetches ONCE at the clamped offset", async () => {
      const { offsets, pageQuery } = fakeTable(120, 50);
      const page = await paginateOffsetTable({
        page: 99,
        pageSize: 50,
        count: 120,
        pageQuery,
        mapRows: identity,
      });
      // Known total ⇒ clamp-first: the single fetch already runs at the last
      // page's offset (100), never at the requested (over-the-end) offset.
      expect(offsets).toEqual([100]);
      expect(page.rows).toHaveLength(20);
      expect(page).toMatchObject({
        currentPage: 3,
        totalPages: 3,
        fromRow: 101,
        toRow: 120,
        hasNext: false,
      });
    });

    it("accepts a `() => Promise<number>` count query", async () => {
      const { offsets, pageQuery } = fakeTable(45, 20);
      let counted = 0;
      const page = await paginateOffsetTable({
        page: 3,
        pageSize: 20,
        count: () => {
          counted++;
          return Promise.resolve(45);
        },
        pageQuery,
        mapRows: identity,
      });
      expect(counted).toBe(1);
      expect(offsets).toEqual([40]);
      expect(page).toMatchObject({
        total: 45,
        currentPage: 3,
        totalPages: 3,
        fromRow: 41,
        toRow: 45,
      });
    });

    it("derives toRow from the MAPPED length, not the raw slice", async () => {
      const { pageQuery } = fakeTable(120, 50);
      const page = await paginateOffsetTable({
        page: 1,
        pageSize: 50,
        count: 120,
        pageQuery,
        // Drop odd ids: 50 fetched → 25 mapped, so toRow must be 25 (not 50).
        mapRows: (rows) => rows.filter((r) => r.id % 2 === 0),
      });
      expect(page.rows).toHaveLength(25);
      expect(page.toRow).toBe(25);
      expect(page.fromRow).toBe(1);
    });
  });

  describe("fromSlice count (windowed count(*) OVER () idiom)", () => {
    it("derives the total off the slice and never refetches on a genuine last page", async () => {
      const { offsets, pageQuery } = fakeTable(45, 20);
      const page = await paginateOffsetTable<Row, Row>({
        page: 3,
        pageSize: 20,
        // A real windowed count rides on the rows; here it's constant so the
        // last (partial) page still reports the true total.
        count: { fromSlice: () => 45 },
        pageQuery,
        mapRows: identity,
      });
      expect(offsets).toEqual([40]);
      expect(page.rows).toHaveLength(5);
      expect(page).toMatchObject({
        total: 45,
        currentPage: 3,
        totalPages: 3,
        fromRow: 41,
        toRow: 45,
      });
    });

    it("refetches the clamped last page when an over-the-end fetch came back empty", async () => {
      const { offsets } = fakeTable(0, 50);
      // Total (120) known independently, but an over-the-end offset returns no
      // rows: the empty first fetch triggers a re-fetch at the clamped offset.
      const pageQuery = (offset: number, limit: number): Promise<Row[]> => {
        offsets.push(offset);
        expect(limit).toBe(50);
        const rows: Row[] = [];
        for (let i = offset; i < Math.min(offset + limit, 120); i++) {
          rows.push({ id: i });
        }
        return Promise.resolve(rows);
      };
      const page = await paginateOffsetTable<Row, Row>({
        page: 99,
        pageSize: 50,
        count: { fromSlice: () => 120 },
        pageQuery,
        mapRows: identity,
      });
      // First at the requested over-the-end offset (4900 → empty), then a
      // refetch at the clamped last-page offset (100).
      expect(offsets).toEqual([4900, 100]);
      expect(page.rows).toHaveLength(20);
      expect(page).toMatchObject({
        total: 120,
        currentPage: 3,
        totalPages: 3,
        fromRow: 101,
        toRow: 120,
      });
    });

    it("degrades an over-the-end page to empty when the slice carries the count (total reads 0)", async () => {
      // The catalog's real behaviour: the windowed count is 0 for an empty
      // slice, so total reads 0 and there's nothing to refetch — a single fetch.
      const { offsets, pageQuery } = fakeTable(120, 50);
      const page = await paginateOffsetTable<Row, Row>({
        page: 99,
        pageSize: 50,
        count: { fromSlice: (rows) => (rows[0] ? 120 : 0) },
        pageQuery,
        mapRows: identity,
      });
      expect(offsets).toEqual([4900]);
      expect(page.rows).toEqual([]);
      expect(page).toMatchObject({
        total: 0,
        currentPage: 1,
        totalPages: 1,
        fromRow: 0,
        toRow: 0,
      });
    });

    it("does not refetch the in-range first page of a genuinely empty set", async () => {
      // total reads 0 and the requested page (1) is already the clamped
      // page (1) — not an over-the-end ask, so a single fetch is enough.
      const offsets: number[] = [];
      const pageQuery = (offset: number, limit: number): Promise<Row[]> => {
        offsets.push(offset);
        expect(limit).toBe(50);
        return Promise.resolve([]);
      };
      const page = await paginateOffsetTable<Row, Row>({
        page: 1,
        pageSize: 50,
        count: { fromSlice: () => 0 },
        pageQuery,
        mapRows: identity,
      });
      expect(offsets).toEqual([0]);
      expect(page.rows).toEqual([]);
      expect(page).toMatchObject({
        total: 0,
        currentPage: 1,
        totalPages: 1,
        fromRow: 0,
        toRow: 0,
      });
    });

    it("does not refetch a genuinely empty in-range page when the ask wasn't clamped", async () => {
      // total (50) constant, simulating a filtered search with no matches on an
      // in-range page: requestedPage === currentPage, so the empty slice is
      // genuine (not over-the-end) and must not refetch.
      const offsets: number[] = [];
      const pageQuery = (offset: number, limit: number): Promise<Row[]> => {
        offsets.push(offset);
        expect(limit).toBe(50);
        return Promise.resolve([]);
      };
      const page = await paginateOffsetTable<Row, Row>({
        page: 1,
        pageSize: 50,
        count: { fromSlice: () => 50 },
        pageQuery,
        mapRows: identity,
      });
      expect(offsets).toEqual([0]);
      expect(page.rows).toEqual([]);
      expect(page).toMatchObject({
        total: 50,
        currentPage: 1,
        totalPages: 1,
        fromRow: 1,
        toRow: 0,
      });
    });
  });

  describe("?page coercion", () => {
    it("coerces a raw string page through parsePage", async () => {
      const { offsets, pageQuery } = fakeTable(100, 10);
      const page = await paginateOffsetTable({
        page: "3",
        pageSize: 10,
        count: 100,
        pageQuery,
        mapRows: identity,
      });
      expect(offsets).toEqual([20]);
      expect(page.currentPage).toBe(3);
    });

    it("degrades missing / non-numeric / < 1 pages to page 1", async () => {
      for (const raw of [null, "abc", "0", "-4", ""]) {
        const { offsets, pageQuery } = fakeTable(100, 10);
        const page = await paginateOffsetTable({
          page: raw,
          pageSize: 10,
          count: 100,
          pageQuery,
          mapRows: identity,
        });
        expect(offsets).toEqual([0]);
        expect(page.currentPage).toBe(1);
      }
    });

    it("accepts an already-parsed number page as-is", async () => {
      const { offsets, pageQuery } = fakeTable(100, 10);
      const page = await paginateOffsetTable({
        page: 4,
        pageSize: 10,
        count: 100,
        pageQuery,
        mapRows: identity,
      });
      expect(offsets).toEqual([30]);
      expect(page.currentPage).toBe(4);
    });
  });
});
