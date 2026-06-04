import { describe, it, expect, vi } from "vite-plus/test";

/**
 * `runBatch` (`@/lib/db-batch`) is the single owner of the `as never` cast that
 * Drizzle's `db.batch` tuple type forces on every dynamic batch. Before this
 * seam, that cast was copy-pasted at 7 batch call sites across 6 files (the two
 * `openRun` paths in ingest.ts, the team/project deletes, and the two invite
 * accepts). The deletion test for the helper is: remove it and the cast plus the
 * `PromiseLike<unknown>[]` plumbing reappear at each caller.
 *
 * The real D1 transaction is unmockable in the vitest harness (the `void/db`
 * stub's `db` Proxy throws on any access). So we mock `db.batch` to assert the
 * pure seam contract: callers hand `runBatch` a plain array and it (a) forwards
 * exactly those statements to `db.batch` unchanged — the cast is internal, so
 * the runtime payload is untouched — and (b) returns the batch result array
 * verbatim. The atomicity guarantee itself (durable decision #10) lives at the
 * D1 boundary and is out of scope for a unit test; this pins the type-ergonomics
 * contract the helper exists to own.
 */

const batchSpy = vi.fn((statements: unknown[]) =>
  Promise.resolve(statements.map((_, i) => [{ row: i }])),
);

vi.mock("void/db", () => ({
  db: { batch: batchSpy },
}));

const { runBatch } = await import("@/lib/db-batch");

describe("runBatch", () => {
  it("forwards the statements array to db.batch unchanged", async () => {
    const a = { __stmt: "insert" } as unknown as PromiseLike<unknown>;
    const b = { __stmt: "delete" } as unknown as PromiseLike<unknown>;
    batchSpy.mockClear();

    await runBatch([a, b]);

    expect(batchSpy).toHaveBeenCalledTimes(1);
    // The internal `as never` is a compile-time cast only — the runtime array
    // handed to db.batch is the caller's array element-for-element.
    expect(batchSpy.mock.calls[0]![0]).toEqual([a, b]);
  });

  it("returns the db.batch result array verbatim", async () => {
    batchSpy.mockClear();
    const results = await runBatch([
      {} as PromiseLike<unknown>,
      {} as PromiseLike<unknown>,
      {} as PromiseLike<unknown>,
    ]);

    // One result entry per statement, in order — the shape callers index into.
    expect(results).toEqual([[{ row: 0 }], [{ row: 1 }], [{ row: 2 }]]);
  });

  it("handles an empty batch", async () => {
    batchSpy.mockClear();
    const results = await runBatch([]);
    expect(batchSpy).toHaveBeenCalledWith([]);
    expect(results).toEqual([]);
  });
});
