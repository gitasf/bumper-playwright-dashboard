export const TESTS_SORT_KEYS = [
  "test",
  "runs",
  "duration",
  "last-seen",
] as const;

export type TestsSortKey = (typeof TESTS_SORT_KEYS)[number];
export type TestsSortDirection = "asc" | "desc";

export interface TestsSortState {
  key: TestsSortKey;
  direction: TestsSortDirection;
}

export const DEFAULT_TESTS_SORT: TestsSortState = {
  key: "last-seen",
  direction: "desc",
};

export function defaultTestsSortDirection(
  key: TestsSortKey,
): TestsSortDirection {
  return key === "test" ? "asc" : "desc";
}

/** Normalize the URL's closed sort vocabulary before it reaches SQL or UI. */
export function parseTestsSort(
  keyParam: string | null,
  directionParam: string | null,
): TestsSortState {
  const validKey = TESTS_SORT_KEYS.find((key) => key === keyParam);
  if (keyParam !== null && !validKey) return DEFAULT_TESTS_SORT;

  const key = validKey ?? DEFAULT_TESTS_SORT.key;
  const direction =
    directionParam === "asc" || directionParam === "desc"
      ? directionParam
      : defaultTestsSortDirection(key);
  return { key, direction };
}

/**
 * The full SQL contract for one catalog sort, in one place per key: the extra
 * grouped-CTE column its ORDER BY needs, any catalog join/group it depends on,
 * and the ORDER BY itself. Co-locating them keeps the projected alias (e.g.
 * `"n"`) and the ORDER BY that consumes it from drifting apart.
 *
 * Every field is a constant fragment built from the closed `TestsSortKey` /
 * `TestsSortDirection` unions — the raw URL value is never interpolated — so the
 * caller can safely splice these via `sql.raw`. Pure strings (no `void/db`
 * import) keep this module importable from the client page too.
 */
export interface TestsCatalogSortSql {
  /** Extra grouped-CTE column(s), with leading comma, or "". */
  projection: string;
  /** Extra `from` join this sort depends on, or "". */
  join: string;
  /** Extra `group by` column(s), with leading comma, or "". */
  group: string;
  /**
   * Full ORDER BY list. Always ends in `"testId" asc` — a unique per-project
   * tiebreaker so OFFSET pagination stays stable when aggregate values are equal.
   */
  orderBy: string;
}

export function testsCatalogSortSql({
  key,
  direction,
}: TestsSortState): TestsCatalogSortSql {
  const dir = direction === "asc" ? "asc" : "desc";
  const tiebreak = `"testId" asc`;
  switch (key) {
    case "test":
      return {
        projection: `, coalesce(t.title, max(tr.title), tr."testId") as "title"`,
        join: `left join "tests" t
          on t."projectId" = tr."projectId" and t."testId" = tr."testId"`,
        group: `, t.title`,
        orderBy: `lower("title") ${dir}, "title" ${dir}, ${tiebreak}`,
      };
    case "runs":
      return {
        projection: `, count(*) as "n"`,
        join: "",
        group: "",
        orderBy: `"n" ${dir}, ${tiebreak}`,
      };
    case "duration":
      return {
        projection: `, avg(tr."durationMs") as "avgDurationMs"`,
        join: "",
        group: "",
        orderBy: `"avgDurationMs" ${dir} nulls last, ${tiebreak}`,
      };
    case "last-seen":
      return {
        projection: "",
        join: "",
        group: "",
        orderBy: `"lastSeen" ${dir}, ${tiebreak}`,
      };
  }
}
