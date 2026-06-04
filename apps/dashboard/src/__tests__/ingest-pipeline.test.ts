import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import type {
  AppendResultsPayload,
  CompleteRunPayload,
  OpenRunPayload,
  TestResultInput,
} from "@/lib/schemas";
import type {
  AuthorizedProjectId,
  AuthorizedTeamId,
  TenantScope,
} from "@/lib/scope";

/**
 * The ingest pipeline's three run-scoped entry points — `openRun`,
 * `appendRunResults`, `completeRun` — ARE the deep module: each hides
 * verify-ownership -> resolve ids -> compose a heterogeneous `db.batch` ->
 * extract the summary from the LAST batch row -> bump team activity ->
 * broadcast. The leaf pure helpers (computeAggregateDelta, mergeRunStatus,
 * buildChangedTests, summaryFromBatchResults, reconcileAndBroadcast) each have
 * their own unit suite, but the *orchestration glue that wires them together*
 * — that the no-delta path swaps the delta UPDATE for a liveness-bump UPDATE,
 * that ownership returns notFound, that the duplicate-open path still prefills this shard's
 * queued rows, that appendRunResults feeds prevStatus -> delta -> the broadcast
 * summary — was reachable only by booting a real run end-to-end.
 *
 * The first concrete consumer of the still-unbuilt real-D1 harness is the
 * deepest, highest-blast-radius module: this file. Rather than stand up a whole
 * SQLite/miniflare D1 binding (better-sqlite3's Drizzle driver has no `batch`,
 * the pipeline's atomicity boundary), we reuse the project's established
 * mock-the-D1-boundary idiom (see db-batch.test.ts / reconcile-and-broadcast.
 * test.ts): mock `void/db` so the query builders are controllable thenables and
 * `db.batch` is a spy, and mock `@/live`'s `publishRunUpdate`. That makes the
 * orchestration reachable and pins these invariants:
 *   - openRun: duplicate idempotencyKey returns { duplicate: true } WITHOUT a
 *     fresh runs insert, but still prefills this shard's planned rows;
 *   - appendRunResults: the delta UPDATE is appended LAST in the batch on a
 *     real delta, swapped for a liveness-bump UPDATE on a no-op delta, and the
 *     broadcast summary is exactly batchResults[last][0];
 *   - completeRun / appendRunResults: ownership miss returns { kind: "notFound" }
 *     with no batch and no broadcast.
 * The D1 transaction's atomicity (durable decision #10) lives at the boundary
 * and is out of scope; this covers the assembly/ordering/summary-extraction
 * glue — the part the pure-helper suites cannot reach.
 */

// ─── Controllable void/db mock ───────────────────────────────────────────────
//
// Every builder method returns the SAME chainable node so chains like
// `db.select(c).from(t).where(w).limit(1)` and `db.update(t).set(s).where(w)
// .returning(cols)` resolve to one statement object. Each node is also a
// thenable: directly-awaited statements (the idempotency/ownership SELECTs,
// resolveTestResultIds' SELECT, bumpTeamActivity's UPDATE, the single-prefill
// INSERT) dequeue from `awaitResults`; statements that are instead pushed into a
// `db.batch([...])` are never awaited, so they don't consume a queued result —
// the batch's own `batchSpy` decides what comes back.

const batchSpy = vi.fn<(statements: unknown[]) => Promise<unknown[]>>();

/** FIFO of rows each *directly awaited* statement resolves to, in call order. */
let awaitResults: unknown[][] = [];

type BuilderNode = Record<string, unknown> & {
  __kind: string;
  then: (onFulfilled?: (value: unknown) => unknown) => Promise<unknown>;
};

function makeBuilder(kind: string): BuilderNode {
  const node = { __kind: kind } as BuilderNode;
  const chain = () => node;
  // Every method Drizzle exposes on the chains this pipeline builds.
  for (const m of [
    "from",
    "set",
    "where",
    "limit",
    "values",
    "returning",
    "onConflictDoNothing",
    "innerJoin",
  ] as const) {
    node[m] = chain;
  }
  // Thenable: awaiting a statement directly dequeues the next configured
  // result-set. A statement collected into db.batch is never awaited.
  node.then = (onFulfilled?: (value: unknown) => unknown) => {
    const rows = awaitResults.shift() ?? [];
    return Promise.resolve(onFulfilled ? onFulfilled(rows) : rows);
  };
  return node;
}

vi.mock("void/db", () => ({
  db: {
    batch: batchSpy,
    select: () => makeBuilder("select"),
    insert: () => makeBuilder("insert"),
    update: () => makeBuilder("update"),
    delete: () => makeBuilder("delete"),
  },
  and: (...args: unknown[]) => ({ __op: "and", args }),
  eq: (...args: unknown[]) => ({ __op: "eq", args }),
  inArray: (...args: unknown[]) => ({ __op: "inArray", args }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...args: unknown[]) => ({
      __op: "sql",
      strings,
      args,
    }),
    { raw: (s: string) => ({ __op: "sql.raw", s }) },
  ),
}));

const publishSpy = vi.fn<(runId: string, event: unknown) => Promise<void>>(() =>
  Promise.resolve(),
);
vi.mock("@/live", () => ({
  publishRunUpdate: publishSpy,
}));

const { openRun, appendRunResults, completeRun } = await import("@/lib/ingest");

const scope: TenantScope = {
  teamId: "team-1" as AuthorizedTeamId,
  projectId: "proj-1" as AuthorizedProjectId,
  teamSlug: "acme",
  projectSlug: "web",
};

const NOW = 1_700_000_000;

/** A full summary row, the shape a `.returning()`/SELECT projects. */
function summaryRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    totalTests: 3,
    passed: 2,
    failed: 1,
    flaky: 0,
    skipped: 0,
    durationMs: 1000,
    status: "running",
    completedAt: null,
    ...over,
  };
}

function result(over: Partial<TestResultInput> = {}): TestResultInput {
  return {
    testId: "t1",
    title: "renders",
    file: "spec.ts",
    status: "passed",
    durationMs: 10,
    retryCount: 0,
    tags: [],
    annotations: [],
    attempts: [{ attempt: 0, status: "passed", durationMs: 10 }],
    ...over,
  } as TestResultInput;
}

beforeEach(() => {
  batchSpy.mockReset();
  publishSpy.mockReset();
  publishSpy.mockResolvedValue(undefined);
  awaitResults = [];
});

describe("openRun", () => {
  it("on a fresh open: inserts the run + prefill in one batch and broadcasts the initial snapshot", async () => {
    // [0] idempotency SELECT → no existing run; [1] bumpTeamActivity UPDATE.
    awaitResults = [[], []];
    batchSpy.mockResolvedValue([[{ inserted: 1 }], [{ inserted: 1 }]]);
    const payload: OpenRunPayload = {
      idempotencyKey: "key-1",
      run: {
        plannedTests: [{ testId: "t1", title: "a", file: "spec.ts" }],
      },
    } as OpenRunPayload;

    const out = await openRun(scope, payload, NOW);

    expect(out.duplicate).toBe(false);
    expect(typeof out.runId).toBe("string");
    expect(out.runId.length).toBeGreaterThan(0);
    // One run insert + one prefill insert chunk → batched together (atomic open).
    expect(batchSpy).toHaveBeenCalledTimes(1);
    const batched = batchSpy.mock.calls[0]![0] as BuilderNode[];
    expect(batched).toHaveLength(2);
    expect(batched.every((s) => s.__kind === "insert")).toBe(true);
    // Initial snapshot is synthesized inline (no DB read) — totals reflect the
    // planned-test count, status "running".
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const [runId, event] = publishSpy.mock.calls[0]!;
    expect(runId).toBe(out.runId);
    expect(event).toEqual({
      type: "progress",
      changedTests: [],
      summary: {
        totalTests: 1,
        passed: 0,
        failed: 0,
        flaky: 0,
        skipped: 0,
        durationMs: 0,
        status: "running",
        completedAt: null,
      },
    });
  });

  it("on a duplicate idempotencyKey: returns the existing runId without re-inserting or re-prefilling", async () => {
    // [0] idempotency SELECT → existing run. Shards 2..N take the duplicate
    // branch and return immediately — they do NOT prefill their planned tests
    // (a prefilled 'queued' row would carry a prev-status that suppresses the
    // +totalTests delta when that shard's real result streams in; see ingest.ts).
    awaitResults = [[{ id: "run-existing" }]];
    const payload: OpenRunPayload = {
      idempotencyKey: "key-shared",
      run: {
        plannedTests: [{ testId: "t9", title: "shard2", file: "spec.ts" }],
      },
    } as OpenRunPayload;

    const out = await openRun(scope, payload, NOW);

    expect(out).toEqual({ runId: "run-existing", duplicate: true });
    // No fresh run insert, no prefill batch, and no broadcast on the duplicate
    // path — the winning shard already created the run and sent the snapshot.
    expect(batchSpy).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("on a duplicate with many planned tests: still does not prefill (guards against re-introducing the totalTests-suppressing prefill)", async () => {
    // Even with enough planned tests to span multiple chunks, the duplicate
    // branch must not prefill — letting shards 2..N's results arrive as fresh
    // rows keeps totalTests climbing; completeRun's recompute reconciles finals.
    awaitResults = [[{ id: "run-existing" }]];
    const plannedTests = Array.from({ length: 60 }, (_, i) => ({
      testId: `t${i}`,
      title: `case ${i}`,
      file: "spec.ts",
    }));
    const payload: OpenRunPayload = {
      idempotencyKey: "key-shared",
      run: { plannedTests },
    } as OpenRunPayload;

    const out = await openRun(scope, payload, NOW);

    expect(out).toEqual({ runId: "run-existing", duplicate: true });
    expect(batchSpy).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });
});

describe("appendRunResults", () => {
  it("returns notFound (no batch, no broadcast) when the run isn't owned by the scope", async () => {
    // [0] ownership SELECT → empty.
    awaitResults = [[]];
    const payload: AppendResultsPayload = { results: [result()] };

    const out = await appendRunResults(scope, "run-x", payload, NOW);

    expect(out).toEqual({ kind: "notFound" });
    expect(batchSpy).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("on a real delta: appends the delta UPDATE LAST and broadcasts batchResults[last][0]", async () => {
    // [0] ownership SELECT → owned; [1] resolveTestResultIds SELECT → no prior
    // rows (fresh inserts, so a real +totalTests delta UPDATE is emitted).
    awaitResults = [[{ id: "run-1" }], []];
    const persisted = summaryRow({ totalTests: 1, passed: 1, failed: 0 });
    // The batch result array: writes... then the summary statement's row LAST.
    batchSpy.mockResolvedValue([[{ written: 1 }], [persisted]]);
    const payload: AppendResultsPayload = { results: [result()] };

    const out = await appendRunResults(scope, "run-1", payload, NOW);

    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("unreachable");
    // clientKey-less result → empty mapping, but the row was still written.
    expect(out.mapping).toEqual([]);

    expect(batchSpy).toHaveBeenCalledTimes(1);
    const batched = batchSpy.mock.calls[0]![0] as BuilderNode[];
    // The LAST statement is the delta UPDATE (.returning the summary), NOT a
    // SELECT — a real delta took the UPDATE branch of the deltaStmt ?? SELECT.
    expect(batched.at(-1)!.__kind).toBe("update");

    // The broadcast summary is exactly the LAST batch row — proving the
    // batchResults[last][0] contract end-to-end through the entry point.
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const [runId, event] = publishSpy.mock.calls[0]! as [
      string,
      { summary: unknown; changedTests: unknown[] },
    ];
    expect(runId).toBe("run-1");
    expect(event.summary).toEqual(persisted);
    // changedTests carries the per-test row with the assigned id.
    expect(event.changedTests).toHaveLength(1);
  });

  it("on a no-op delta (re-send of an unchanged status): swaps the delta UPDATE for a liveness-bump UPDATE as the LAST statement", async () => {
    // [0] ownership SELECT → owned; [1] resolveTestResultIds SELECT → the test
    // already exists at the SAME status, so computeAggregateDelta is all-zero
    // and aggregateDeltaStatement returns null → the no-delta branch swaps in
    // `activityBumpStatement` (a liveness-only UPDATE, not a read-only SELECT)
    // so even a zero-bucket-change flush advances `lastActivityAt`.
    awaitResults = [
      [{ id: "run-1" }],
      [{ id: "tr-1", testId: "t1", status: "passed" }],
    ];
    const persisted = summaryRow({ status: "running" });
    batchSpy.mockResolvedValue([[{ written: 1 }], [persisted]]);
    const payload: AppendResultsPayload = {
      results: [result({ testId: "t1", status: "passed" })],
    };

    const out = await appendRunResults(scope, "run-1", payload, NOW);

    expect(out.kind).toBe("ok");
    const batched = batchSpy.mock.calls[0]![0] as BuilderNode[];
    // No delta → the summary statement is the liveness-bump UPDATE appended
    // last (it still `.returning()`s the summary), NOT a read-only SELECT.
    expect(batched.at(-1)!.__kind).toBe("update");
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const [, event] = publishSpy.mock.calls[0]! as [
      string,
      { summary: unknown },
    ];
    expect(event.summary).toEqual(persisted);
  });

  it("returns notFound when the run vanished mid-batch (summary statement matched no row)", async () => {
    awaitResults = [[{ id: "run-1" }], []];
    // Final statement produced no row → summaryFromBatchResults yields null.
    batchSpy.mockResolvedValue([[{ written: 1 }], []]);
    const payload: AppendResultsPayload = { results: [result()] };

    const out = await appendRunResults(scope, "run-1", payload, NOW);

    expect(out).toEqual({ kind: "notFound" });
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("threads clientKey → assigned id into the returned mapping", async () => {
    awaitResults = [[{ id: "run-1" }], []];
    batchSpy.mockResolvedValue([[{ written: 1 }], [summaryRow()]]);
    const payload: AppendResultsPayload = {
      results: [result({ testId: "t1", clientKey: "ck-1" })],
    };

    const out = await appendRunResults(scope, "run-1", payload, NOW);

    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("unreachable");
    expect(out.mapping).toHaveLength(1);
    expect(out.mapping[0]!.clientKey).toBe("ck-1");
    expect(typeof out.mapping[0]!.testResultId).toBe("string");
  });
});

describe("completeRun", () => {
  it("returns notFound (no batch, no broadcast) when the run isn't owned", async () => {
    awaitResults = [[]];
    const payload: CompleteRunPayload = { status: "passed", durationMs: 100 };

    const out = await completeRun(scope, "run-x", payload, NOW);

    expect(out).toEqual({ kind: "notFound" });
    expect(batchSpy).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("runs the status-flip + recompute in one batch and returns the merged status from the summary", async () => {
    // [0] ownership SELECT → owned; [1] bumpTeamActivity UPDATE.
    awaitResults = [[{ id: "run-1" }], []];
    // The merged status comes back on the recompute's .returning() row (LAST).
    const merged = summaryRow({ status: "failed", completedAt: NOW });
    batchSpy.mockResolvedValue([[{ flipped: 1 }], [merged]]);
    const payload: CompleteRunPayload = { status: "passed", durationMs: 250 };

    const out = await completeRun(scope, "run-1", payload, NOW);

    expect(out).toEqual({ kind: "ok", status: "failed" });
    expect(batchSpy).toHaveBeenCalledTimes(1);
    const batched = batchSpy.mock.calls[0]![0] as BuilderNode[];
    // status-flip UPDATE first, recompute UPDATE last (reconcileAndBroadcast).
    expect(batched).toHaveLength(2);
    expect(batched[0]!.__kind).toBe("update");
    expect(batched[1]!.__kind).toBe("update");
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const [, event] = publishSpy.mock.calls[0]! as [
      string,
      { summary: unknown; changedTests: unknown[] },
    ];
    expect(event.summary).toEqual(merged);
    expect(event.changedTests).toEqual([]);
  });

  it("falls back to the payload status when the recompute returns no row", async () => {
    awaitResults = [[{ id: "run-1" }], []];
    // Recompute matched no row → summary null → caller reports payload.status.
    batchSpy.mockResolvedValue([[{ flipped: 0 }], []]);
    const payload: CompleteRunPayload = { status: "passed", durationMs: 0 };

    const out = await completeRun(scope, "run-1", payload, NOW);

    expect(out).toEqual({ kind: "ok", status: "passed" });
    expect(publishSpy).not.toHaveBeenCalled();
  });
});
