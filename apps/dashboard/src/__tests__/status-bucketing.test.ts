import { describe, it, expect } from "vite-plus/test";
import { STATUS_BUCKET_MEMBERS, statusBucket } from "@/lib/ingest";

/**
 * Guards the status → aggregate-bucket mapping that two code paths must agree
 * on: the JS delta path (`statusBucket` → `computeAggregateDelta`, run on every
 * /results batch) and the SQL recompute path (`aggregateRecomputeStatement`'s
 * five `COUNT(*) WHERE status …` subqueries, run on /complete). Before this
 * suite the two encodings were hand-kept in sync; now both derive from
 * `STATUS_BUCKET_MEMBERS`, and these tests pin that single source of truth so a
 * mis-edit (e.g. dropping `timedout` from the failed bucket) fails here instead
 * of silently corrupting production aggregates.
 *
 * The recompute UPDATE itself can't be rendered to SQL under the void/db stub
 * (`db` is a throwing Proxy), so the structural parity is asserted via the
 * shared constant the recompute builds from — see aggregateRecomputeStatement.
 */
describe("STATUS_BUCKET_MEMBERS / statusBucket", () => {
  it("is the exact mapping both the JS delta and SQL recompute paths rely on", () => {
    // This is the contract the recompute subqueries encode:
    //   passed  = status = 'passed'
    //   failed  = status IN ('failed', 'timedout')
    //   flaky   = status = 'flaky'
    //   skipped = status = 'skipped'
    expect(STATUS_BUCKET_MEMBERS).toEqual({
      passed: ["passed"],
      failed: ["failed", "timedout"],
      flaky: ["flaky"],
      skipped: ["skipped"],
    });
  });

  it("routes every member status to the bucket it belongs to", () => {
    for (const [bucket, statuses] of Object.entries(STATUS_BUCKET_MEMBERS)) {
      for (const status of statuses) {
        expect(statusBucket(status)).toBe(bucket);
      }
    }
  });

  it("folds timedout into the failed bucket (the one multi-status bucket)", () => {
    expect(statusBucket("failed")).toBe("failed");
    expect(statusBucket("timedout")).toBe("failed");
  });

  it("returns null for statuses that feed no aggregate bucket", () => {
    // queued/running are tracked separately (totalTests), and unknown statuses
    // must not be silently counted into any bucket.
    expect(statusBucket("queued")).toBeNull();
    expect(statusBucket("running")).toBeNull();
    expect(statusBucket("interrupted")).toBeNull();
    expect(statusBucket("totally-unknown")).toBeNull();
  });

  it("maps each status to at most one bucket (no double-counting)", () => {
    const seen = new Set<string>();
    for (const statuses of Object.values(STATUS_BUCKET_MEMBERS)) {
      for (const status of statuses) {
        expect(seen.has(status)).toBe(false);
        seen.add(status);
      }
    }
  });
});
