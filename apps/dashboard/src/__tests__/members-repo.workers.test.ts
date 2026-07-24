import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * The last-owner invariant (roadmap 3.1): demoting or removing a team's sole
 * owner must be impossible, and race-safely so. Two race shapes (see the
 * `members-repo` module doc):
 *
 *  - same-row race: closed by the owner-count guard inside the UPDATE/DELETE
 *    WHERE (`notLastOwner`), never a separate check-then-write;
 *  - cross-row write-skew (two owners demoting/removing each other): closed by
 *    locking the team's owner rows first (`SELECT ... FOR UPDATE`) inside a
 *    `db.transaction`, before the guarded write runs on the same `tx`.
 *
 * These pin both: that `notLastOwner` is carried into the statement with the
 * right shape, and that the owner-row lock fires ahead of the write for
 * demote/remove/leave (skipped for promote-to-owner).
 *
 * The stub records operator calls as `{ __op, args }` and captures each
 * top-level `tx` call as an ordered `Call` (its `.where`, `.orderBy`,
 * `.for("update")`), so tests read the guard predicate back out and assert the
 * lock-then-write order. `db.transaction(fn)` invokes `fn` with that same `tx`.
 * Each call's awaited result comes from a per-test queue consumed in call order
 * (the lock consumes one slot too), driving the row-updated / guard-blocked /
 * row-vanished branches.
 */

type Call = {
  kind: "select" | "update" | "delete";
  where: unknown;
  orderBy?: unknown;
  forUpdate?: boolean;
};

let capturedWhere: unknown = null;
// Ordered top-level select/update/delete calls per invocation, so tests can
// assert the owner-row lock (a `select ... for update`) fires before the write.
let calls: Call[] = [];
// Result-sets the thenable yields, in call order: lock (if it fires) →
// `update`/`delete` `.returning()` set → the disambiguating `select`.
let resultQueue: unknown[][] = [];

vi.mock("void/db", async () => {
  const stub = await import("./helpers/void-db-stub");
  const node: Record<string, unknown> = {};
  const chain = () => node;
  node.from = chain;
  node.set = chain;
  node.values = chain;
  node.limit = chain;
  node.where = (w: unknown) => {
    capturedWhere = w;
    const current = calls[calls.length - 1];
    if (current) current.where = w;
    return node;
  };
  node.orderBy = (o: unknown) => {
    const current = calls[calls.length - 1];
    if (current) current.orderBy = o;
    return node;
  };
  node.for = (mode: unknown) => {
    const current = calls[calls.length - 1];
    if (current) current.forUpdate = mode === "update";
    return node;
  };
  node.returning = chain;
  (node as { then: unknown }).then = (
    onFulfilled?: (v: unknown) => unknown,
  ) => {
    const next = resultQueue.shift() ?? [];
    return Promise.resolve(onFulfilled ? onFulfilled(next) : next);
  };

  function makeEntry(kind: Call["kind"]) {
    return () => {
      calls.push({ kind, where: undefined });
      return node;
    };
  }

  const tx = {
    select: makeEntry("select"),
    update: makeEntry("update"),
    delete: makeEntry("delete"),
  };

  const db = {
    ...tx,
    transaction: (fn: (exec: typeof tx) => unknown) => fn(tx),
  };
  return { ...stub, db };
});

const {
  notLastOwner,
  setMemberRole,
  removeMemberGuarded,
  leaveTeamGuarded,
  roleSchema,
} = await import("@/lib/members-repo");

type RecordedOp = { __op: string; args: readonly unknown[]; strings?: unknown };

/**
 * Walk a recorded predicate tree and assert it contains an `or(...)` whose
 * second arm is the owner-count `sql` subquery with `count(*)` and the
 * `'owner'` role literal — i.e. the race-safe last-owner guard.
 */
function findOwnerCountGuard(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const op = node as RecordedOp;
  if (op.__op === "sql") {
    const raw = Array.isArray(op.strings) ? op.strings.join(" ") : "";
    if (/count\(\*\)/.test(raw) && /'owner'/.test(raw)) return true;
  }
  for (const arg of op.args ?? []) {
    if (findOwnerCountGuard(arg)) return true;
  }
  return false;
}

/**
 * Whether a captured `.where(...)` is the plain owner-row lock predicate
 * `and(eq(teamId), eq(role, "owner"))` (not `notLastOwner`'s count(*) guard).
 * Walks the `and(...)` args rather than assuming order.
 */
function isOwnerRowLockWhere(node: unknown, teamId: string): boolean {
  if (!node || typeof node !== "object") return false;
  const op = node as RecordedOp;
  if (op.__op !== "and") return false;
  const args = (op.args ?? []) as RecordedOp[];
  const hasTeamEq = args.some(
    (a) => a.__op === "eq" && a.args.includes(teamId),
  );
  const hasOwnerRoleEq = args.some(
    (a) => a.__op === "eq" && a.args.includes("owner"),
  );
  return hasTeamEq && hasOwnerRoleEq;
}

beforeEach(() => {
  capturedWhere = null;
  calls = [];
  resultQueue = [];
});

describe("notLastOwner (the shared race-safe guard predicate)", () => {
  it("is an `or(role != 'owner', <owner-count subquery> > 1)`", () => {
    const pred = notLastOwner("team_1") as unknown as RecordedOp;
    expect(pred.__op).toBe("or");
    // First arm: a `ne` over the role column.
    const firstArm = pred.args[0] as RecordedOp;
    expect(firstArm.__op).toBe("ne");
    // Second arm: the owner-count subquery.
    const secondArm = pred.args[1] as RecordedOp;
    expect(secondArm.__op).toBe("sql");
    expect(findOwnerCountGuard(pred)).toBe(true);
  });

  it("binds the supplied teamId into the subquery params", () => {
    const pred = notLastOwner("team_XYZ") as unknown as RecordedOp;
    const subquery = pred.args[1] as RecordedOp;
    expect(subquery.args).toContain("team_XYZ");
  });
});

describe("setMemberRole — last-owner-safe demotion", () => {
  it("carries the owner-count guard in the UPDATE WHERE when demoting (non-owner target role)", async () => {
    // Lock select consumes the first slot, then update().returning() → one row.
    resultQueue = [[], [{ id: "m_1" }]];
    const result = await setMemberRole("team_1", "user_2", "viewer");
    expect(result).toEqual({ ok: true });
    expect(findOwnerCountGuard(capturedWhere)).toBe(true);
  });

  it("does NOT apply the guard when PROMOTING to owner (never reduces owner count)", async () => {
    resultQueue = [[{ id: "m_1" }]];
    const result = await setMemberRole("team_1", "user_2", "owner");
    expect(result).toEqual({ ok: true });
    // Promoting to owner can't strand the team, so no owner-count subquery.
    expect(findOwnerCountGuard(capturedWhere)).toBe(false);
  });

  it("reports `lastOwner` when the guarded UPDATE matches 0 rows but the row still exists as owner", async () => {
    // Lock select, then update().returning() → 0 rows (guard blocked); follow-up
    // select → still present (the sole owner).
    resultQueue = [[], [], [{ role: "owner" }]];
    const result = await setMemberRole("team_1", "user_1", "member");
    expect(result).toEqual({ ok: false, reason: "lastOwner" });
  });

  it("reports `noop` when the row simply doesn't exist", async () => {
    // Lock select, 0 rows updated, 0 rows on the existence check.
    resultQueue = [[], [], []];
    const result = await setMemberRole("team_1", "ghost", "member");
    expect(result).toEqual({ ok: false, reason: "noop" });
  });
});

describe("removeMemberGuarded — last-owner-safe removal", () => {
  it("carries the owner-count guard in the DELETE WHERE", async () => {
    resultQueue = [[], [{ id: "m_1" }]];
    const result = await removeMemberGuarded("team_1", "user_2");
    expect(result).toEqual({ ok: true });
    expect(findOwnerCountGuard(capturedWhere)).toBe(true);
  });

  it("reports `lastOwner` when removing the sole owner is blocked (0 rows, still present)", async () => {
    resultQueue = [[], [], [{ role: "owner" }]];
    const result = await removeMemberGuarded("team_1", "user_1");
    expect(result).toEqual({ ok: false, reason: "lastOwner" });
  });

  it("reports `noop` when the member is already gone", async () => {
    resultQueue = [[], [], []];
    const result = await removeMemberGuarded("team_1", "ghost");
    expect(result).toEqual({ ok: false, reason: "noop" });
  });
});

describe("lockOwnerRows — cross-row write-skew guard (owner-row SELECT ... FOR UPDATE)", () => {
  it("locks the team's owner rows FIRST, before the guarded UPDATE, when demoting", async () => {
    resultQueue = [[], [{ id: "m_1" }]];
    await setMemberRole("team_1", "user_2", "viewer");
    expect(calls.map((c) => c.kind)).toEqual(["select", "update"]);
    expect(calls[0]?.forUpdate).toBe(true);
    expect(isOwnerRowLockWhere(calls[0]?.where, "team_1")).toBe(true);
  });

  it("is SKIPPED when promoting to owner", async () => {
    resultQueue = [[{ id: "m_1" }]];
    await setMemberRole("team_1", "user_2", "owner");
    expect(calls.map((c) => c.kind)).toEqual(["update"]);
  });

  it("locks the team's owner rows FIRST, before the guarded DELETE, for removeMemberGuarded", async () => {
    resultQueue = [[], [{ id: "m_1" }]];
    await removeMemberGuarded("team_1", "user_2");
    expect(calls.map((c) => c.kind)).toEqual(["select", "delete"]);
    expect(calls[0]?.forUpdate).toBe(true);
    expect(isOwnerRowLockWhere(calls[0]?.where, "team_1")).toBe(true);
  });

  it("locks the team's owner rows FIRST, before the guarded DELETE, for leaveTeamGuarded", async () => {
    resultQueue = [[], [{ id: "m_1" }]];
    await leaveTeamGuarded("team_1", "user_2");
    expect(calls.map((c) => c.kind)).toEqual(["select", "delete"]);
    expect(calls[0]?.forUpdate).toBe(true);
    expect(isOwnerRowLockWhere(calls[0]?.where, "team_1")).toBe(true);
  });
});

describe("leaveTeamGuarded — last-owner-safe self-leave", () => {
  it("carries the owner-count guard in the DELETE WHERE and reports ok on a deleted row", async () => {
    resultQueue = [[], [{ id: "m_1" }]];
    const result = await leaveTeamGuarded("team_1", "user_2");
    expect(result).toEqual({ ok: true });
    expect(findOwnerCountGuard(capturedWhere)).toBe(true);
  });

  it("reports `lastOwner` on a 0-row delete WITHOUT a vanished-vs-blocked re-check (membership is proven live)", async () => {
    // Lock select consumes the first slot, the delete's returning() the
    // second; a THIRD queued set would be left untouched if a re-check fired
    // — assert it isn't.
    resultQueue = [[], [], [{ role: "owner" }]];
    const result = await leaveTeamGuarded("team_1", "user_1");
    expect(result).toEqual({ ok: false, reason: "lastOwner" });
    expect(resultQueue.length).toBe(1); // the existence-check set was NOT consumed
  });
});

describe("roleSchema (shared invite + role-edit validator)", () => {
  it("accepts the three valid roles", () => {
    for (const r of ["owner", "member", "viewer"]) {
      expect(roleSchema.safeParse(r).success).toBe(true);
    }
  });

  it("rejects anything else", () => {
    for (const bad of ["admin", "", "Owner", "guest"]) {
      expect(roleSchema.safeParse(bad).success).toBe(false);
    }
  });
});
