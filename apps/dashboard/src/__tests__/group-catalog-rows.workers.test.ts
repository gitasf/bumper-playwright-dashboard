import { describe, expect, it } from "vite-plus/test";
import {
  catalogGroupKey,
  groupCatalogRows,
  type GroupableRow,
} from "@/lib/group-catalog-rows";

const row = (over: Partial<GroupableRow>): GroupableRow => ({
  file: "a.spec.ts",
  title: "Suite > does a thing",
  passedCount: 1,
  flakyCount: 0,
  failCount: 0,
  skippedCount: 0,
  ...over,
});

describe("catalogGroupKey", () => {
  it("groups by file path", () => {
    expect(catalogGroupKey({ file: "x/y.spec.ts", title: "t" }, "file")).toBe(
      "x/y.spec.ts",
    );
    expect(catalogGroupKey({ file: "", title: "t" }, "file")).toBe("(no file)");
  });

  it("groups by suite — the title path minus the leaf test name", () => {
    expect(
      catalogGroupKey({ file: "f", title: "Auth > login > succeeds" }, "suite"),
    ).toBe("Auth > login");
    expect(
      catalogGroupKey({ file: "f", title: "top-level test" }, "suite"),
    ).toBe("(top level)");
  });

  it("never yields an empty/invisible suite key for a degenerate title", () => {
    // A leading separator would otherwise produce an empty group header.
    expect(catalogGroupKey({ file: "f", title: " > leaf" }, "suite")).toBe(
      "(top level)",
    );
    expect(catalogGroupKey({ file: "f", title: "" }, "suite")).toBe(
      "(top level)",
    );
  });
});

describe("groupCatalogRows", () => {
  it("clusters rows and sums outcome counts per group", () => {
    const rows = [
      row({ file: "a.ts", title: "A > one", passedCount: 2 }),
      row({ file: "b.ts", title: "B > two", failCount: 1, passedCount: 0 }),
      row({ file: "a.ts", title: "A > three", flakyCount: 1, passedCount: 0 }),
    ];
    const groups = groupCatalogRows(rows, "file");
    expect(groups.map((g) => g.key)).toEqual(["a.ts", "b.ts"]);
    const a = groups[0];
    expect(a.testCount).toBe(2);
    expect(a.passedCount).toBe(2);
    expect(a.flakyCount).toBe(1);
    const b = groups[1];
    expect(b.testCount).toBe(1);
    expect(b.failCount).toBe(1);
  });

  it("preserves first-seen group order from the active catalog sort", () => {
    const rows = [
      row({ file: "z.ts", title: "t" }),
      row({ file: "a.ts", title: "t" }),
      row({ file: "z.ts", title: "t" }),
    ];
    expect(groupCatalogRows(rows, "file").map((g) => g.key)).toEqual([
      "z.ts",
      "a.ts",
    ]);
  });
});
