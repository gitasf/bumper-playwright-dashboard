import { describe, it, expect } from "vite-plus/test";
import { TestAccumulator } from "../accumulator.js";
import { makeTest, makeResult } from "./fixtures.js";

describe("TestAccumulator.record", () => {
  it("buffers a single passing attempt and returns it as done", () => {
    const acc = new TestAccumulator();
    const test = makeTest({ outcome: "expected" });
    const done = acc.record(
      test,
      makeResult({ status: "passed", duration: 10, retry: 0 }),
    );
    expect(done).toBeDefined();
    expect(done?.test).toBe(test);
    expect(done?.results).toHaveLength(1);
    // Once done, the entry is removed — nothing left to drain.
    expect(acc.drainPending()).toEqual([]);
  });

  it("withholds a failing attempt while retries remain, then emits one entry", () => {
    const acc = new TestAccumulator();
    const test = makeTest({ id: "flaky-1", retries: 2, outcome: "flaky" });

    // Two failing attempts: not done yet, nothing returned.
    expect(
      acc.record(
        test,
        makeResult({ status: "failed", duration: 100, retry: 0 }),
      ),
    ).toBeUndefined();
    expect(
      acc.record(
        test,
        makeResult({ status: "failed", duration: 100, retry: 1 }),
      ),
    ).toBeUndefined();

    // Final attempt passes → one done entry aggregating all three attempts.
    const done = acc.record(
      test,
      makeResult({ status: "passed", duration: 80, retry: 2 }),
    );
    expect(done).toBeDefined();
    expect(done?.results.map((r) => r.status)).toEqual([
      "failed",
      "failed",
      "passed",
    ]);
    // Removed from pending once done.
    expect(acc.drainPending()).toEqual([]);
  });

  it("treats the final exhausted-retry failure as done", () => {
    const acc = new TestAccumulator();
    const test = makeTest({ id: "fail-1", retries: 1, outcome: "unexpected" });

    expect(
      acc.record(
        test,
        makeResult({ status: "failed", duration: 50, retry: 0 }),
      ),
    ).toBeUndefined();
    const done = acc.record(
      test,
      makeResult({ status: "failed", duration: 50, retry: 1 }),
    );
    expect(done?.results).toHaveLength(2);
  });

  it("keys by test.id so concurrent tests buffer independently", () => {
    const acc = new TestAccumulator();
    const a = makeTest({ id: "a", retries: 1, outcome: "unexpected" });
    const b = makeTest({ id: "b", outcome: "expected" });

    // a's first failure is withheld...
    expect(
      acc.record(a, makeResult({ status: "failed", duration: 10, retry: 0 })),
    ).toBeUndefined();
    // ...while b completes independently.
    const bDone = acc.record(
      b,
      makeResult({ status: "passed", duration: 5, retry: 0 }),
    );
    expect(bDone?.test).toBe(b);

    // a is still pending until its final retry resolves.
    const aDone = acc.record(
      a,
      makeResult({ status: "passed", duration: 12, retry: 1 }),
    );
    expect(aDone?.test).toBe(a);
    expect(aDone?.results).toHaveLength(2);
  });
});

describe("TestAccumulator.drainPending", () => {
  it("yields still-buffered (never-done) entries and clears the map", () => {
    const acc = new TestAccumulator();
    const test = makeTest({ id: "stuck", retries: 2, outcome: "unexpected" });

    // A failed attempt with retries remaining stays buffered (worker killed
    // before the final retry, say).
    expect(
      acc.record(
        test,
        makeResult({ status: "failed", duration: 99, retry: 0 }),
      ),
    ).toBeUndefined();

    const drained = acc.drainPending();
    expect(drained).toHaveLength(1);
    expect(drained[0].test).toBe(test);
    expect(drained[0].results).toHaveLength(1);

    // Map is cleared — a second drain yields nothing.
    expect(acc.drainPending()).toEqual([]);
  });

  it("returns empty when everything already completed", () => {
    const acc = new TestAccumulator();
    const test = makeTest({ outcome: "expected" });
    acc.record(test, makeResult({ status: "passed", duration: 1, retry: 0 }));
    expect(acc.drainPending()).toEqual([]);
  });
});
