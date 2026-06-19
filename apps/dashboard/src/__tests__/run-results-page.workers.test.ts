import { describe, expect, it } from "vite-plus/test";
import {
  clampRunResultsLimit,
  decodeCursor,
  encodeCursor,
  MAX_RUN_RESULTS_LIMIT,
  normalizeTestStatus,
} from "@/lib/run-results-page";

/**
 * `loadRunResultsPage` is the one canonical "first page of a run's
 * testResults as RunProgressTest[]" seam, consumed by BOTH the GET /results
 * back-paginator and the run-detail SSR loader. The query/ownership pieces
 * hit D1 (not unit-testable under the void/db stub), but the cursor codec,
 * limit clamp, and status normalizer are pure — and they are exactly the
 * contract the two callers must agree on. These tests pin that contract.
 */
describe("run-results-page cursor codec", () => {
  it("round-trips a (createdAt, id) tuple through encode/decode", () => {
    const cursor = encodeCursor(1717000000000, "01HZXABCDEF");
    expect(decodeCursor(cursor)).toEqual({
      createdAt: 1717000000000,
      id: "01HZXABCDEF",
    });
  });

  it("treats a null cursor as first-page", () => {
    expect(decodeCursor(null)).toBeNull();
  });

  it("degrades malformed base64 to first-page rather than throwing", () => {
    // `atob` rejects this — must be swallowed into a null (first-page) cursor.
    expect(decodeCursor("not valid base64!!")).toBeNull();
  });

  it("rejects a cursor missing the separator", () => {
    expect(decodeCursor(btoa("1717000000000"))).toBeNull();
  });

  it("rejects a cursor with an empty id", () => {
    expect(decodeCursor(btoa("1717000000000:"))).toBeNull();
  });

  it("rejects a cursor with a non-numeric createdAt", () => {
    expect(decodeCursor(btoa("abc:01HZX"))).toBeNull();
  });

  it("rejects a cursor whose separator is at position 0", () => {
    // sep <= 0 means there is no createdAt segment.
    expect(decodeCursor(btoa(":01HZX"))).toBeNull();
  });

  it("preserves ids that themselves contain a colon", () => {
    // indexOf finds the FIRST colon, so the id keeps any later colons.
    const cursor = encodeCursor(42, "a:b:c");
    expect(decodeCursor(cursor)).toEqual({ createdAt: 42, id: "a:b:c" });
  });
});

describe("run-results-page limit clamp", () => {
  it("keeps an in-range limit untouched", () => {
    expect(clampRunResultsLimit(200)).toBe(200);
  });

  it("floors a non-positive limit to 1", () => {
    expect(clampRunResultsLimit(0)).toBe(1);
    expect(clampRunResultsLimit(-5)).toBe(1);
  });

  it("caps a limit above the maximum", () => {
    expect(clampRunResultsLimit(MAX_RUN_RESULTS_LIMIT + 1)).toBe(
      MAX_RUN_RESULTS_LIMIT,
    );
    expect(clampRunResultsLimit(100_000)).toBe(MAX_RUN_RESULTS_LIMIT);
  });
});

describe("run-results-page status normalization", () => {
  it("passes through every known status unchanged", () => {
    for (const s of [
      "queued",
      "passed",
      "failed",
      "flaky",
      "skipped",
      "timedout",
    ]) {
      expect(normalizeTestStatus(s)).toBe(s);
    }
  });

  it("coerces unknown statuses to queued so the SSR seed matches paged rows", () => {
    // This is the divergence F34 fixes: the run-detail loader used to skip
    // normalization while the paginator applied it.
    expect(normalizeTestStatus("running")).toBe("queued");
    expect(normalizeTestStatus("")).toBe("queued");
    expect(normalizeTestStatus("PASSED")).toBe("queued");
  });
});
