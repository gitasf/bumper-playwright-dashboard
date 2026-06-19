import { describe, it, expect } from "vite-plus/test";
import { computeAggregateDelta } from "@/lib/ingest";

const noPrev = new Map<string, string>();

describe("computeAggregateDelta", () => {
  it("counts a fresh insert with a final status as +1 totalTests + 1 bucket", () => {
    const delta = computeAggregateDelta(
      [{ testId: "t1", status: "passed" }],
      noPrev,
    );
    expect(delta).toEqual({
      totalTests: 1,
      passed: 1,
      failed: 0,
      flaky: 0,
      skipped: 0,
    });
  });

  it("merges timedout into the failed bucket on insert", () => {
    const delta = computeAggregateDelta(
      [{ testId: "t1", status: "timedout" }],
      noPrev,
    );
    expect(delta).toEqual({
      totalTests: 1,
      passed: 0,
      failed: 1,
      flaky: 0,
      skipped: 0,
    });
  });

  it("transitions queued → final without changing totalTests", () => {
    const prev = new Map<string, string>([["t1", "queued"]]);
    const delta = computeAggregateDelta(
      [{ testId: "t1", status: "passed" }],
      prev,
    );
    expect(delta).toEqual({
      totalTests: 0,
      passed: 1,
      failed: 0,
      flaky: 0,
      skipped: 0,
    });
  });

  it("rebalances a non-queued retry: -prev bucket, +next bucket", () => {
    const prev = new Map<string, string>([["t1", "failed"]]);
    const delta = computeAggregateDelta(
      [{ testId: "t1", status: "passed" }],
      prev,
    );
    expect(delta).toEqual({
      totalTests: 0,
      passed: 1,
      failed: -1,
      flaky: 0,
      skipped: 0,
    });
  });

  it("treats failed→timedout as a no-op (both feed the same bucket)", () => {
    const prev = new Map<string, string>([["t1", "failed"]]);
    const delta = computeAggregateDelta(
      [{ testId: "t1", status: "timedout" }],
      prev,
    );
    expect(delta).toEqual({
      totalTests: 0,
      passed: 0,
      failed: 0,
      flaky: 0,
      skipped: 0,
    });
  });

  it("aggregates multiple results with mixed transitions", () => {
    const prev = new Map<string, string>([
      ["t1", "queued"],
      ["t2", "failed"],
    ]);
    const delta = computeAggregateDelta(
      [
        { testId: "t1", status: "passed" },
        { testId: "t2", status: "flaky" },
        { testId: "t3", status: "failed" },
      ],
      prev,
    );
    expect(delta).toEqual({
      totalTests: 1,
      passed: 1,
      failed: 0,
      flaky: 1,
      skipped: 0,
    });
  });
});
