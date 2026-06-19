import { describe, expect, it } from "vite-plus/test";
import { presetRange } from "@/lib/date-range-presets";

/**
 * Pure preset → `{ from, to }` boundary math for the runs filter-bar date
 * presets (roadmap 4.1a). `presetRange` takes an injected `now` so the UTC-day
 * anchor is pinned and the windows are deterministic. Bounds are `yyyy-MM-dd`
 * strings interpreted at the UTC day boundary by `buildRunsWhere`, so every
 * assertion here is in UTC terms.
 */
describe("presetRange", () => {
  // A mid-month, mid-day UTC instant so the day anchor is unambiguous.
  const now = new Date("2026-06-14T15:30:00.000Z");

  it("24h → today only (from === to, the UTC day containing now)", () => {
    expect(presetRange("24h", now)).toEqual({
      from: "2026-06-14",
      to: "2026-06-14",
    });
  });

  it("7d → an inclusive 7-day window (today − 6 → today)", () => {
    expect(presetRange("7d", now)).toEqual({
      from: "2026-06-08",
      to: "2026-06-14",
    });
  });

  it("30d → an inclusive 30-day window (today − 29 → today)", () => {
    expect(presetRange("30d", now)).toEqual({
      from: "2026-05-16",
      to: "2026-06-14",
    });
  });

  it("this-month → the 1st of the current month → today", () => {
    expect(presetRange("this-month", now)).toEqual({
      from: "2026-06-01",
      to: "2026-06-14",
    });
  });

  it("anchors on the UTC day (an instant just before UTC midnight stays on that day)", () => {
    // 23:59 UTC on the 14th is still the 14th in UTC, even though it's the 15th
    // in many local zones — the window must track UTC because the WHERE clause
    // reads the date string as UTC midnight.
    const lateNow = new Date("2026-06-14T23:59:59.000Z");
    expect(presetRange("24h", lateNow)).toEqual({
      from: "2026-06-14",
      to: "2026-06-14",
    });
  });

  it("crosses month + year boundaries when counting back (30d from early January)", () => {
    const earlyJan = new Date("2026-01-03T12:00:00.000Z");
    // today − 29 days from 2026-01-03 lands in December 2025.
    expect(presetRange("30d", earlyJan)).toEqual({
      from: "2025-12-05",
      to: "2026-01-03",
    });
  });

  it("this-month → 1st of the month even on the 1st", () => {
    const firstOfMonth = new Date("2026-06-01T08:00:00.000Z");
    expect(presetRange("this-month", firstOfMonth)).toEqual({
      from: "2026-06-01",
      to: "2026-06-01",
    });
  });
});
