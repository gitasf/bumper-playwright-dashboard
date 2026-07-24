import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_TESTS_SORT,
  parseTestsSort,
  testsCatalogSortSql,
} from "@/lib/tests-catalog-sort";

describe("parseTestsSort", () => {
  it("defaults to newest seen first", () => {
    expect(parseTestsSort(null, null)).toEqual(DEFAULT_TESTS_SORT);
  });

  it("uses the natural first direction for each column", () => {
    expect(parseTestsSort("test", null)).toEqual({
      key: "test",
      direction: "asc",
    });
    expect(parseTestsSort("runs", null)).toEqual({
      key: "runs",
      direction: "desc",
    });
    expect(parseTestsSort("duration", null)).toEqual({
      key: "duration",
      direction: "desc",
    });
  });

  it("honors an explicit direction, including for the default column", () => {
    expect(parseTestsSort(null, "asc")).toEqual({
      key: "last-seen",
      direction: "asc",
    });
    expect(parseTestsSort("test", "desc")).toEqual({
      key: "test",
      direction: "desc",
    });
  });

  it("rejects an unknown key as one state instead of pairing it with a direction", () => {
    expect(parseTestsSort("drop table", "asc")).toEqual(DEFAULT_TESTS_SORT);
  });
});

describe("testsCatalogSortSql", () => {
  it("emits stable ordering for every sortable column", () => {
    expect(testsCatalogSortSql({ key: "test", direction: "asc" }).orderBy).toBe(
      'lower("title") asc, "title" asc, "testId" asc',
    );
    expect(
      testsCatalogSortSql({ key: "runs", direction: "desc" }).orderBy,
    ).toBe('"n" desc, "testId" asc');
    expect(
      testsCatalogSortSql({ key: "duration", direction: "asc" }).orderBy,
    ).toBe('"avgDurationMs" asc nulls last, "testId" asc');
    expect(
      testsCatalogSortSql({ key: "last-seen", direction: "desc" }).orderBy,
    ).toBe('"lastSeen" desc, "testId" asc');
  });

  it("pins the testId tiebreaker to asc regardless of direction", () => {
    // Uniform across columns so OFFSET pages can't skip/duplicate rows that
    // share an aggregate value; the `test` column used to flip it with dir.
    for (const direction of ["asc", "desc"] as const) {
      expect(testsCatalogSortSql({ key: "test", direction }).orderBy).toMatch(
        /"testId" asc$/,
      );
    }
  });

  it("only the selected column pulls in its extra projection/join", () => {
    expect(
      testsCatalogSortSql({ key: "last-seen", direction: "desc" }),
    ).toEqual({
      projection: "",
      join: "",
      group: "",
      orderBy: '"lastSeen" desc, "testId" asc',
    });
    const test = testsCatalogSortSql({ key: "test", direction: "asc" });
    expect(test.join).toContain('join "tests" t');
    expect(test.group).toBe(", t.title");
  });
});
