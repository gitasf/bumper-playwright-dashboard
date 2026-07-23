/**
 * Client-/server-side grouping of test-catalog rows for the catalog page's
 * "group by file / suite" view. PURE — no DB, no React — so the grouping +
 * per-group rollup math is unit-testable. Operates over the current page's
 * rows (grouping is presentational, within-page; pagination stays per-test).
 *
 * Suite is derived from the joined title path (`"Suite > sub > test"`, the same
 * `" > "` convention `parseTitleSegments` uses) by dropping the final segment.
 */

export type CatalogGroupMode = "file" | "suite";

/** The row fields grouping needs — a structural subset of `TestsPageRow`. */
export interface GroupableRow {
  file: string;
  title: string;
  passedCount: number;
  flakyCount: number;
  failCount: number;
  skippedCount: number;
}

export interface CatalogGroup<T extends GroupableRow> {
  key: string;
  rows: T[];
  passedCount: number;
  flakyCount: number;
  failCount: number;
  skippedCount: number;
  testCount: number;
}

/** The group a row belongs to under `mode`. PURE. */
export function catalogGroupKey(
  row: Pick<GroupableRow, "file" | "title">,
  mode: CatalogGroupMode,
): string {
  if (mode === "file") return row.file || "(no file)";
  const segments = row.title.split(" > ");
  // Drop the leaf (the test name); the prefix is the suite path. Guard the
  // degenerate cases (no separator, or empty leading segments) so the key is
  // never an empty/invisible string.
  const suite = segments.slice(0, -1).join(" > ").trim();
  return suite || "(top level)";
}

/**
 * Cluster rows into groups (preserving first-seen order, so groups follow the
 * rows' active catalog sort) with summed outcome counts.
 */
export function groupCatalogRows<T extends GroupableRow>(
  rows: readonly T[],
  mode: CatalogGroupMode,
): CatalogGroup<T>[] {
  const groups = new Map<string, CatalogGroup<T>>();
  for (const row of rows) {
    const key = catalogGroupKey(row, mode);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        rows: [],
        passedCount: 0,
        flakyCount: 0,
        failCount: 0,
        skippedCount: 0,
        testCount: 0,
      };
      groups.set(key, group);
    }
    group.rows.push(row);
    group.passedCount += row.passedCount;
    group.flakyCount += row.flakyCount;
    group.failCount += row.failCount;
    group.skippedCount += row.skippedCount;
    group.testCount += 1;
  }
  return [...groups.values()];
}
