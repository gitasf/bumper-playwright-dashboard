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
 * verify-ownership -> resolve ids -> compose a heterogeneous `db.transaction` ->
 * extract the summary from the LAST statement's row -> bump team activity ->
 * broadcast. The leaf pure helpers (computeAggregateDelta, mergeRunStatus,
 * buildChangedTests, summaryFromBatchResults, reconcileAndBroadcast) each have
 * their own unit suite, but the *orchestration glue that wires them together*
 * — that the no-delta path swaps the delta UPDATE for a liveness-bump UPDATE,
 * that ownership returns notFound, that the duplicate-open path still prefills this shard's
 * queued rows, that appendRunResults feeds prevStatus -> delta -> the broadcast
 * summary — was reachable only by booting a real run end-to-end.
 *
 * The first concrete consumer of the still-unbuilt real-Postgres harness is the
 * deepest, highest-blast-radius module: this file. Rather than stand up a whole
 * pglite/Postgres binding (the pipeline's atomicity boundary is a real
 * `db.transaction`), we reuse the project's established mock-the-PG-boundary
 * idiom (see db-batch.test.ts): mock `void/db` so the query builders are
 * controllable thenables and `db.transaction` runs the builder against a
 * recording tx executor, and mock `@/realtime/publish`'s room broadcasters. That
 * makes the orchestration reachable and pins these invariants:
 *   - openRun: duplicate idempotencyKey returns { duplicate: true } WITHOUT a
 *     fresh runs insert, but still prefills this shard's planned rows;
 *   - appendRunResults: the delta UPDATE is appended LAST in the transaction on
 *     a real delta, swapped for a liveness-bump UPDATE on a no-op delta, and the
 *     broadcast summary is exactly txResults[last][0];
 *   - completeRun / appendRunResults: ownership miss returns { kind: "notFound" }
 *     with no transaction and no broadcast.
 * The Postgres transaction's atomicity (durable decision #10) lives at the
 * boundary and is out of scope; this covers the assembly/ordering/summary-
 * extraction glue — the part the pure-helper suites cannot reach.
 */

// ─── Controllable void/db mock ───────────────────────────────────────────────
//
// Every builder method returns the SAME chainable node so chains like
// `db.select(c).from(t).where(w).limit(1)` and `db.update(t).set(s).where(w)
// .returning(cols)` resolve to one statement object. Each node is also a
// thenable, and resolves its rows differently depending on which executor built
// it:
//   - statements built off the pooled `db` (the idempotency/ownership SELECTs,
//     resolveTestResultIds' SELECT, bumpTeamActivity's UPDATE) dequeue from the
//     `awaitResults` FIFO when awaited directly;
//   - statements built off the transaction executor `tx` (the prefill INSERT,
//     the per-test upsert/replace, the usage bump, and the summary UPDATE) are
//     awaited IN ORDER by `runBatch`'s `for (const stmt of build(tx))` loop and
//     each resolves to `txStatementResult` — the per-statement row-set the
//     transaction yields. The pipeline reads ONLY the LAST statement's result as
//     the broadcast summary (txResults[last][0]), and the intermediate writes'
//     results are unread; returning the SAME configured value for every tx
//     statement therefore pins the summary contract without coupling the fixture
//     to the (production-internal) write-statement COUNT. Awaiting a tx statement
//     also RECORDS it (in await order) into `txStatements`, the array the
//     assertions inspect — replacing the old `db.batch` call-args, since Postgres
//     builds each statement against `tx` and runs them inside `db.transaction`
//     rather than handing an array to `batch`.
//
// `runBatch` is Postgres-only now: it calls `db.transaction(fn)` and runs each
// statement inside it (NO `db.batch`). So the boundary spy here is
// `transactionSpy`, and the fake `db` exposes `.transaction`, not `.batch`.

/** FIFO of rows each *directly awaited* (pooled-`db`) statement resolves to. */
let awaitResults: unknown[][] = [];

/**
 * Row-set every transaction statement resolves to. Since the pipeline reads only
 * the LAST statement's result (the summary), one value per test suffices: set it
 * to the summary row-set the transaction's final (summary) statement returns.
 */
let txStatementResult: unknown[] = [];

/** Statements built against the tx executor, captured in await (== run) order. */
let txStatements: BuilderNode[] = [];

type BuilderNode = Record<string, unknown> & {
  __kind: string;
  then: (onFulfilled?: (value: unknown) => unknown) => Promise<unknown>;
};

/**
 * Build a chainable thenable node. `inTx` selects which result a node yields when
 * awaited: pooled-`db` nodes dequeue `awaitResults`; transaction nodes resolve to
 * `txStatementResult` AND record themselves into `txStatements` so the tests can
 * inspect the ordered statement list the transaction ran.
 */
function makeBuilder(kind: string, inTx: boolean): BuilderNode {
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
    "onConflictDoUpdate",
    "innerJoin",
  ] as const) {
    node[m] = chain;
  }
  node.then = (onFulfilled?: (value: unknown) => unknown) => {
    if (inTx) {
      // runBatch awaits tx statements in order — record + resolve the configured
      // per-statement row-set (only the last one is read, as the summary).
      txStatements.push(node);
      return Promise.resolve(
        onFulfilled ? onFulfilled(txStatementResult) : txStatementResult,
      );
    }
    const rows = awaitResults.shift() ?? [];
    return Promise.resolve(onFulfilled ? onFulfilled(rows) : rows);
  };
  return node;
}

/** The transaction executor passed to `db.transaction`'s callback. */
const txExec = {
  insert: () => makeBuilder("insert", true),
  update: () => makeBuilder("update", true),
  delete: () => makeBuilder("delete", true),
  select: () => makeBuilder("select", true),
};

// `db.transaction(fn)` runs the builder's statements inside the transaction:
// `runBatch` does `for (const stmt of build(tx)) out.push(await stmt)`, so we
// invoke `fn(txExec)` and return its result (the awaited per-statement results).
const transactionSpy = vi.fn((fn: (tx: typeof txExec) => unknown): unknown =>
  fn(txExec),
);

vi.mock("void/db", () => ({
  db: {
    transaction: transactionSpy,
    select: () => makeBuilder("select", false),
    insert: () => makeBuilder("insert", false),
    update: () => makeBuilder("update", false),
    delete: () => makeBuilder("delete", false),
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

// The `void/ws` room broadcasters — the single realtime publish path. The run
// room gets the per-run `progress` event (via `broadcastRunUpdate`); the project
// room gets the run lifecycle events (`run-created` / `run-progress`).
const broadcastProjectSpy = vi.fn<
  (projectId: string, event: unknown) => Promise<void>
>(() => Promise.resolve());
const broadcastRunSpy = vi.fn<(runId: string, event: unknown) => Promise<void>>(
  () => Promise.resolve(),
);
vi.mock("@/realtime/publish", () => ({
  broadcastProjectRoom: broadcastProjectSpy,
  broadcastRunRoom: broadcastRunSpy,
}));

// completeRun calls `maybePostGithubCheck`, which reads the GitHub App env to
// decide whether to fire. Empty env → App disabled → an immediate no-op (no DB
// read, no GitHub call), keeping these ingest-pipeline assertions unchanged.
vi.mock("void/env", () => ({ env: {} }));

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
  transactionSpy.mockClear();
  broadcastProjectSpy.mockReset();
  broadcastProjectSpy.mockResolvedValue(undefined);
  broadcastRunSpy.mockReset();
  broadcastRunSpy.mockResolvedValue(undefined);
  awaitResults = [];
  txStatementResult = [];
  txStatements = [];
});

describe("openRun", () => {
  it("on a fresh open: inserts the run + prefill in one batch and broadcasts the initial snapshot", async () => {
    // [0] idempotency SELECT → no existing run; [1] bumpTeamActivity UPDATE.
    awaitResults = [[], []];
    // openRun discards the open transaction's results (it synthesizes the
    // snapshot inline), so the per-statement result is irrelevant here — the
    // default empty row-set is fine.
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
    // One run insert + one prefill insert chunk + the usage-meter bump (also an
    // insert/upsert) → run together in one atomic open transaction.
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(txStatements).toHaveLength(3);
    expect(txStatements.every((s) => s.__kind === "insert")).toBe(true);
    // Initial snapshot is synthesized inline (no DB read) and broadcast to the
    // run room — totals reflect the planned-test count, status "running".
    expect(broadcastRunSpy).toHaveBeenCalledTimes(1);
    const [runId, event] = broadcastRunSpy.mock.calls[0]!;
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

    // The runs list is told a brand-new run exists (run-created) on the project
    // room, so it can prepend the row without a refresh.
    expect(broadcastProjectSpy).toHaveBeenCalledTimes(1);
    const [projectId, projectEvent] = broadcastProjectSpy.mock.calls[0]! as [
      string,
      { type: string; run: { id: string; status: string } },
    ];
    expect(projectId).toBe("proj-1");
    expect(projectEvent.type).toBe("run-created");
    expect(projectEvent.run.id).toBe(out.runId);
    expect(projectEvent.run.status).toBe("running");
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
    // No fresh run insert, no prefill transaction, and no broadcast on the
    // duplicate path — the winning shard already created the run and sent the
    // snapshot.
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(broadcastRunSpy).not.toHaveBeenCalled();
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
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(broadcastRunSpy).not.toHaveBeenCalled();
  });
});

describe("appendRunResults", () => {
  it("returns notFound (no batch, no broadcast) when the run isn't owned by the scope", async () => {
    // [0] ownership SELECT → empty.
    awaitResults = [[]];
    const payload: AppendResultsPayload = { results: [result()] };

    const out = await appendRunResults(scope, "run-x", payload, NOW);

    expect(out).toEqual({ kind: "notFound" });
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(broadcastRunSpy).not.toHaveBeenCalled();
  });

  it("on a real delta: appends the delta UPDATE LAST and broadcasts txResults[last][0]", async () => {
    // [0] ownership SELECT → owned; [1] resolveTestResultIds SELECT → no prior
    // rows (fresh inserts, so a real +totalTests delta UPDATE is emitted).
    awaitResults = [[{ id: "run-1" }], []];
    const persisted = summaryRow({ totalTests: 1, passed: 1, failed: 0 });
    // The summary-producing statement is appended LAST, so its row is the FINAL
    // per-statement result (txResults[last][0]) — exactly the old "summary is the
    // last batch row" contract, now read off the transaction.
    txStatementResult = [persisted];
    const payload: AppendResultsPayload = { results: [result()] };

    const out = await appendRunResults(scope, "run-1", payload, NOW);

    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("unreachable");
    // clientKey-less result → empty mapping, but the row was still written.
    expect(out.mapping).toEqual([]);

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    // The LAST statement is the delta UPDATE (.returning the summary), NOT a
    // SELECT — a real delta took the UPDATE branch of the deltaStmt ?? SELECT.
    expect(txStatements.at(-1)!.__kind).toBe("update");

    // The broadcast summary is exactly the LAST transaction row — proving the
    // txResults[last][0] contract end-to-end through the entry point. It goes
    // to the run room via broadcastRunUpdate's single publish point.
    expect(broadcastRunSpy).toHaveBeenCalledTimes(1);
    const [runId, event] = broadcastRunSpy.mock.calls[0]! as [
      string,
      { summary: unknown; changedTests: unknown[] },
    ];
    expect(runId).toBe("run-1");
    expect(event.summary).toEqual(persisted);
    // changedTests carries the per-test row with the assigned id.
    expect(event.changedTests).toHaveLength(1);

    // The same summary advances the run's row on any open list (project room),
    // in lockstep with the detail page.
    expect(broadcastProjectSpy).toHaveBeenCalledTimes(1);
    expect(broadcastProjectSpy.mock.calls[0]).toEqual([
      "proj-1",
      { type: "run-progress", runId: "run-1", summary: persisted },
    ]);
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
    txStatementResult = [persisted];
    const payload: AppendResultsPayload = {
      results: [result({ testId: "t1", status: "passed" })],
    };

    const out = await appendRunResults(scope, "run-1", payload, NOW);

    expect(out.kind).toBe("ok");
    // No delta → the summary statement is the liveness-bump UPDATE appended
    // last (it still `.returning()`s the summary), NOT a read-only SELECT.
    expect(txStatements.at(-1)!.__kind).toBe("update");
    expect(broadcastRunSpy).toHaveBeenCalledTimes(1);
    const [, event] = broadcastRunSpy.mock.calls[0]! as [
      string,
      { summary: unknown },
    ];
    expect(event.summary).toEqual(persisted);
  });

  it("returns notFound when the run vanished mid-transaction (summary statement matched no row)", async () => {
    awaitResults = [[{ id: "run-1" }], []];
    // Final statement produced no row → summaryFromBatchResults yields null.
    txStatementResult = [];
    const payload: AppendResultsPayload = { results: [result()] };

    const out = await appendRunResults(scope, "run-1", payload, NOW);

    expect(out).toEqual({ kind: "notFound" });
    expect(broadcastRunSpy).not.toHaveBeenCalled();
  });

  it("threads clientKey → assigned id into the returned mapping", async () => {
    awaitResults = [[{ id: "run-1" }], []];
    txStatementResult = [summaryRow()];
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
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(broadcastRunSpy).not.toHaveBeenCalled();
  });

  it("runs the status-flip + recompute in one transaction and returns the merged status from the summary", async () => {
    // [0] ownership SELECT → owned; [1] bumpTeamActivity UPDATE.
    awaitResults = [[{ id: "run-1" }], []];
    // The merged status comes back on the recompute's .returning() row (LAST).
    const merged = summaryRow({ status: "failed", completedAt: NOW });
    txStatementResult = [merged];
    const payload: CompleteRunPayload = { status: "passed", durationMs: 250 };

    const out = await completeRun(scope, "run-1", payload, NOW);

    expect(out).toEqual({ kind: "ok", status: "failed" });
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    // status-flip UPDATE first, recompute UPDATE last (reconcileAndBroadcast).
    expect(txStatements).toHaveLength(2);
    expect(txStatements[0]!.__kind).toBe("update");
    expect(txStatements[1]!.__kind).toBe("update");
    expect(broadcastRunSpy).toHaveBeenCalledTimes(1);
    const [, event] = broadcastRunSpy.mock.calls[0]! as [
      string,
      { summary: unknown; changedTests: unknown[] },
    ];
    expect(event.summary).toEqual(merged);
    expect(event.changedTests).toEqual([]);
  });

  it("falls back to the payload status when the recompute returns no row", async () => {
    awaitResults = [[{ id: "run-1" }], []];
    // Recompute matched no row → summary null → caller reports payload.status.
    txStatementResult = [];
    const payload: CompleteRunPayload = { status: "passed", durationMs: 0 };

    const out = await completeRun(scope, "run-1", payload, NOW);

    expect(out).toEqual({ kind: "ok", status: "passed" });
    expect(broadcastRunSpy).not.toHaveBeenCalled();
  });
});
