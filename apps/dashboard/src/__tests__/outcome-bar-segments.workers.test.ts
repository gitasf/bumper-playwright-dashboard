import { describe, expect, it } from "vite-plus/test";
import { isOutcomeEmpty, outcomeBarSegments } from "@/components/outcome-bar";

/**
 * Pins the pure layout for the canonical stacked outcome bar. The tests catalog
 * row used to fork its own `OutcomeMix`; both now render `<OutcomeBar>`, so this
 * is the single guard against the proportional-width math, segment order, and
 * zero-total handling drifting.
 */

describe("outcomeBarSegments", () => {
  it("emits the four buckets in canonical pass → flaky → fail → skipped order", () => {
    const keys = outcomeBarSegments({
      passed: 1,
      flaky: 2,
      failed: 3,
      skipped: 4,
    }).map((s) => s.key);
    expect(keys).toEqual(["passed", "flaky", "failed", "skipped"]);
  });

  it("sizes each segment proportionally to the implicit total", () => {
    const widths = Object.fromEntries(
      outcomeBarSegments({
        passed: 5,
        flaky: 0,
        failed: 5,
        skipped: 0,
      }).map((s) => [s.key, s.widthPercent]),
    );
    expect(widths.passed).toBe(50);
    expect(widths.failed).toBe(50);
    expect(widths.flaky).toBe(0);
    expect(widths.skipped).toBe(0);
  });

  it("honours a `total` override as the denominator (fraction of a larger run)", () => {
    // 2 passed out of a 10-test run → a 20%-wide passed segment, the rest empty.
    const widths = Object.fromEntries(
      outcomeBarSegments({ passed: 2, total: 10 }).map((s) => [
        s.key,
        s.widthPercent,
      ]),
    );
    expect(widths.passed).toBe(20);
    expect(widths.flaky).toBe(0);
    expect(widths.failed).toBe(0);
    expect(widths.skipped).toBe(0);
  });

  it("avoids divide-by-zero when everything is empty (denominator floors to 1)", () => {
    for (const s of outcomeBarSegments({})) {
      expect(s.widthPercent).toBe(0);
    }
  });

  it("sources colours from the theme-aware status registry, not raw hex", () => {
    const colors = Object.fromEntries(
      outcomeBarSegments({ passed: 1, flaky: 1, failed: 1, skipped: 1 }).map(
        (s) => [s.key, s.color],
      ),
    );
    expect(colors.passed).toBe("var(--pass)");
    expect(colors.flaky).toBe("var(--flaky)");
    expect(colors.failed).toBe("var(--fail)");
    expect(colors.skipped).toBe("var(--skipped)");
  });
});

describe("isOutcomeEmpty", () => {
  it("is true only when every bucket (and any total override) is zero", () => {
    expect(isOutcomeEmpty({})).toBe(true);
    expect(isOutcomeEmpty({ passed: 0, flaky: 0, failed: 0, skipped: 0 })).toBe(
      true,
    );
    expect(isOutcomeEmpty({ passed: 1 })).toBe(false);
    expect(isOutcomeEmpty({ skipped: 3 })).toBe(false);
  });

  it("treats a non-zero total override as non-empty even with zero buckets", () => {
    // A run with a known total but no buckets yet still draws a track, not "—".
    expect(isOutcomeEmpty({ total: 5 })).toBe(false);
  });
});
