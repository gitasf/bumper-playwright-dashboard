import { describe, expect, it } from "vite-plus/test";
import { DAY_SEC } from "@/lib/analytics/bucketing";
import { makeRangeParser, rangeToSeconds } from "@/lib/analytics/range";

/**
 * `rangeToSeconds` + `makeRangeParser` are the pure range-key decoders the
 * analytics loaders lean on (via `resolveAnalyticsWindow` and their own typed
 * parsers). `resolveAnalyticsWindow`'s tests only see the *window projection*
 * of `rangeToSeconds`; these pin the raw three-way return contract directly —
 * `null` for the "all" sentinel, `n*DAY_SEC` / `n*365*DAY_SEC` for `d`/`y`
 * suffixes, and `undefined` for anything unrecognized so callers can apply a
 * fallback. `makeRangeParser` is otherwise untested.
 */

describe("rangeToSeconds", () => {
  it("returns null for the 'all' sentinel (no lower bound)", () => {
    expect(rangeToSeconds("all")).toBeNull();
  });

  it("multiplies the day count by DAY_SEC for a 'd' suffix", () => {
    expect(rangeToSeconds("7d")).toBe(7 * DAY_SEC);
    expect(rangeToSeconds("30d")).toBe(30 * DAY_SEC);
    expect(rangeToSeconds("90d")).toBe(90 * DAY_SEC);
  });

  it("treats a 'y' suffix as 365 days (the leap-free approximation)", () => {
    expect(rangeToSeconds("1y")).toBe(365 * DAY_SEC);
    expect(rangeToSeconds("2y")).toBe(2 * 365 * DAY_SEC);
  });

  it("returns undefined for unrecognized strings (caller applies a fallback)", () => {
    expect(rangeToSeconds("")).toBeUndefined();
    expect(rangeToSeconds("nonsense")).toBeUndefined();
    // Empty number, bare suffix, unsupported unit, or trailing junk all miss.
    expect(rangeToSeconds("d")).toBeUndefined();
    expect(rangeToSeconds("7")).toBeUndefined();
    expect(rangeToSeconds("7w")).toBeUndefined();
    expect(rangeToSeconds("7days")).toBeUndefined();
    expect(rangeToSeconds(" 7d")).toBeUndefined();
  });

  it("distinguishes undefined (unrecognized) from null (the 'all' sentinel)", () => {
    // The two non-numeric outcomes must not collapse together: callers coalesce
    // undefined -> their own fallback, but null is a deliberate "no bound".
    expect(rangeToSeconds("garbage")).toBeUndefined();
    expect(rangeToSeconds("all")).toBeNull();
  });
});

describe("makeRangeParser", () => {
  const parse = makeRangeParser(["7d", "30d", "90d"] as const, "30d");

  it("returns a member of the valid union unchanged", () => {
    expect(parse("7d")).toBe("7d");
    expect(parse("90d")).toBe("90d");
  });

  it("falls back for a value outside the page's allowed set", () => {
    // "1y" is a real range key but not in this page's option list.
    expect(parse("1y")).toBe("30d");
    expect(parse("all")).toBe("30d");
    expect(parse("garbage")).toBe("30d");
  });

  it("falls back for a null param (absent ?range=)", () => {
    expect(parse(null)).toBe("30d");
  });

  it("narrows to the exact fallback the page declared", () => {
    const otherParse = makeRangeParser(["1y", "2y", "all"] as const, "all");
    expect(otherParse(null)).toBe("all");
    expect(otherParse("2y")).toBe("2y");
    expect(otherParse("7d")).toBe("all");
  });
});
