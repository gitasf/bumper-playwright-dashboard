import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { TenantScope } from "@/lib/scope";
import type { RunTestStatus } from "@/lib/runs/diff";

/**
 * Run-diff tests (roadmap 2.4). Two surfaces:
 *
 *  1. The pure `diffRuns` rule — every bucket (newly failed/passed, still
 *     failing, flaky deltas, added/removed) plus the identical/no-change case,
 *     and duration deltas. The highest-value test: this is the load-bearing
 *     classification logic. Unit-tested directly, no DB.
 *
 *  2. `resolveBaseRun` scoping — the query MUST filter by the scope's
 *     `(teamId, projectId)`, the head's branch, status='passed', and pick the
 *     most recent run strictly before head via the same-second-safe boundary
 *     `or(createdAt < head, createdAt == head AND id < head.id)` ordered
 *     `createdAt DESC, id DESC LIMIT 1`. Mirrors `quarantine-repo.test.ts`'s
 *     void/db-stub idiom: a chainable spy records the WHERE/orderBy/limit so we
 *     can assert the exact predicate, and a different scope binds a different
 *     projectId (cross-tenant isolation).
 */

// ─── Controllable void/db mock (for resolveBaseRun) ──────────────────────────

let capturedWhere: unknown = null;
let capturedOrderBy: unknown = null;
let capturedLimit: unknown = null;

vi.mock("void/db", async () => {
  const stub = await import("./helpers/void-db-stub");
  const node: Record<string, unknown> = {};
  const chain = () => node;
  node.from = chain;
  node.where = (w: unknown) => {
    capturedWhere = w;
    return node;
  };
  node.orderBy = (o: unknown) => {
    capturedOrderBy = o;
    return node;
  };
  node.limit = (n: unknown) => {
    capturedLimit = n;
    return node;
  };
  (node as { then: unknown }).then = (onFulfilled?: (v: unknown) => unknown) =>
    Promise.resolve(onFulfilled ? onFulfilled([]) : []);

  const db = { select: chain };
  return { ...stub, db };
});

const { diffRuns, resolveBaseRun, verdictOf } = await import("@/lib/runs/diff");

type RecordedOp = { __op: string; args: readonly unknown[] };

function readEq(node: unknown): { column: string; value: unknown } {
  const op = node as RecordedOp;
  expect(op.__op).toBe("eq");
  const column = (op.args[0] as { name?: unknown })?.name;
  return { column: column as string, value: op.args[1] };
}

/** Recursively flatten an `and(...)` tree to its leaf recorded ops. */
function flattenAnd(node: unknown): RecordedOp[] {
  const op = node as RecordedOp;
  if (op.__op === "and") {
    return op.args.flatMap((a) => flattenAnd(a));
  }
  return [op];
}

const scope: TenantScope = {
  teamId: "team_abc" as TenantScope["teamId"],
  projectId: "proj_xyz" as TenantScope["projectId"],
  teamSlug: "acme",
  projectSlug: "web",
};

const otherScope: TenantScope = {
  teamId: "team_def" as TenantScope["teamId"],
  projectId: "proj_OTHER" as TenantScope["projectId"],
  teamSlug: "other",
  projectSlug: "site",
};

function row(
  testId: string,
  status: string,
  durationMs = 100,
  retryCount = 0,
): RunTestStatus {
  return { testId, status, durationMs, retryCount };
}

beforeEach(() => {
  capturedWhere = null;
  capturedOrderBy = null;
  capturedLimit = null;
});

// ─── verdictOf (taxonomy) ────────────────────────────────────────────────────

describe("verdictOf", () => {
  it("maps failed / timedout / interrupted to failing", () => {
    expect(verdictOf("failed")).toBe("failing");
    expect(verdictOf("timedout")).toBe("failing");
    expect(verdictOf("interrupted")).toBe("failing");
  });

  it("maps passed and flaky to passing (flaky ended green)", () => {
    expect(verdictOf("passed")).toBe("passing");
    expect(verdictOf("flaky")).toBe("passing");
  });

  it("maps skipped / queued / unknown to other", () => {
    expect(verdictOf("skipped")).toBe("other");
    expect(verdictOf("queued")).toBe("other");
    expect(verdictOf("brand-new-status")).toBe("other");
  });
});

// ─── diffRuns (the load-bearing pure logic) ──────────────────────────────────

describe("diffRuns", () => {
  it("returns an all-empty diff for two identical runs (no-change case)", () => {
    const runRows = [
      row("a", "passed"),
      row("b", "failed"),
      row("c", "skipped"),
    ];
    const diff = diffRuns(runRows, runRows);
    expect(diff).toEqual({
      newlyFailed: [],
      newlyPassed: [],
      // b is failing in both → still failing, NOT empty.
      stillFailing: [
        {
          testId: "b",
          baseStatus: "failed",
          headStatus: "failed",
          durationDeltaMs: 0,
        },
      ],
      flakyDeltas: [],
      addedTests: [],
      removedTests: [],
    });
  });

  it("classifies a passed→failed test as newlyFailed with a duration delta", () => {
    const diff = diffRuns([row("a", "passed", 100)], [row("a", "failed", 250)]);
    expect(diff.newlyFailed).toEqual([
      {
        testId: "a",
        baseStatus: "passed",
        headStatus: "failed",
        durationDeltaMs: 150,
      },
    ]);
    expect(diff.newlyPassed).toEqual([]);
    expect(diff.stillFailing).toEqual([]);
  });

  it("treats timedout/interrupted in head as newly failed when base passed", () => {
    const diff = diffRuns(
      [row("a", "passed"), row("b", "passed")],
      [row("a", "timedout"), row("b", "interrupted")],
    );
    expect(diff.newlyFailed.map((r) => r.testId)).toEqual(["a", "b"]);
  });

  it("treats a skipped→failed test as newlyFailed (other → failing)", () => {
    const diff = diffRuns([row("a", "skipped")], [row("a", "failed")]);
    expect(diff.newlyFailed.map((r) => r.testId)).toEqual(["a"]);
  });

  it("classifies a failed→passed test as newlyPassed", () => {
    const diff = diffRuns([row("a", "failed", 300)], [row("a", "passed", 120)]);
    expect(diff.newlyPassed).toEqual([
      {
        testId: "a",
        baseStatus: "failed",
        headStatus: "passed",
        durationDeltaMs: -180,
      },
    ]);
    expect(diff.newlyFailed).toEqual([]);
  });

  it("treats a failed→flaky test as newlyPassed (flaky verdict is passing)", () => {
    const diff = diffRuns([row("a", "failed")], [row("a", "flaky", 100, 1)]);
    expect(diff.newlyPassed.map((r) => r.testId)).toEqual(["a"]);
    // It must NOT also appear in flakyDeltas (already a status change).
    expect(diff.flakyDeltas).toEqual([]);
  });

  it("classifies a failed→failed test as stillFailing", () => {
    const diff = diffRuns(
      [row("a", "failed", 200)],
      [row("a", "timedout", 200)],
    );
    expect(diff.stillFailing).toEqual([
      {
        testId: "a",
        baseStatus: "failed",
        headStatus: "timedout",
        durationDeltaMs: 0,
      },
    ]);
    expect(diff.newlyFailed).toEqual([]);
    expect(diff.newlyPassed).toEqual([]);
  });

  it("does NOT treat failed→skipped as newlyPassed (other is not passing)", () => {
    const diff = diffRuns([row("a", "failed")], [row("a", "skipped")]);
    expect(diff.newlyPassed).toEqual([]);
    expect(diff.newlyFailed).toEqual([]);
    expect(diff.stillFailing).toEqual([]);
    // It also isn't a flaky delta (no retries, neither row is flaky).
    expect(diff.flakyDeltas).toEqual([]);
  });

  it("does NOT report failing→other as a flakyDelta even when retryCount differs", () => {
    // A test that failed after retries (rc>0) then stopped running (skipped) must
    // not be mislabeled flaky — a failing verdict on either side is never a flaky
    // delta. (Regression for the flaky-block guard.)
    const diff = diffRuns(
      [row("a", "failed", 100, 2)],
      [row("a", "skipped", 0, 0)],
    );
    expect(diff.flakyDeltas).toEqual([]);
    expect(diff.newlyFailed).toEqual([]);
    expect(diff.newlyPassed).toEqual([]);
    expect(diff.stillFailing).toEqual([]);
    // Same for timedout(rc)→queued.
    const diff2 = diffRuns(
      [row("b", "timedout", 100, 1)],
      [row("b", "queued", 0, 0)],
    );
    expect(diff2.flakyDeltas).toEqual([]);
  });

  it("does NOT report other→other (skipped→skipped) retryCount change as a flakyDelta", () => {
    // A skipped test never ran, so a retryCount delta on it is noise, not flaky.
    const diff = diffRuns(
      [row("a", "skipped", 0, 0)],
      [row("a", "skipped", 0, 1)],
    );
    expect(diff.flakyDeltas).toEqual([]);
    expect(diff.newlyFailed).toEqual([]);
    expect(diff.newlyPassed).toEqual([]);
    expect(diff.stillFailing).toEqual([]);
  });

  it("nulls the duration delta when a side didn't run (skipped→failed)", () => {
    // Base skipped (durationMs 0, never ran) → the head's full duration is not a
    // regression, so the delta is null (renders as "—"), not +250.
    const diff = diffRuns([row("a", "skipped", 0)], [row("a", "failed", 250)]);
    expect(diff.newlyFailed).toEqual([
      {
        testId: "a",
        baseStatus: "skipped",
        headStatus: "failed",
        durationDeltaMs: null,
      },
    ]);
  });

  it("reports a passed→flaky test (no status-verdict change) as a flakyDelta", () => {
    const diff = diffRuns(
      [row("a", "passed", 100, 0)],
      [row("a", "flaky", 100, 2)],
    );
    // Verdict stayed "passing" both runs → not newlyFailed/Passed/stillFailing.
    expect(diff.newlyFailed).toEqual([]);
    expect(diff.newlyPassed).toEqual([]);
    expect(diff.stillFailing).toEqual([]);
    expect(diff.flakyDeltas).toEqual([
      {
        testId: "a",
        baseStatus: "passed",
        headStatus: "flaky",
        baseRetryCount: 0,
        headRetryCount: 2,
        flakyChanged: true,
      },
    ]);
  });

  it("reports a retryCount-only change on a passing test as a flakyDelta", () => {
    const diff = diffRuns(
      [row("a", "passed", 100, 0)],
      [row("a", "passed", 100, 1)],
    );
    expect(diff.flakyDeltas).toEqual([
      {
        testId: "a",
        baseStatus: "passed",
        headStatus: "passed",
        baseRetryCount: 0,
        headRetryCount: 1,
        // Both rows read as flaky (retryCount>0 in head only) → flaky flipped.
        flakyChanged: true,
      },
    ]);
  });

  it("does not emit a flakyDelta when flaky-ness and retries are unchanged", () => {
    const diff = diffRuns(
      [row("a", "passed", 100, 0)],
      [row("a", "passed", 999, 0)],
    );
    // Duration changed, but it's not a status verdict change and not flaky.
    expect(diff.flakyDeltas).toEqual([]);
    expect(diff.newlyFailed).toEqual([]);
  });

  it("classifies a test only in head as added, only in base as removed", () => {
    const diff = diffRuns(
      [row("base-only", "passed", 50)],
      [row("head-only", "failed", 75)],
    );
    expect(diff.addedTests).toEqual([
      { testId: "head-only", status: "failed", durationMs: 75 },
    ]);
    expect(diff.removedTests).toEqual([
      { testId: "base-only", status: "passed", durationMs: 50 },
    ]);
    // A head-only failing test is NOT a "newlyFailed" — it's purely added.
    expect(diff.newlyFailed).toEqual([]);
  });

  it("covers every bucket at once and emits sorted, deterministic output", () => {
    const base = [
      row("z-newpass", "failed"),
      row("a-newfail", "passed"),
      row("m-still", "failed"),
      row("k-flaky", "passed", 100, 0),
      row("removed", "passed"),
    ];
    const head = [
      row("z-newpass", "passed"),
      row("a-newfail", "failed"),
      row("m-still", "timedout"),
      row("k-flaky", "passed", 100, 3),
      row("added", "skipped"),
    ];
    const diff = diffRuns(base, head);
    expect(diff.newlyFailed.map((r) => r.testId)).toEqual(["a-newfail"]);
    expect(diff.newlyPassed.map((r) => r.testId)).toEqual(["z-newpass"]);
    expect(diff.stillFailing.map((r) => r.testId)).toEqual(["m-still"]);
    expect(diff.flakyDeltas.map((r) => r.testId)).toEqual(["k-flaky"]);
    expect(diff.addedTests.map((r) => r.testId)).toEqual(["added"]);
    expect(diff.removedTests.map((r) => r.testId)).toEqual(["removed"]);

    // Determinism: same inputs → identical output.
    expect(diffRuns(base, head)).toEqual(diff);
  });

  it("emits multiple rows within a bucket sorted by testId", () => {
    const diff = diffRuns(
      [row("c", "passed"), row("a", "passed"), row("b", "passed")],
      [row("c", "failed"), row("a", "failed"), row("b", "failed")],
    );
    expect(diff.newlyFailed.map((r) => r.testId)).toEqual(["a", "b", "c"]);
  });

  it("is empty for two empty runs", () => {
    expect(diffRuns([], [])).toEqual({
      newlyFailed: [],
      newlyPassed: [],
      stillFailing: [],
      flakyDeltas: [],
      addedTests: [],
      removedTests: [],
    });
  });
});

// ─── resolveBaseRun (scoping / ordering) ─────────────────────────────────────

describe("resolveBaseRun", () => {
  const head = {
    id: "run_head",
    branch: "main",
    createdAt: 1_700_000_000,
  };

  it("returns null without touching the DB when the head run has no branch", async () => {
    const result = await resolveBaseRun(scope, {
      id: "run_head",
      branch: null,
      createdAt: 1_700_000_000,
    });
    expect(result).toBeNull();
    expect(capturedWhere).toBeNull();
  });

  it("treats an empty / whitespace branch as no branch (no eq(branch, '') grouping)", async () => {
    for (const branch of ["", "   "]) {
      capturedWhere = null;
      const result = await resolveBaseRun(scope, {
        id: "run_head",
        branch,
        createdAt: 1_700_000_000,
      });
      expect(result).toBeNull();
      expect(capturedWhere).toBeNull();
    }
  });

  it("filters by projectId, teamId, branch, status='passed', excludes head + later runs", async () => {
    await resolveBaseRun(scope, head);
    const leaves = flattenAnd(capturedWhere);

    // teamId + projectId (from runScopeWhere), branch, status eq.
    const teamEq = leaves.find(
      (op) => op.__op === "eq" && readEq(op).column === "teamId",
    );
    const projectEq = leaves.find(
      (op) => op.__op === "eq" && readEq(op).column === "projectId",
    );
    const branchEq = leaves.find(
      (op) => op.__op === "eq" && readEq(op).column === "branch",
    );
    // status is an `inArray` (not `eq`) so `resolveBaseRun`'s optional
    // `opts.statuses` can widen it beyond the default `["passed"]`.
    const statusIn = leaves.find(
      (op) =>
        op.__op === "inArray" &&
        (op.args[0] as { name?: unknown })?.name === "status",
    );
    expect(teamEq && readEq(teamEq).value).toBe("team_abc");
    expect(projectEq && readEq(projectEq).value).toBe("proj_xyz");
    expect(branchEq && readEq(branchEq).value).toBe("main");
    expect(statusIn?.args[1]).toEqual(["passed"]);

    // Same-second-safe "before head" boundary:
    //   or(lt(createdAt, head), and(eq(createdAt, head), lt(id, head.id)))
    // — admits a legitimate same-second prior run while still excluding head
    // (its own id is not `< id`). createdAt is epoch SECONDS, so the id tiebreak
    // (ULID = lexicographically time-ordered) disambiguates within a second.
    const orOp = leaves.find((op) => op.__op === "or") as
      | RecordedOp
      | undefined;
    expect(orOp).toBeDefined();
    const [ltCreated, sameSecond] = (orOp as RecordedOp).args as [
      RecordedOp,
      RecordedOp,
    ];
    expect(ltCreated.__op).toBe("lt");
    expect((ltCreated.args[0] as { name?: string }).name).toBe("createdAt");
    expect(ltCreated.args[1]).toBe(1_700_000_000);
    expect(sameSecond.__op).toBe("and");
    const [eqCreated, ltId] = sameSecond.args as [RecordedOp, RecordedOp];
    expect(eqCreated.__op).toBe("eq");
    expect((eqCreated.args[0] as { name?: string }).name).toBe("createdAt");
    expect(ltId.__op).toBe("lt");
    expect((ltId.args[0] as { name?: string }).name).toBe("id");
    expect(ltId.args[1]).toBe("run_head");

    // Most recent first (createdAt is the primary sort key), single row.
    const orderBy = capturedOrderBy as RecordedOp;
    expect(orderBy.__op).toBe("desc");
    expect((orderBy.args[0] as { name?: string }).name).toBe("createdAt");
    expect(capturedLimit).toBe(1);
  });

  it("a different scope binds a different projectId (cross-tenant isolation)", async () => {
    await resolveBaseRun(otherScope, head);
    const leaves = flattenAnd(capturedWhere);
    const projectEq = leaves.find(
      (op) => op.__op === "eq" && readEq(op).column === "projectId",
    );
    expect(projectEq && readEq(projectEq).value).toBe("proj_OTHER");
    expect(projectEq && readEq(projectEq).value).not.toBe("proj_xyz");
  });

  it("returns null when no prior passing run matches", async () => {
    // The mock resolves to [] → no base.
    const result = await resolveBaseRun(scope, head);
    expect(result).toBeNull();
  });
});
