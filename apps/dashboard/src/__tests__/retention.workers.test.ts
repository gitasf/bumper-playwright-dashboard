import { describe, expect, it } from "vite-plus/test";
import {
  chunkIdsForInList,
  createSweepBudget,
  drainRetention,
  resolveRetentionWindows,
  type RetentionSweepResult,
} from "@/lib/retention";

/**
 * Pure core of the two-axis retention sweep — the per-team window resolution.
 * The DB/R2-touching `sweepRetention` is exercised end-to-end by the e2e
 * dogfood suite (per the standing real-D1-harness gap).
 */

const DEFAULTS = { artifactDays: 30, testResultDays: 90 };

describe("resolveRetentionWindows", () => {
  it("falls back to the env defaults when a team sets neither override", () => {
    expect(
      resolveRetentionWindows(
        { retentionArtifactDays: null, retentionTestResultsDays: null },
        DEFAULTS,
      ),
    ).toEqual({ artifactDays: 30, testResultDays: 90 });
  });

  it("uses a team override where present, default where null", () => {
    expect(
      resolveRetentionWindows(
        { retentionArtifactDays: 7, retentionTestResultsDays: null },
        DEFAULTS,
      ),
    ).toEqual({ artifactDays: 7, testResultDays: 90 });

    expect(
      resolveRetentionWindows(
        { retentionArtifactDays: null, retentionTestResultsDays: 365 },
        DEFAULTS,
      ),
    ).toEqual({ artifactDays: 30, testResultDays: 365 });
  });

  it("honors both overrides when both are set", () => {
    expect(
      resolveRetentionWindows(
        { retentionArtifactDays: 14, retentionTestResultsDays: 180 },
        DEFAULTS,
      ),
    ).toEqual({ artifactDays: 14, testResultDays: 180 });
  });
});

/**
 * The IN-list chunker for the per-project delete/R2-cleanup loops. It defers the
 * bound-param ceiling to `chunkByParams` (ingest.ts) rather than carrying its own
 * magic number — this asserts the seam is wired correctly, not the cap's math
 * (the cap is covered by ingest's own chunk tests).
 */
describe("chunkIdsForInList", () => {
  it("returns no chunks for an empty id list", () => {
    expect(chunkIdsForInList([])).toEqual([]);
  });

  it("keeps a realistically-sized per-pass slice in a single chunk", () => {
    // Each id binds one param against a 65_535 ceiling, so a `.limit`-bounded
    // slice (here far larger than any real per-pass limit) never needs splitting.
    const ids = Array.from({ length: 5_000 }, (_, i) => `id-${i}`);
    const chunks = chunkIdsForInList(ids);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(5_000);
  });

  it("preserves order and partitions all ids without loss or overlap", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `id-${i}`);
    const chunks = chunkIdsForInList(ids);
    expect(chunks.flat()).toEqual(ids);
  });

  it("reserves the fixed projectId bind: a full chunk + projectId never exceeds 65_535", () => {
    // The statement is `WHERE projectId = $1 AND id IN (chunk)`, so a full chunk
    // must leave room for the lone projectId bind: `chunk.length + 1 <= 65_535`,
    // i.e. each chunk binds at most 65_534 ids. A list one past that boundary
    // splits into a max chunk + a remainder rather than a single 65_535-id chunk
    // that would overflow once projectId is bound.
    const ids = Array.from({ length: 65_535 }, (_, i) => `id-${i}`);
    const chunks = chunkIdsForInList(ids);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(65_534);
    expect(chunks[1]).toHaveLength(1);
    for (const chunk of chunks) {
      expect(chunk.length + 1).toBeLessThanOrEqual(65_535);
    }
    expect(chunks.flat()).toEqual(ids);
  });
});

/**
 * The execution budget the drain runs against — wall-clock deadline OR a
 * chunk-count ceiling, whichever comes first. Injected clock keeps it
 * deterministic.
 */
describe("createSweepBudget", () => {
  it("has budget before the deadline and none at/after it", () => {
    let t = 0;
    const budget = createSweepBudget({
      deadlineAtMs: 100,
      maxChunks: 1_000_000,
      clock: () => t,
    });
    expect(budget.hasRemaining()).toBe(true);
    t = 99;
    expect(budget.hasRemaining()).toBe(true);
    t = 100; // deadline is exclusive
    expect(budget.hasRemaining()).toBe(false);
    t = 200;
    expect(budget.hasRemaining()).toBe(false);
  });

  it("runs out once the chunk ceiling is reached, independent of time", () => {
    const budget = createSweepBudget({
      deadlineAtMs: Number.MAX_SAFE_INTEGER,
      maxChunks: 2,
      clock: () => 0,
    });
    expect(budget.hasRemaining()).toBe(true);
    budget.recordChunk();
    expect(budget.hasRemaining()).toBe(true); // 1 < 2
    budget.recordChunk();
    expect(budget.hasRemaining()).toBe(false); // 2 >= 2
  });
});

/**
 * The pure drain policy: round-robin across projects, keep going until the
 * budget is spent or a full round frees nothing. Exercised against a fake
 * `sweepOne` + injected budget so the loop logic is tested without db/R2.
 */
describe("drainRetention", () => {
  const EMPTY: RetentionSweepResult = {
    artifactsDeleted: 0,
    artifactObjectsDeleted: 0,
    testResultsDeleted: 0,
  };
  // Time never binds; only the chunk ceiling does.
  const budget = (maxChunks: number) =>
    createSweepBudget({
      deadlineAtMs: Number.MAX_SAFE_INTEGER,
      maxChunks,
      clock: () => 0,
    });

  it("does nothing for an empty project list", async () => {
    let calls = 0;
    const result = await drainRetention(
      [],
      () => {
        calls++;
        return Promise.resolve(EMPTY);
      },
      budget(1000),
    );
    expect(calls).toBe(0);
    expect(result).toEqual({
      artifactsDeleted: 0,
      artifactObjectsDeleted: 0,
      testResultsDeleted: 0,
    });
  });

  it("stops after one round when nothing is left to delete (no progress)", async () => {
    let calls = 0;
    const result = await drainRetention(
      ["p1"],
      () => {
        calls++;
        return Promise.resolve(EMPTY);
      },
      budget(1_000_000),
    );
    // One visit found nothing → the round made no progress → stop (don't spin
    // against the whole budget).
    expect(calls).toBe(1);
    expect(result.testResultsDeleted).toBe(0);
  });

  it("keeps draining across rounds until a round frees nothing, accumulating counts", async () => {
    let calls = 0;
    const result = await drainRetention(
      ["p1"],
      () => {
        calls++;
        // Two productive rounds, then empty.
        if (calls <= 2) {
          return Promise.resolve({
            artifactsDeleted: 1,
            artifactObjectsDeleted: 3,
            testResultsDeleted: 10,
          });
        }
        return Promise.resolve(EMPTY);
      },
      budget(1_000_000),
    );
    expect(calls).toBe(3); // 2 productive + 1 idle round that ends it
    expect(result).toEqual({
      artifactsDeleted: 2,
      artifactObjectsDeleted: 6,
      testResultsDeleted: 20,
    });
  });

  it("stops when the chunk budget runs out even if work remains", async () => {
    let calls = 0;
    const result = await drainRetention(
      ["p1"],
      () => {
        calls++;
        // Always more to delete — only the budget can stop this.
        return Promise.resolve({
          artifactsDeleted: 0,
          artifactObjectsDeleted: 0,
          testResultsDeleted: 5,
        });
      },
      budget(3), // 3 chunks, then stop
    );
    expect(calls).toBe(3);
    expect(result.testResultsDeleted).toBe(15);
  });

  it("round-robins: every project is visited within a round", async () => {
    const visited: string[] = [];
    await drainRetention(
      ["p1", "p2", "p3"],
      (p) => {
        visited.push(p);
        return Promise.resolve(EMPTY);
      },
      budget(1_000_000),
    );
    // One round (all empty → no progress → stop), each project once.
    expect(visited).toEqual(["p1", "p2", "p3"]);
  });

  it("idle projects do NOT consume the chunk budget (the tail is never starved)", async () => {
    // Far more projects than the tiny chunk budget, ALL idle. Before the fix,
    // each idle probe charged a chunk, so only `maxChunks` projects were ever
    // visited and the rest starved every pass. Now an idle sweep costs no chunk,
    // so the whole list is probed in the single (no-progress) round.
    const projects = Array.from({ length: 200 }, (_, i) => `p${i}`);
    const visited: string[] = [];
    await drainRetention(
      projects,
      (p) => {
        visited.push(p);
        return Promise.resolve(EMPTY);
      },
      budget(5), // a budget far smaller than the project count
    );
    expect(visited).toEqual(projects); // every project reached despite budget=5
  });

  it("a productive head does not starve the idle tail: the tail is reached before the budget is spent", async () => {
    // p-busy always has work; the rest are idle. Because idle sweeps don't charge
    // the budget, round 1 reaches the WHOLE list (both idle projects) before the
    // budget is spent — the fix. (Before, each idle probe charged a chunk, so a
    // budget(2) would be exhausted at p-idle-1 and p-idle-2 would never be seen.)
    const projects = ["p-busy", "p-idle-1", "p-idle-2"];
    const visited: string[] = [];
    await drainRetention(
      projects,
      (p) => {
        visited.push(p);
        return Promise.resolve(
          p === "p-busy"
            ? {
                artifactsDeleted: 0,
                artifactObjectsDeleted: 0,
                testResultsDeleted: 5,
              }
            : EMPTY,
        );
      },
      budget(2), // only p-busy's chunks count → 2 productive rounds
    );
    // Round 1 visits all three (p-busy productive → charge #1; both idle → free).
    // Round 2 visits p-busy (charge #2 → budget hits 2) then stops. Crucially the
    // idle tail WAS reached (in round 1), which the pre-fix idle-charging blocked.
    expect(visited).toEqual(["p-busy", "p-idle-1", "p-idle-2", "p-busy"]);
    expect(visited).toContain("p-idle-2");
  });
});
