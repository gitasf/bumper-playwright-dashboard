import { describe, expect, it } from "vite-plus/test";
import { buildPageWindow } from "@/lib/page-window";

describe("buildPageWindow", () => {
  it("returns the full sequence with no ellipses when total <= 7", () => {
    expect(buildPageWindow(1, 1)).toEqual([1]);
    expect(buildPageWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(buildPageWindow(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("returns an empty sequence for zero pages", () => {
    expect(buildPageWindow(1, 0)).toEqual([]);
  });

  it("elides only the right side when current is near the start", () => {
    expect(buildPageWindow(1, 10)).toEqual([1, 2, "ellipsis", 10]);
    expect(buildPageWindow(2, 10)).toEqual([1, 2, 3, "ellipsis", 10]);
    // current=3 → window reaches page 2, so no left ellipsis yet.
    expect(buildPageWindow(3, 10)).toEqual([1, 2, 3, 4, "ellipsis", 10]);
  });

  it("elides only the left side when current is near the end", () => {
    expect(buildPageWindow(10, 10)).toEqual([1, "ellipsis", 9, 10]);
    expect(buildPageWindow(9, 10)).toEqual([1, "ellipsis", 8, 9, 10]);
    // current=8 → window reaches page 9, so no right ellipsis.
    expect(buildPageWindow(8, 10)).toEqual([1, "ellipsis", 7, 8, 9, 10]);
  });

  it("elides both sides when current is in the middle", () => {
    expect(buildPageWindow(5, 10)).toEqual([
      1,
      "ellipsis",
      4,
      5,
      6,
      "ellipsis",
      10,
    ]);
    expect(buildPageWindow(50, 100)).toEqual([
      1,
      "ellipsis",
      49,
      50,
      51,
      "ellipsis",
      100,
    ]);
  });

  it("always includes the first and last page", () => {
    for (const current of [1, 4, 8, 15]) {
      const window = buildPageWindow(current, 15);
      expect(window[0]).toBe(1);
      expect(window[window.length - 1]).toBe(15);
    }
  });

  it("kicks in ellipses exactly at total = 8", () => {
    expect(buildPageWindow(1, 8)).toEqual([1, 2, "ellipsis", 8]);
    expect(buildPageWindow(4, 8)).toEqual([
      1,
      "ellipsis",
      3,
      4,
      5,
      "ellipsis",
      8,
    ]);
  });
});
