import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

/**
 * `reconcileAndBroadcast` (`@/lib/ingest`) owns the terminal recompute-and-
 * broadcast tail shared by `completeRun` and `finalizeStaleRun`. Before this
 * seam each terminal path hand-transcribed the same three steps: append a single
 * `aggregateRecomputeStatement` LAST, run it with the caller's status-flip in one
 * `db.batch`, then `if (summary) broadcastRunUpdate(runId, [], summary)`. The two
 * shared the "recompute is the last statement → its `.returning()` row is the
 * broadcast summary" invariant by COPY (the cron docstring even acknowledged the
 * mirror). If completeRun's tail drifted, finalizeStaleRun would silently
 * broadcast a stale/absent summary — caught by nothing. This concentrates the
 * tail so the invariant lives in one place.
 *
 * The real D1 transaction is unmockable in the vitest harness (the `void/db`
 * stub's `db` Proxy throws on access), so we mock `db.batch` + the query builders
 * and `@/live`'s `publishRunUpdate` to assert the pure orchestration contract:
 *   - the caller's status-update is FIRST and the recompute is appended LAST,
 *   - the summary broadcast to `run:<runId>` is the LAST batch result's first row
 *     (transactionally consistent with the recompute), with empty changedTests,
 *   - no broadcast when the recompute matched no row (run vanished mid-flight),
 *   - the merged summary is returned to the caller either way,
 *   - with `requireStatusFlip`, a no-op finalize (FIRST element's
 *     `meta.changes === 0`) is silent — no redundant broadcast — while a real
 *     flip still broadcasts, and the guard is OFF for completeRun.
 * The atomicity guarantee itself lives at the D1 boundary and is out of scope.
 */

const batchSpy = vi.fn<(statements: unknown[]) => Promise<unknown[]>>();

// A chainable query-builder stub: every method returns the same thenable so
// `db.update(...).set(...).where(...).returning(...)` resolves to one statement
// object the batch can carry. The status-update statement the caller builds is
// opaque to the seam, so a single sentinel suffices.
function builder(tag: string): PromiseLike<unknown> {
  const node: Record<string, unknown> = { __stmt: tag };
  const chain = () => node;
  node.set = chain;
  node.where = chain;
  node.returning = chain;
  node.from = chain;
  // The statement is collected into the batch array, never awaited directly, so
  // a real `then` is unnecessary — cast through `unknown` to satisfy callers
  // that type these builders as thenable Drizzle queries.
  return node as unknown as PromiseLike<unknown>;
}

vi.mock("void/db", () => ({
  db: {
    batch: batchSpy,
    update: () => builder("recompute"),
    select: () => builder("summarySelect"),
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

const publishSpy = vi.fn<(runId: string, event: unknown) => Promise<void>>(() =>
  Promise.resolve(),
);
vi.mock("@/live", () => ({
  publishRunUpdate: publishSpy,
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

beforeEach(() => {
  batchSpy.mockReset();
  publishSpy.mockReset();
  publishSpy.mockResolvedValue(undefined);
});

describe("reconcileAndBroadcast", () => {
  it("batches the caller's status-update FIRST and the recompute LAST", async () => {
    batchSpy.mockResolvedValue([[{ updated: 1 }], [SUMMARY]]);
    const statusUpdate = {
      __stmt: "status-flip",
    } as unknown as PromiseLike<unknown>;

    await reconcileAndBroadcast("run-1", statusUpdate, { projectId: "proj-1" });

    expect(batchSpy).toHaveBeenCalledTimes(1);
    const batched = batchSpy.mock.calls[0]![0] as unknown[];
    expect(batched).toHaveLength(2);
    // Caller's status statement is the head; the recompute (last) is what the
    // builder stub tagged. The positional contract — recompute LAST so its
    // returning() row is the summary — is exactly the invariant being pinned.
    expect(batched[0]).toBe(statusUpdate);
    expect(batched[1]).toMatchObject({ __stmt: "recompute" });
  });

  it("broadcasts the LAST batch row's summary to run:<id> with empty changedTests", async () => {
    batchSpy.mockResolvedValue([[{ updated: 1 }], [SUMMARY]]);

    const summary = await reconcileAndBroadcast(
      "run-42",
      { __stmt: "status-flip" } as unknown as PromiseLike<unknown>,
      { projectId: "proj-1" },
    );

    expect(summary).toEqual(SUMMARY);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const [runId, event] = publishSpy.mock.calls[0]!;
    expect(runId).toBe("run-42");
    expect(event).toEqual({
      type: "progress",
      changedTests: [],
      summary: SUMMARY,
    });
  });

  it("does NOT broadcast when the recompute matched no row (run vanished)", async () => {
    // The status-flip guard (status='running') or a deleted run leaves the
    // recompute's .returning() empty → summaryFromBatchResults yields null.
    batchSpy.mockResolvedValue([[{ updated: 0 }], []]);

    const summary = await reconcileAndBroadcast(
      "run-gone",
      { __stmt: "status-flip" } as unknown as PromiseLike<unknown>,
      { projectId: "proj-1" },
    );

    expect(summary).toBeNull();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("returns the merged summary so the caller can read back status", async () => {
    batchSpy.mockResolvedValue([[{ updated: 1 }], [SUMMARY]]);

    const summary = await reconcileAndBroadcast(
      "run-1",
      { __stmt: "status-flip" } as unknown as PromiseLike<unknown>,
      { projectId: "proj-1" },
    );

    expect(summary?.status).toBe("failed");
  });

  // `requireStatusFlip` is the finalizeStaleRun no-op guard. The guarded flip is
  // the FIRST batch element; its `meta.changes` says whether the run was still
  // "running" when the sweep wrote. A real D1 `run` statement returns a D1Result
  // ({ meta: { changes } }) for the non-.returning() flip — so the head element
  // here is that shape, not a rows array.
  describe("requireStatusFlip (finalizeStaleRun no-op guard)", () => {
    it("suppresses the broadcast when the guarded flip matched 0 rows", async () => {
      // Cron overlap / a winning /complete left the run off "running"; the flip
      // no-ops, but the (unguarded) recompute still returns the row's terminal
      // summary. The duplicate progress event is suppressed; DB is untouched.
      batchSpy.mockResolvedValue([{ meta: { changes: 0 } }, [SUMMARY]]);

      const summary = await reconcileAndBroadcast(
        "run-raced",
        { __stmt: "status-flip" } as unknown as PromiseLike<unknown>,
        { projectId: "proj-1" },
        { requireStatusFlip: true },
      );

      // Summary is still returned (callers may read it back), broadcast is not.
      expect(summary).toEqual(SUMMARY);
      expect(publishSpy).not.toHaveBeenCalled();
    });

    it("broadcasts when the guarded flip changed a row (the run was live)", async () => {
      batchSpy.mockResolvedValue([{ meta: { changes: 1 } }, [SUMMARY]]);

      const summary = await reconcileAndBroadcast(
        "run-stuck",
        { __stmt: "status-flip" } as unknown as PromiseLike<unknown>,
        { projectId: "proj-1" },
        { requireStatusFlip: true },
      );

      expect(summary).toEqual(SUMMARY);
      expect(publishSpy).toHaveBeenCalledTimes(1);
      expect(publishSpy.mock.calls[0]![0]).toBe("run-stuck");
    });

    it("still broadcasts on a 0-row flip when requireStatusFlip is OFF (completeRun)", async () => {
      // completeRun's merge UPDATE has no status guard — it always matches the
      // owned row — so it never opts into the guard and always broadcasts. Even
      // a (hypothetical) 0-change head must not suppress its broadcast.
      batchSpy.mockResolvedValue([{ meta: { changes: 0 } }, [SUMMARY]]);

      await reconcileAndBroadcast(
        "run-complete",
        { __stmt: "status-flip" } as unknown as PromiseLike<unknown>,
        { projectId: "proj-1" },
      );

      expect(publishSpy).toHaveBeenCalledTimes(1);
    });
  });
});
