import { describe, expect, it } from "vite-plus/test";
import { DAY_SEC } from "@/lib/analytics/bucketing";
import {
  normalizeBranchFilter,
  resolveAnalyticsWindow,
} from "@/lib/analytics/params";

/**
 * `normalizeBranchFilter` + `resolveAnalyticsWindow` are the single home for the
 * loader preamble (the `?branch=` decode + the window math) that the six
 * analytics loaders used to re-derive inline — including the windowStart
 * formula that had drifted into three forms. These tests pin the two
 * invariants a maintainer touching range/window semantics must preserve:
 *
 *  1. The all-branches sentinel and an absent param both fold to a null filter
 *     (with `branchAll` flagged), while a real branch passes through verbatim.
 *  2. ONE window formula: `windowStartSec = rangeSec == null ? 0 : nowSec -
 *     rangeSec`, with `days` mirroring `rangeSec / DAY_SEC` and "all" → null.
 */

describe("normalizeBranchFilter", () => {
  it("folds the all-branches sentinel to a null filter", () => {
    expect(normalizeBranchFilter("__all__")).toEqual({
      branchParam: "__all__",
      branchFilter: null,
      branchAll: true,
    });
  });

  it("folds an absent param (null) to a null filter", () => {
    expect(normalizeBranchFilter(null)).toEqual({
      branchParam: null,
      branchFilter: null,
      branchAll: true,
    });
  });

  it("folds an absent param (undefined) to a null filter, normalizing to null", () => {
    expect(normalizeBranchFilter(undefined)).toEqual({
      branchParam: null,
      branchFilter: null,
      branchAll: true,
    });
  });

  it("passes a real branch through as both param and filter", () => {
    expect(normalizeBranchFilter("main")).toEqual({
      branchParam: "main",
      branchFilter: "main",
      branchAll: false,
    });
  });

  it("preserves branch names that contain slashes", () => {
    expect(normalizeBranchFilter("feature/x")).toEqual({
      branchParam: "feature/x",
      branchFilter: "feature/x",
      branchAll: false,
    });
  });
});

describe("resolveAnalyticsWindow", () => {
  const NOW = 1_700_000_000;

  it("derives windowStart, days, and rangeSec for a day range", () => {
    expect(resolveAnalyticsWindow("30d", NOW)).toEqual({
      nowSec: NOW,
      rangeSec: 30 * DAY_SEC,
      windowStartSec: NOW - 30 * DAY_SEC,
      days: 30,
    });
  });

  it("reconciles the three drifted forms to a single windowStart = now - rangeSec", () => {
    // Form (a) computed `days = rangeSec/DAY_SEC` then `now - days*DAY_SEC`;
    // form (b) computed `now - rangeSec` directly. They must agree for any
    // concrete range — this pins that they do.
    for (const r of ["7d", "14d", "30d", "90d"]) {
      const w = resolveAnalyticsWindow(r, NOW);
      expect(w.windowStartSec).toBe(NOW - (w.rangeSec ?? 0));
      expect(w.days).toBe((w.rangeSec ?? 0) / DAY_SEC);
    }
  });

  it("supports year ranges (365 days each)", () => {
    const w = resolveAnalyticsWindow("1y", NOW);
    expect(w.rangeSec).toBe(365 * DAY_SEC);
    expect(w.days).toBe(365);
    expect(w.windowStartSec).toBe(NOW - 365 * DAY_SEC);
  });

  it("treats the 'all' range as windowStart = 0 (epoch), days/rangeSec null", () => {
    expect(resolveAnalyticsWindow("all", NOW)).toEqual({
      nowSec: NOW,
      rangeSec: null,
      windowStartSec: 0,
      days: null,
    });
  });

  it("normalizes an unrecognized range to the 'all' window (windowStart 0)", () => {
    // rangeToSeconds returns undefined for junk; the resolver coalesces it to
    // null so callers get the same epoch-0 window as an explicit "all".
    const w = resolveAnalyticsWindow("nonsense", NOW);
    expect(w.rangeSec).toBeNull();
    expect(w.windowStartSec).toBe(0);
    expect(w.days).toBeNull();
  });

  it("defaults nowSec to the current clock when omitted", () => {
    const before = Math.floor(Date.now() / 1000);
    const w = resolveAnalyticsWindow("7d");
    const after = Math.floor(Date.now() / 1000);
    expect(w.nowSec).toBeGreaterThanOrEqual(before);
    expect(w.nowSec).toBeLessThanOrEqual(after);
  });
});
