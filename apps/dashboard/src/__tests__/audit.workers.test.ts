import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * Audit log helper tests (roadmap 3.2). Two surfaces:
 *
 *  1. `buildAuditRow` — the PURE row-shape builder. Pins the action constant,
 *     actor, the projectId/targetType/targetId defaults, and the one-place
 *     metadata (stored as a jsonb object). No DB, no request context.
 *
 *  2. `recordAudit` — the best-effort writer. The hard contract: a failed audit
 *     write must NEVER propagate (it can't be allowed to break the invite / key /
 *     role mutation it records). We mock `void/db` with an insert that THROWS and
 *     assert `recordAudit` resolves anyway, with the failure routed to
 *     `logger.error`. We also assert it writes exactly one row and awaits it
 *     (the insert is synchronous — important so a delete can capture context
 *     before its cascade, and so workerd doesn't drop the write).
 *
 * Same `void/db`-stub idiom as `members-repo.test.ts` / `quarantine-repo.test.ts`.
 */

// Drives the mocked insert: when true the awaited insert throws.
let insertShouldThrow = false;
// Records every `db.insert(...).values(...)` payload, in order.
let insertedRows: unknown[] = [];

vi.mock("void/db", async () => {
  const stub = await import("./helpers/void-db-stub");
  const node: Record<string, unknown> = {};
  node.values = (row: unknown) => {
    insertedRows.push(row);
    return node;
  };
  (node as { then: unknown }).then = (
    onFulfilled?: (v: unknown) => unknown,
    onRejected?: (e: unknown) => unknown,
  ) => {
    if (insertShouldThrow) {
      const err = new Error("d1 write failed");
      return onRejected
        ? Promise.resolve(onRejected(err))
        : Promise.reject(err);
    }
    return Promise.resolve(onFulfilled ? onFulfilled(undefined) : undefined);
  };
  const db = { insert: () => node };
  return { ...stub, db };
});

// requireAuth returns a fixed actor; the context arg is ignored by the mock.
vi.mock("void/auth", () => ({
  requireAuth: () => ({ id: "user_actor_1" }),
}));

const loggerError = vi.fn();
vi.mock("void/log", () => ({
  logger: { error: (...args: unknown[]) => loggerError(...args) },
}));

const { AUDIT_ACTIONS, buildAuditRow, recordAudit } =
  await import("@/lib/audit");

// `c` is never read by the mocked requireAuth — a bare object suffices.
const fakeContext = {} as Parameters<typeof recordAudit>[0];

beforeEach(() => {
  insertShouldThrow = false;
  insertedRows = [];
  loggerError.mockClear();
});

describe("buildAuditRow (pure row shape)", () => {
  it("carries the action constant, actor, and a fresh ULID id + epoch-seconds createdAt", () => {
    const row = buildAuditRow(
      "user_actor_1",
      { teamId: "team_1", action: AUDIT_ACTIONS.KEY_MINT },
      1_700_000_000,
    );
    expect(row.action).toBe("key.mint");
    expect(row.actorUserId).toBe("user_actor_1");
    expect(row.teamId).toBe("team_1");
    expect(row.createdAt).toBe(1_700_000_000);
    expect(typeof row.id).toBe("string");
    expect((row.id as string).length).toBeGreaterThan(0);
  });

  it("defaults projectId / targetType / targetId / metadata to null when omitted", () => {
    const row = buildAuditRow("u", {
      teamId: "team_1",
      action: AUDIT_ACTIONS.TEAM_DELETE,
    });
    expect(row.projectId).toBeNull();
    expect(row.targetType).toBeNull();
    expect(row.targetId).toBeNull();
    expect(row.metadata).toBeNull();
  });

  it("stores the metadata bag as an object (jsonb column, no stringify)", () => {
    const row = buildAuditRow("u", {
      teamId: "team_1",
      action: AUDIT_ACTIONS.MEMBER_ROLE_CHANGE,
      targetType: "member",
      targetId: "user_2",
      metadata: { role: "viewer" },
    });
    expect(row.targetType).toBe("member");
    expect(row.targetId).toBe("user_2");
    expect(row.metadata).toEqual({ role: "viewer" });
  });

  it("passes the supplied projectId straight through", () => {
    const row = buildAuditRow("u", {
      teamId: "team_1",
      projectId: "proj_9",
      action: AUDIT_ACTIONS.PROJECT_DELETE,
    });
    expect(row.projectId).toBe("proj_9");
  });
});

describe("recordAudit (best-effort writer)", () => {
  it("inserts exactly one row, resolving the actor from the session", async () => {
    await recordAudit(fakeContext, {
      teamId: "team_1",
      action: AUDIT_ACTIONS.INVITE_MINT,
      targetType: "invite",
      targetId: "a@b.com",
      metadata: { role: "member" },
    });
    expect(insertedRows).toHaveLength(1);
    const row = insertedRows[0] as Record<string, unknown>;
    expect(row.actorUserId).toBe("user_actor_1");
    expect(row.action).toBe("invite.mint");
    expect(row.targetId).toBe("a@b.com");
    expect(row.metadata).toEqual({ role: "member" });
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("swallows a failing insert (never propagates) and logs the failure", async () => {
    insertShouldThrow = true;
    // The whole point: a throwing db must NOT reject — the recorded mutation
    // (invite/key/role change) has to survive a broken audit write.
    await expect(
      recordAudit(fakeContext, {
        teamId: "team_1",
        action: AUDIT_ACTIONS.KEY_REVOKE,
      }),
    ).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledTimes(1);
    const [msg, fields] = loggerError.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(msg).toBe("recordAudit failed");
    expect(fields.action).toBe("key.revoke");
  });

  it("returns a promise (is awaitable / synchronous, not fire-and-forget)", () => {
    const result = recordAudit(fakeContext, {
      teamId: "team_1",
      action: AUDIT_ACTIONS.PROJECT_CREATE,
    });
    expect(result).toBeInstanceOf(Promise);
    return result;
  });
});
