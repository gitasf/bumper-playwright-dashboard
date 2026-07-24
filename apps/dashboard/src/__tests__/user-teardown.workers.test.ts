import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * `cleanupUserData` best-effort contract (schema-rework Phase 4). It runs as the
 * Better Auth `deleteUser.afterDelete` hook — AFTER the auth user row is gone —
 * so a failed sweep must be logged (`logger.error`) and swallowed, never
 * propagated: a rejection would surface a spurious 500 for an account deletion
 * that already succeeded (Better Auth won't roll it back). Same best-effort +
 * `void/db`-stub idiom as `audit.workers.test.ts`.
 */

// Drives the mocked sweep transaction: when true, `runBatch` rejects.
let runBatchShouldThrow = false;

vi.mock("@/lib/db/batch", () => ({
  // The builder arg is intentionally ignored — we never touch a real DB; we only
  // exercise cleanupUserData's try/catch around the transaction.
  runBatch: async () => {
    if (runBatchShouldThrow) throw new Error("tx failed");
    return [];
  },
}));

// The module imports { and, count, db, eq, inArray } from void/db at load time;
// the stub provides them (cleanupUserData never dereferences `db`).
vi.mock("void/db", async () => await import("./helpers/void-db-stub"));

const loggerError = vi.fn();
vi.mock("void/log", () => ({
  logger: { error: (...args: unknown[]) => loggerError(...args) },
}));

const { cleanupUserData } = await import("@/lib/user-teardown");

beforeEach(() => {
  runBatchShouldThrow = false;
  loggerError.mockClear();
});

describe("cleanupUserData (best-effort afterDelete sweep)", () => {
  it("resolves without logging when the sweep succeeds", async () => {
    await expect(cleanupUserData("u1")).resolves.toBeUndefined();
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("swallows a failed sweep and routes it to logger.error (never rejects)", async () => {
    runBatchShouldThrow = true;
    // The auth user is already deleted by this hook, so the promise MUST resolve
    // — a rejection here would 500 an already-succeeded account deletion.
    await expect(cleanupUserData("u1")).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledTimes(1);
    const [msg, fields] = loggerError.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(msg).toBe("cleanupUserData failed");
    expect(fields).toMatchObject({ userId: "u1", message: "tx failed" });
  });
});
