import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * `action-errors.ts` owns the "a mutation DB error is logged" contract:
 *
 *  1. `mutationErrorMessage` — UNIQUE violation is an *expected* user error:
 *     return the friendly message WITHOUT logging. Anything else logs (once)
 *     and returns the generic message.
 *
 *  2. Logging is CAUSE-AWARE via `describeError`. Drizzle wraps the driver
 *     error — a `DrizzleQueryError`'s own `.message` is only
 *     `"Failed query: <sql>"`, with the real Postgres reason (SQLSTATE,
 *     `FATAL … branch does not exist`) on `.cause` — so the logged payload
 *     must carry the cause's pg fields, not just the wrapper message.
 *
 *  3. `logMutationFailure` — the shared path the settings actions' hand-rolled
 *     catch blocks use — merges call-site `extra` context (teamId/projectId)
 *     with the error description.
 */

// `action-errors` → `db-batch` → `void/db`; `isUniqueViolation` is pure, so
// the module only needs `void/db` to load.
vi.mock("void/db", () => ({ db: {} }));

const loggerError = vi.fn();
vi.mock("void/log", () => ({
  logger: { error: (...args: unknown[]) => loggerError(...args) },
}));

const { logMutationFailure, mutationErrorMessage } =
  await import("@/lib/action-errors");

/** A Drizzle-shaped wrapper: bland message, real pg error on `.cause`. */
function drizzleWrapped(pgFields: Record<string, unknown>, pgMessage: string) {
  return new Error("Failed query: update teams set name = $1", {
    cause: Object.assign(new Error(pgMessage), pgFields),
  });
}

beforeEach(() => {
  loggerError.mockClear();
});

describe("mutationErrorMessage", () => {
  it("returns uniqueMessage WITHOUT logging on a unique violation (even one hop down the cause chain)", () => {
    const err = drizzleWrapped(
      { code: "23505", constraint: "teams_slug_unique" },
      'duplicate key value violates unique constraint "teams_slug_unique"',
    );
    const msg = mutationErrorMessage(err, {
      context: "update team failed",
      uniqueMessage: "That slug is already taken.",
      genericMessage: "Could not save changes.",
    });
    expect(msg).toBe("That slug is already taken.");
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("logs an unexpected failure cause-aware (SQLSTATE survives the Drizzle wrapper) and returns genericMessage", () => {
    const err = drizzleWrapped(
      { code: "28000", severity: "FATAL" },
      "FATAL: branch abc123 does not exist",
    );
    const msg = mutationErrorMessage(err, {
      context: "update team failed",
      uniqueMessage: "That slug is already taken.",
      genericMessage: "Could not save changes.",
    });
    expect(msg).toBe("Could not save changes.");
    expect(loggerError).toHaveBeenCalledTimes(1);
    const [context, payload] = loggerError.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(context).toBe("update team failed");
    // The wrapper message alone is the blind spot — the payload must surface
    // the driver cause with its pg diagnostic fields.
    expect(payload.message).toBe("Failed query: update teams set name = $1");
    expect(payload.cause).toEqual(
      expect.objectContaining({
        message: "FATAL: branch abc123 does not exist",
        code: "28000",
        severity: "FATAL",
      }),
    );
  });
});

describe("logMutationFailure", () => {
  it("merges call-site extra context with the cause-aware error description", () => {
    const err = drizzleWrapped(
      { code: "42P01" },
      'relation "teams" does not exist',
    );
    logMutationFailure("delete team failed", err, { teamId: "team_1" });
    expect(loggerError).toHaveBeenCalledTimes(1);
    const [context, payload] = loggerError.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(context).toBe("delete team failed");
    expect(payload.teamId).toBe("team_1");
    expect(payload.cause).toEqual(expect.objectContaining({ code: "42P01" }));
  });

  it("handles non-Error throws without an extra bag", () => {
    logMutationFailure("update retention failed", "boom");
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledWith("update retention failed", {
      message: "boom",
    });
  });
});
