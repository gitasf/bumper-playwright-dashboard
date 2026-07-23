import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { TenantScope } from "@/lib/scope";

/**
 * `resolveRunDiff` (roadmap 2.4) — the head+base resolution + diff assembly
 * that the run-diff page loader AND the JSON API route share. Previously this
 * orchestration was open-coded verbatim in both adapters and 0%-tested; the
 * decision branches it owns are the bug surface, so they're pinned here:
 *   - a missing/foreign HEAD is the ONLY 404 (`{ notFound: true }`);
 *   - an explicit `baseParam === runId` (self-compare guard) yields no base
 *     WITHOUT a second lookup;
 *   - a foreign/missing explicit base degrades to `null` (empty diff, not 404);
 *   - `diffRuns(base, head)` is called in THAT argument order.
 *
 * The void/db stub yields a FIFO queue of result-sets (default `[]`) in query
 * order — loadDiffRunRef(head) → [base lookup] → loadRunTestStatuses(head) →
 * [loadRunTestStatuses(base)] — and counts queries so the self-compare path can
 * assert the base lookup never fired.
 */

let resultQueue: unknown[][] = [];
let queryCount = 0;

vi.mock("void/db", async () => {
  const stub = await import("./helpers/void-db-stub");
  const node: Record<string, unknown> = {};
  const chain = () => node;
  node.from = chain;
  node.where = chain;
  node.orderBy = chain;
  node.limit = chain;
  (node as { then: unknown }).then = (
    onFulfilled?: (v: unknown) => unknown,
  ) => {
    queryCount += 1;
    const next = resultQueue.shift() ?? [];
    return Promise.resolve(onFulfilled ? onFulfilled(next) : next);
  };
  const db = { select: chain };
  return { ...stub, db };
});

const { resolveRunDiff } = await import("@/lib/runs/diff");

const scope: TenantScope = {
  teamId: "team_abc" as TenantScope["teamId"],
  projectId: "proj_xyz" as TenantScope["projectId"],
  teamSlug: "acme",
  projectSlug: "web",
};

function runRef(id: string, status = "passed", branch: string | null = "main") {
  return {
    id,
    status,
    branch,
    commitSha: null,
    commitMessage: null,
    createdAt: 1000,
  };
}

function statusRow(testId: string, status: string) {
  return { testId, status, durationMs: 100, retryCount: 0 };
}

beforeEach(() => {
  resultQueue = [];
  queryCount = 0;
});

describe("resolveRunDiff", () => {
  it("returns { notFound: true } when the head run is missing/foreign (the only 404)", async () => {
    resultQueue = [[]]; // head lookup → no row
    const result = await resolveRunDiff(scope, "run_head");
    expect(result).toEqual({ notFound: true });
    expect(queryCount).toBe(1); // short-circuits before any base/status load
  });

  it("self-compare (baseParam === runId) yields no base WITHOUT a second lookup", async () => {
    // Q1 head, Q3 head-statuses only — NO base lookup, NO base statuses.
    resultQueue = [[runRef("run_head")], [statusRow("t1", "passed")]];
    const result = await resolveRunDiff(scope, "run_head", {
      baseParam: "run_head",
    });
    expect("notFound" in result).toBe(false);
    if ("notFound" in result) return;
    expect(result.base).toBeNull();
    expect(result.diff).toBeNull();
    expect(queryCount).toBe(2); // head + head-statuses; base lookup never fired
  });

  it("degrades a foreign/missing explicit base to null (empty diff, not a 404)", async () => {
    // Q1 head present, Q2 base lookup → empty (foreign), Q3 head-statuses.
    resultQueue = [[runRef("run_head")], [], [statusRow("t1", "passed")]];
    const result = await resolveRunDiff(scope, "run_head", {
      baseParam: "run_other_project",
    });
    expect("notFound" in result).toBe(false);
    if ("notFound" in result) return;
    expect(result.head.id).toBe("run_head");
    expect(result.base).toBeNull();
    expect(result.diff).toBeNull();
  });

  it("diffs an explicit valid base in diffRuns(base, head) order", async () => {
    // base has t1 failing, head has t1 passing → t1 is newlyPassed. If the
    // argument order were swapped it would land in newlyFailed instead.
    resultQueue = [
      [runRef("run_head")], // Q1 head
      [runRef("run_base")], // Q2 explicit base lookup
      [statusRow("t1", "passed")], // Q3 head statuses
      [statusRow("t1", "failed")], // Q4 base statuses
    ];
    const result = await resolveRunDiff(scope, "run_head", {
      baseParam: "run_base",
    });
    expect("notFound" in result).toBe(false);
    if ("notFound" in result) return;
    expect(result.base?.id).toBe("run_base");
    expect(result.diff?.newlyPassed.map((c) => c.testId)).toEqual(["t1"]);
    expect(result.diff?.newlyFailed).toEqual([]);
  });

  it("auto-resolves the base when no baseParam is given", async () => {
    resultQueue = [
      [runRef("run_head")], // Q1 head (branch "main")
      [runRef("run_base")], // Q2 resolveBaseRun pick
      [statusRow("t1", "passed")], // Q3 head statuses
      [statusRow("t1", "passed")], // Q4 base statuses
    ];
    const result = await resolveRunDiff(scope, "run_head");
    expect("notFound" in result).toBe(false);
    if ("notFound" in result) return;
    expect(result.base?.id).toBe("run_base");
    expect(result.diff).not.toBeNull();
  });
});
