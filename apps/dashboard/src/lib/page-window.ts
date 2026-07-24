import { parsePage } from "@/lib/runs/filters";

export interface ResolveOffsetPageInput {
  /** Total matching rows across all pages (e.g. `count(*)`). */
  total: number;
  /** Rows per page; call sites differ (50 for tests/audit, 20 for slowest). */
  pageSize: number;
  /** The `?page=` value the client asked for (already coerced to >= 1). */
  requestedPage: number;
  /**
   * Number of rows actually returned for the resolved page. Pass it once the
   * slice is fetched so `toRow` reflects the real count; omit it (or pass
   * `null`) when you only need the loader half (`currentPage`/`totalPages`/
   * `offset`) to drive the query — `toRow` is then `offset` (the row before
   * the slice). The runs-list loader is a deliberate partial adopter: it owns
   * `fromRow`/`toRow` itself because they fold in live-row `newCount`.
   */
  rowCount?: number | null;
}

export interface ResolveOffsetPageResult {
  /** `requestedPage` clamped to `[1, totalPages]`. */
  currentPage: number;
  /** `max(1, ceil(total / pageSize))` — never below 1, even for an empty set. */
  totalPages: number;
  /** Zero-based SQL offset for the resolved page: `(currentPage - 1) * pageSize`. */
  offset: number;
  /** 1-based index of the first visible row, or `0` when there are no rows. */
  fromRow: number;
  /** 1-based index of the last visible row: `offset + rowCount`. */
  toRow: number;
}

/**
 * The arithmetic half of offset pagination, factored out of the table loaders
 * that all re-derived it inline (the tests catalog, the slowest-tests insight,
 * and the team audit log). `TablePaginationFooter` is its rendering-side
 * mirror.
 *
 * Out-of-range behaviour is decided ONCE here: an out-of-range `?page=` is
 * CLAMPED to `totalPages`, and `fromRow`/`toRow` are computed against the
 * clamped page — so a too-large page shows the last page's window rather than
 * "Showing 0 of N". Call sites that previously diverged (audit/slowest showed
 * "Showing 0 of N" for an over-the-end page) now all match the clamped-last
 * behaviour the tests catalog had.
 *
 * Note this clamps the page number but does NOT re-run the query: a caller that
 * fetched its slice using the *requested* offset can get back an empty slice on
 * an over-the-end page even though `currentPage` is now the last page. Callers
 * that want the slice to match the clamped page must re-fetch at `offset` when
 * the first fetch came back empty — see `shouldRefetchClampedPage`.
 */
export function resolveOffsetPage({
  total,
  pageSize,
  requestedPage,
  rowCount,
}: ResolveOffsetPageInput): ResolveOffsetPageResult {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(Math.max(requestedPage, 1), totalPages);
  const offset = (currentPage - 1) * pageSize;
  const rows = rowCount ?? 0;
  const fromRow = total === 0 ? 0 : offset + 1;
  const toRow = offset + rows;
  return { currentPage, totalPages, offset, fromRow, toRow };
}

/**
 * Whether a loader should re-fetch its slice at the clamped offset. True when
 * an over-the-end page was requested (so `currentPage` got clamped below
 * `requestedPage`) but rows do exist — i.e. the first fetch, run at the
 * requested offset, came back empty. Lets the over-the-end page actually show
 * the last page's rows instead of an empty table under a clamped footer.
 *
 * This is the "refetch the last page when the slice came back empty" dance the
 * tests catalog open-coded; module-private because `paginateOffsetTable` below
 * is its only caller — the `fromSlice` count source is the one path that can't
 * clamp before its first fetch, so it's the only place this dance is needed.
 */
function shouldRefetchClampedPage(input: {
  total: number;
  requestedPage: number;
  currentPage: number;
  fetchedRowCount: number;
}): boolean {
  return (
    input.total > 0 &&
    input.fetchedRowCount === 0 &&
    input.requestedPage > input.currentPage
  );
}

/**
 * Where the total row count comes from, which also decides the fetch order:
 *
 * - `number` / `() => Promise<number>` — total known before the slice. Clamp
 *   first, fetch the slice once at the clamped offset; `total === 0` skips the
 *   slice query entirely.
 * - `{ fromSlice }` — total rides on the page query (windowed `count(*) OVER ()`),
 *   so it's unknown until the slice returns. Fetch at the requested offset; if
 *   empty while the total says rows exist (over-the-end `?page=`), re-fetch at
 *   the clamped offset (`shouldRefetchClampedPage`). Windowed count is `0` on an
 *   empty slice, so a `fromSlice` reading it off the rows degrades an
 *   over-the-end page to the empty state rather than refetching.
 */
export type OffsetCountSource<Row> =
  | number
  | (() => Promise<number>)
  | { fromSlice: (rows: Row[]) => number };

export interface PaginateOffsetTableOpts<Row, Out = Row> {
  /**
   * The raw `?page=` value (coerced via `parsePage`) or an already-parsed page
   * number — loaders that also need the page eagerly (toolbar hrefs, the
   * streamed shell) parse once and pass the number so the two can't disagree.
   */
  page: number | string | null;
  /** Rows per page; call sites differ (50 for tests/audit, 20 for slowest). */
  pageSize: number;
  /** See {@link OffsetCountSource}. */
  count: OffsetCountSource<Row>;
  /** Fetch one page slice. `limit` is always `pageSize`. */
  pageQuery: (offset: number, limit: number) => Promise<Row[]>;
  /**
   * Batch-map the fetched slice into the rendered rows — async so it can be a
   * real second-pass query (tests-catalog aggregate, audit-log actor names).
   * Never invoked with an empty slice, so an `in (...)` built from the rows is
   * always non-empty. `toRow` derives from the mapped length, so the footer's
   * "Showing X–Y" matches the rendered rows. Omit when the slice rows are
   * already the output shape — the slice is returned as-is and `Out` = `Row`.
   */
  mapRows?: (rows: Row[]) => Out[] | Promise<Out[]>;
}

export interface OffsetTablePage<Out> {
  rows: Out[];
  /** Total matching rows across all pages (echoed/derived from `count`). */
  total: number;
  currentPage: number;
  totalPages: number;
  fromRow: number;
  toRow: number;
  hasPrev: boolean;
  hasNext: boolean;
}

/**
 * The one offset-paginated table read — the offset mirror of the cursor-model
 * `paginateRunTests` (`src/lib/runs/results-page.ts`). The `?page=` coercion,
 * count→clamp ordering, slice fetch at the clamped offset, over-the-end refetch,
 * and slice-accurate `toRow` all live here once; callers supply only a count
 * source, a `pageQuery`, and an optional `mapRows` — so a loader can't
 * off-by-one its offset, forget the clamp, or let `toRow` disagree with the
 * rendered slice.
 *
 * The arithmetic half (`resolveOffsetPage`) stays exported because
 * split-streaming loaders derive an eager pagination shell from an
 * already-counted total before deferring this call, and the runs list (a
 * partial adopter folding the live-room `newCount` into its `fromRow`/`toRow`)
 * consumes only the page math. The result is serializable, so a deferred region
 * can stream it straight into props.
 *
 * Overloaded so omitting `mapRows` returns `OffsetTablePage<Row>` (the slice
 * verbatim) with no cast: the two branches each match ONE member of the impl
 * signature's `OffsetTablePage<Out> | OffsetTablePage<Row>`, checked
 * independently rather than forcing `Row` and `Out` to unify.
 */
export async function paginateOffsetTable<Row>(
  // `mapRows?: undefined` (not `Omit`): with `Omit`, a call that DOES pass
  // `mapRows` still types its other properties against this overload first,
  // and with the callback stripped, `mapRows`'s params fall to implicit-any.
  opts: PaginateOffsetTableOpts<Row, Row> & { mapRows?: undefined },
): Promise<OffsetTablePage<Row>>;
export async function paginateOffsetTable<Row, Out>(
  opts: PaginateOffsetTableOpts<Row, Out> & {
    mapRows: (rows: Row[]) => Out[] | Promise<Out[]>;
  },
): Promise<OffsetTablePage<Out>>;
export async function paginateOffsetTable<Row, Out = Row>({
  page,
  pageSize,
  count,
  pageQuery,
  mapRows,
}: PaginateOffsetTableOpts<Row, Out>): Promise<
  OffsetTablePage<Out> | OffsetTablePage<Row>
> {
  const requestedPage = typeof page === "number" ? page : parsePage(page);

  let total: number;
  let sliceRows: Row[];
  if (typeof count === "object") {
    // Total rides on the slice: fetch at the requested offset, derive, then
    // clamp — and re-fetch the last page when the ask was over the end.
    sliceRows = await pageQuery((requestedPage - 1) * pageSize, pageSize);
    total = count.fromSlice(sliceRows);
    const { currentPage, offset } = resolveOffsetPage({
      total,
      pageSize,
      requestedPage,
    });
    if (
      shouldRefetchClampedPage({
        total,
        requestedPage,
        currentPage,
        fetchedRowCount: sliceRows.length,
      })
    ) {
      sliceRows = await pageQuery(offset, pageSize);
    }
  } else {
    // Total known before the fetch: clamp FIRST so the one slice query already
    // runs at the clamped offset (no refetch can ever be needed), and skip the
    // query entirely for a provably-empty table.
    total = typeof count === "function" ? await count() : count;
    const { offset } = resolveOffsetPage({ total, pageSize, requestedPage });
    sliceRows = total > 0 ? await pageQuery(offset, pageSize) : [];
  }

  if (mapRows) {
    const rows = sliceRows.length > 0 ? await mapRows(sliceRows) : [];
    const { currentPage, totalPages, fromRow, toRow } = resolveOffsetPage({
      total,
      pageSize,
      requestedPage,
      rowCount: rows.length,
    });
    return {
      rows,
      total,
      currentPage,
      totalPages,
      fromRow,
      toRow,
      hasPrev: currentPage > 1,
      hasNext: currentPage < totalPages,
    };
  }

  // No mapRows ⇒ the slice IS the output (the `mapRows?: undefined` overload
  // above pins Out to Row for callers on this path).
  const { currentPage, totalPages, fromRow, toRow } = resolveOffsetPage({
    total,
    pageSize,
    requestedPage,
    rowCount: sliceRows.length,
  });
  return {
    rows: sliceRows,
    total,
    currentPage,
    totalPages,
    fromRow,
    toRow,
    hasPrev: currentPage > 1,
    hasNext: currentPage < totalPages,
  };
}
