import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

/**
 * `reconcileAndBroadcast` (`@/lib/ingest`) owns the terminal recompute-and-
 * broadcast tail shared by `completeRun` and `finalizeStaleRun`. Before this
 * seam each terminal path hand-transcribed the same three steps: append a single
 * `aggregateRecomputeStatement` LAST, run it with the caller's status-flip in one
 * transaction, then `if (summary) broadcastRunUpdate(runId, [], summary)`. The two
 * shared the "recompute is the last statement → its `.returning()` row is the
 * broadcast summary" invariant by COPY (the cron docstring even acknowledged the
 * mirror). If completeRun's tail drifted, finalizeStaleRun would silently
 * broadcast a stale/absent summary — caught by nothing. This concentrates the
 * tail so the invariant lives in one place.
 *
 * The real Postgres transaction is unmockable in the vitest harness (the
 * `void/db` stub's `db` Proxy throws on access), so we mock `db.transaction` +
 * the query builders and `@/realtime/publish` (the `void/ws` room broadcasters)
 * to assert the pure orchestration contract:
 *   - the caller's status-update is FIRST and the recompute is appended LAST,
 *   - the summary broadcast to the run room (`run:<runId>`) is the LAST batch
 *     result's first row (transactionally consistent with the recompute), with
 *     empty changedTests, and the same summary flips the project-room row,
 *   - no broadcast when the recompute matched no row (run vanished mid-flight),
 *   - the merged summary is returned to the caller either way,
 *   - with `requireStatusFlip`, a no-op finalize (FIRST element's
 *     affected-row count `0`) is silent — no redundant broadcast — while a real
 *     flip still broadcasts, and the guard is OFF for completeRun.
 * The atomicity guarantee itself lives at the Postgres boundary and is out of
 * scope.
 */

// runBatch (Postgres) runs the builder's statements inside `db.transaction(fn)`:
// it awaits each statement IN ORDER and returns the collected results — it no
// longer calls `db.batch`. We mock `db.transaction(fn)` to invoke the callback
// with a tx executor; runBatch's inner async fn builds the statements against it
// and awaits each, so its returned `out` IS the ordered per-statement results
// array the callers index into.
//
// Each statement is a recording thenable resolving to its per-test result row,
// so awaiting it reproduces that result and — on await, which runBatch does in
// build order — pushes itself onto `txStatements`, letting the FIRST/LAST
// positional contract still be asserted. `setBatchResults([head, …, last])`
// arms the per-statement results for one call.
let txStatements: unknown[] = [];
let pendingResults: unknown[] = [];

// A recording thenable standing in for a built Drizzle statement. On `await`
// (runBatch's `await stmt`) it records itself in build order and resolves to the
// caller-armed result row.
function recordingStmt(
  tag: string,
  result: unknown,
): Record<string, unknown> & PromiseLike<unknown> {
  const node = {
    __stmt: tag,
    then: (resolve: (value: unknown) => unknown) => {
      txStatements.push(node);
      return resolve(result);
    },
  };
  return node as Record<string, unknown> & PromiseLike<unknown>;
}

// Arm the per-statement results for the next runBatch call, in batch order
// ([status-flip, recompute]). Each is paired to the statement built at that
// position; awaiting that statement resolves to the row here.
function setBatchResults(results: unknown[]): void {
  pendingResults = [...results];
}

// A chainable query-builder stub: every method returns the same thenable so
// `tx.update(...).set(...).where(...).returning(...)` resolves to one statement
// object the transaction can carry. The recompute is built via `tx.update(...)`,
// so it pops the result armed for the LAST batch position.
function builder(tag: string): PromiseLike<unknown> {
  // The recompute is the last statement built, so it takes the last armed row.
  const node = recordingStmt(tag, pendingResults[pendingResults.length - 1]);
  const chain = () => node;
  node.set = chain;
  node.where = chain;
  node.returning = chain;
  node.from = chain;
  return node as unknown as PromiseLike<unknown>;
}

// The tx executor handed to the transaction callback. The recompute statement is
// built via `tx.update(...)`; a `.select()` summary would go through `tx.select`.
const txExec = {
  update: () => builder("recompute"),
  select: () => builder("summarySelect"),
};

// `db.transaction(fn)` runs runBatch's inner callback against `txExec`; that
// callback builds the statements, awaits each in order, and returns the
// collected results — which we hand straight back as runBatch's `batchResults`.
const transactionSpy = vi.fn((fn: (tx: typeof txExec) => unknown): unknown =>
  fn(txExec),
);

vi.mock("void/db", () => ({
  db: {
    transaction: transactionSpy,
  },
  and: (...args: unknown[]) => ({ __op: "and", args }),
  eq: (...args: unknown[]) => ({ __op: "eq", args }),
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
// room gets the `run-progress` lifecycle event.
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

const { reconcileAndBroadcast } = await import("@/lib/ingest");

const SUMMARY = {
  totalTests: 7,
  passed: 5,
  failed: 1,
  flaky: 0,
  skipped: 1,
  durationMs: 1234,
  status: "failed",
  completedAt: 99,
} as const;

// Build the caller's status-flip statement: a recording thenable resolving to
// the row armed for the FIRST batch position (the head element runBatch awaits).
function statusFlip(): PromiseLike<unknown> {
  return recordingStmt(
    "status-flip",
    pendingResults[0],
  ) as unknown as PromiseLike<unknown>;
}

beforeEach(() => {
  txStatements = [];
  pendingResults = [];
  transactionSpy.mockClear();
  broadcastProjectSpy.mockReset();
  broadcastProjectSpy.mockResolvedValue(undefined);
  broadcastRunSpy.mockReset();
  broadcastRunSpy.mockResolvedValue(undefined);
});

describe("reconcileAndBroadcast", () => {
  it("batches the caller's status-update FIRST and the recompute LAST", async () => {
    setBatchResults([[{ updated: 1 }], [SUMMARY]]);

    await reconcileAndBroadcast("run-1", () => statusFlip(), {
      projectId: "proj-1",
    });

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(txStatements).toHaveLength(2);
    // Caller's status statement is the head; the recompute (last) is what the
    // builder stub tagged. The positional contract — recompute LAST so its
    // returning() row is the summary — is exactly the invariant being pinned.
    expect(txStatements[0]).toMatchObject({ __stmt: "status-flip" });
    expect(txStatements[1]).toMatchObject({ __stmt: "recompute" });
  });

  it("broadcasts the LAST batch row's summary to the run room with empty changedTests, and flips the project row", async () => {
    setBatchResults([[{ updated: 1 }], [SUMMARY]]);

    const summary = await reconcileAndBroadcast("run-42", () => statusFlip(), {
      projectId: "proj-1",
    });

    expect(summary).toEqual(SUMMARY);
    // The run room gets the per-run progress event (via broadcastRunUpdate's
    // single publish point) — summary is exactly the LAST batch row.
    expect(broadcastRunSpy).toHaveBeenCalledTimes(1);
    expect(broadcastRunSpy.mock.calls[0]).toEqual([
      "run-42",
      { type: "progress", changedTests: [], summary: SUMMARY },
    ]);
    // The terminal summary is mirrored to the project room (run-progress) so the
    // run's row on any open list flips to its final status without a reload.
    expect(broadcastProjectSpy).toHaveBeenCalledTimes(1);
    expect(broadcastProjectSpy.mock.calls[0]).toEqual([
      "proj-1",
      { type: "run-progress", runId: "run-42", summary: SUMMARY },
    ]);
  });

  it("does NOT broadcast when the recompute matched no row (run vanished)", async () => {
    // The status-flip guard (status='running') or a deleted run leaves the
    // recompute's .returning() empty → summaryFromBatchResults yields null.
    setBatchResults([[{ updated: 0 }], []]);

    const summary = await reconcileAndBroadcast(
      "run-gone",
      () => statusFlip(),
      {
        projectId: "proj-1",
      },
    );

    expect(summary).toBeNull();
    expect(broadcastRunSpy).not.toHaveBeenCalled();
    expect(broadcastProjectSpy).not.toHaveBeenCalled();
  });

  it("returns the merged summary so the caller can read back status", async () => {
    setBatchResults([[{ updated: 1 }], [SUMMARY]]);

    const summary = await reconcileAndBroadcast("run-1", () => statusFlip(), {
      projectId: "proj-1",
    });

    expect(summary?.status).toBe("failed");
  });

  // `requireStatusFlip` is the finalizeStaleRun no-op guard. The guarded flip is
  // the FIRST batch element; its affected-row count says whether the run was
  // still "running" when the sweep wrote. A non-`.returning()` flip resolves to a
  // Postgres result carrying `rowCount` (pglite `affectedRows`) — so the head
  // element here is that shape, not a rows array, and `statementChangedRows`
  // reads it via `changedRows`.
  describe("requireStatusFlip (finalizeStaleRun no-op guard)", () => {
    it("suppresses the broadcast when the guarded flip matched 0 rows", async () => {
      // Cron overlap / a winning /complete left the run off "running"; the flip
      // no-ops, but the (unguarded) recompute still returns the row's terminal
      // summary. The duplicate progress event is suppressed; DB is untouched.
      setBatchResults([{ rowCount: 0 }, [SUMMARY]]);

      const summary = await reconcileAndBroadcast(
        "run-raced",
        () => statusFlip(),
        { projectId: "proj-1" },
        { requireStatusFlip: true },
      );

      // Summary is still returned (callers may read it back), broadcast is not.
      expect(summary).toEqual(SUMMARY);
      expect(broadcastRunSpy).not.toHaveBeenCalled();
      expect(broadcastProjectSpy).not.toHaveBeenCalled();
    });

    it("broadcasts when the guarded flip changed a row (the run was live)", async () => {
      setBatchResults([{ rowCount: 1 }, [SUMMARY]]);

      const summary = await reconcileAndBroadcast(
        "run-stuck",
        () => statusFlip(),
        { projectId: "proj-1" },
        { requireStatusFlip: true },
      );

      expect(summary).toEqual(SUMMARY);
      expect(broadcastRunSpy).toHaveBeenCalledTimes(1);
      expect(broadcastRunSpy.mock.calls[0]![0]).toBe("run-stuck");
    });

    it("still broadcasts on a 0-row flip when requireStatusFlip is OFF (completeRun)", async () => {
      // completeRun's merge UPDATE has no status guard — it always matches the
      // owned row — so it never opts into the guard and always broadcasts. Even
      // a (hypothetical) 0-change head must not suppress its broadcast.
      setBatchResults([{ rowCount: 0 }, [SUMMARY]]);

      await reconcileAndBroadcast("run-complete", () => statusFlip(), {
        projectId: "proj-1",
      });

      expect(broadcastRunSpy).toHaveBeenCalledTimes(1);
    });
  });
});
