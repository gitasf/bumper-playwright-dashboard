import { describe, expect, it, vi } from "vite-plus/test";

/**
 * `runBatch` (`@/lib/db-batch`) is the atomicity seam: callers hand it a builder
 * `(tx) => statements[]` and it runs every statement inside a single Postgres
 * `db.transaction`, returning the awaited per-statement results in order. The
 * builder form is load-bearing — statements MUST be built against the passed
 * `tx` to enroll in the transaction (a statement built off the pooled `db` runs
 * on a different connection and wouldn't be atomic).
 *
 * The real transaction is exercised end-to-end against pglite / real Postgres in
 * `pg-integration.test.ts`. Here we mock `db.transaction` to pin the pure seam
 * contract (invoke the builder with the tx executor; collect results in order).
 */

// Mock `db.transaction(fn)` to invoke the callback with a throwaway tx executor —
// runBatch's inner async fn builds the statements against it and awaits each.
const txExec = { __tx: true };
const transactionSpy = vi.fn((fn: (tx: unknown) => unknown) => fn(txExec));

vi.mock("void/db", () => ({
  db: { transaction: transactionSpy },
}));

const { runBatch, isForeignKeyViolation } = await import("@/lib/db-batch");

describe("runBatch", () => {
  it("runs the builder's statements in a transaction, returning results in order", async () => {
    transactionSpy.mockClear();
    const results = await runBatch(() => [
      Promise.resolve([{ row: 0 }]),
      Promise.resolve([{ row: 1 }]),
    ]);

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    // One result entry per statement, in order — the shape callers index into.
    expect(results).toEqual([[{ row: 0 }], [{ row: 1 }]]);
  });

  it("builds statements against the transaction executor (not the pooled db)", async () => {
    let received: unknown;
    await runBatch((tx) => {
      received = tx;
      return [];
    });
    expect(received).toBe(txExec);
  });

  it("handles an empty batch", async () => {
    const results = await runBatch(() => []);
    expect(results).toEqual([]);
  });
});

describe("isForeignKeyViolation", () => {
  it("detects SQLSTATE 23503 by code, by message, or a cause hop down", () => {
    expect(isForeignKeyViolation({ code: "23503" })).toBe(true);
    expect(
      isForeignKeyViolation(
        new Error(
          'insert or update on table "runs" violates foreign key constraint "runs_monitorId_monitors_id_fk"',
        ),
      ),
    ).toBe(true);
    // Drizzle wraps the driver error, so the code can sit a `.cause` hop down.
    expect(isForeignKeyViolation({ cause: { code: "23503" } })).toBe(true);
  });

  it("is false for a unique violation and for unrelated errors", () => {
    expect(isForeignKeyViolation({ code: "23505" })).toBe(false);
    expect(isForeignKeyViolation(new Error("connection reset"))).toBe(false);
    expect(isForeignKeyViolation(null)).toBe(false);
  });
});
