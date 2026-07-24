import { describe, expect, it } from "vite-plus/test";
import { describeError, MAX_CAUSE_DEPTH } from "@/lib/error-cause";

/**
 * `describeError` backs the error → page mapper (middleware/00.errors.ts) and
 * cron `loggedScheduled`, so it must never throw whatever shape of `.cause`
 * chain it's handed: self-cause, cycles, or a pathologically deep chain.
 */
describe("describeError", () => {
  it("serializes a normal cause chain, including pg diagnostic fields", () => {
    const driverErr = Object.assign(new Error('relation "x" does not exist'), {
      code: "42P01",
      severity: "ERROR",
    });
    const wrapper = new Error("Failed query: select * from x", {
      cause: driverErr,
    });

    const result = describeError(wrapper);

    expect(result.message).toBe("Failed query: select * from x");
    expect(result.cause).toEqual(
      expect.objectContaining({
        message: 'relation "x" does not exist',
        code: "42P01",
        severity: "ERROR",
      }),
    );
    // The cause is serialized without its stack, to keep the log readable.
    expect((result.cause as Record<string, unknown>).stack).toBeUndefined();
  });

  it("falls back to a stringified message for non-Error values", () => {
    expect(describeError("boom")).toEqual({ message: "boom" });
  });

  it("omits cause when there is none", () => {
    expect("cause" in describeError(new Error("plain"))).toBe(false);
  });

  it("terminates on a direct self-cause instead of recursing forever", () => {
    const err = new Error("self-referential");
    (err as Error & { cause?: unknown }).cause = err;

    expect(() => describeError(err)).not.toThrow();
    const result = describeError(err);
    expect(result.message).toBe("self-referential");
    expect(result.cause).toBeUndefined();
  });

  it("terminates on a 2-cycle cause chain (a.cause = b, b.cause = a)", () => {
    const a = new Error("a");
    const b = new Error("b");
    (a as Error & { cause?: unknown }).cause = b;
    (b as Error & { cause?: unknown }).cause = a;

    expect(() => describeError(a)).not.toThrow();
    const result = describeError(a);
    expect(result.message).toBe("a");
    expect((result.cause as Record<string, unknown>).message).toBe("b");
    // Back at `a` — already seen — so the chain stops instead of looping.
    expect((result.cause as Record<string, unknown>).cause).toBeUndefined();
  });

  it("bounds recursion depth on a pathologically long acyclic chain", () => {
    const depth = MAX_CAUSE_DEPTH + 20;
    let root = new Error("error-0");
    for (let i = 1; i <= depth; i++) {
      root = new Error(`error-${i}`, { cause: root });
    }

    expect(() => describeError(root)).not.toThrow();

    let node: Record<string, unknown> = describeError(root);
    let seenDepth = 0;
    while (node.cause != null) {
      seenDepth++;
      node = node.cause as Record<string, unknown>;
    }

    expect(seenDepth).toBeLessThanOrEqual(MAX_CAUSE_DEPTH);
    expect(seenDepth).toBeLessThan(depth);
  });
});
