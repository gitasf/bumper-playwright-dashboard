import { describe, expect, it } from "vite-plus/test";
import { runOutcomeTotals } from "@/lib/runs/outcome";

/**
 * Pins the Outcome column's denominator/pending math (`<RunListRow>` renders
 * straight from this): the full declared suite size wins over the
 * reported-so-far buckets, with `totalTests` as the legacy/mixed-version
 * backstop and the buckets as the over-report floor.
 */

const counts = (
  over: Partial<Parameters<typeof runOutcomeTotals>[0]> = {},
) => ({
  passed: 0,
  failed: 0,
  flaky: 0,
  skipped: 0,
  totalTests: 0,
  expectedTotalTests: null,
  ...over,
});

describe("runOutcomeTotals", () => {
  it("uses the declared suite size as the denominator while results stream", () => {
    // 30 of 120 reported: the bar shows 30/120 with 90 pending.
    const { reported, total, pending } = runOutcomeTotals(
      counts({
        passed: 25,
        failed: 5,
        expectedTotalTests: 120,
        totalTests: 120,
      }),
    );
    expect(reported).toBe(30);
    expect(total).toBe(120);
    expect(pending).toBe(90);
  });

  it("pending reaches zero when every declared test has reported", () => {
    const { total, pending } = runOutcomeTotals(
      counts({
        passed: 100,
        failed: 10,
        flaky: 5,
        skipped: 5,
        expectedTotalTests: 120,
        totalTests: 120,
      }),
    );
    expect(total).toBe(120);
    expect(pending).toBe(0);
  });

  it("falls back to totalTests for a legacy run with no declared count", () => {
    // Pre-column runs: expectedTotalTests is null; totalTests (which includes
    // the queued prefill) is the best available denominator.
    const { total, pending } = runOutcomeTotals(
      counts({ passed: 3, totalTests: 10, expectedTotalTests: null }),
    );
    expect(total).toBe(10);
    expect(pending).toBe(7);
  });

  it("keeps the mixed-version backstop: totalTests wins when the shard sum undercounts", () => {
    // Sharded run whose opener predates shard-aware opens: the per-shard sum
    // (expectedTotalTests) is missing the opener's slice, but rows already
    // landed for it — totalTests is larger and must win.
    const { total } = runOutcomeTotals(
      counts({ passed: 4, expectedTotalTests: 3, totalTests: 7 }),
    );
    expect(total).toBe(7);
  });

  it("floors the denominator at the reported buckets so an over-report can't overflow the bar", () => {
    const { total, pending } = runOutcomeTotals(
      counts({ passed: 6, failed: 2, expectedTotalTests: 5, totalTests: 5 }),
    );
    expect(total).toBe(8);
    expect(pending).toBe(0);
  });

  it("degrades to the old buckets-only behavior when nothing else is known", () => {
    const { reported, total, pending } = runOutcomeTotals(
      counts({ passed: 2, failed: 1 }),
    );
    expect(reported).toBe(3);
    expect(total).toBe(3);
    expect(pending).toBe(0);
  });
});
