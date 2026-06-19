import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * The last-owner invariant (roadmap 3.1): demoting OR removing a team's sole
 * owner must be impossible, and impossible RACE-SAFELY — the owner-count guard
 * rides INSIDE the UPDATE/DELETE WHERE, never a check-then-write. These tests
 * pin that the guard predicate (`notLastOwner`) is actually carried into the
 * statement and has the right shape, mirroring how `quarantine-repo.test.ts`
 * asserts scoping against the `void/db` stub — no real D1 needed.
 *
 * The stub records every operator call as `{ __op, args }`, and the chainable
 * `db` builder captures the `.where(...)` argument so we can read the predicate
 * tree back out. The terminal awaited result is controllable per-test so we can
 * drive the "row updated", "guard blocked (0 rows, still an owner)", and
 * "row vanished (0 rows, gone)" branches.
 */

let capturedWhere: unknown = null;
// Queue of result-sets the chainable thenable yields, in call order. `update`/
// `delete` consume the first (the `.returning()` set); the disambiguating
// `select` consumes the next.
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
    return node;
  };
  node.returning = chain;
  (node as { then: unknown }).then = (
    onFulfilled?: (v: unknown) => unknown,
  ) => {
    const next = resultQueue.shift() ?? [];
    return Promise.resolve(onFulfilled ? onFulfilled(next) : next);
  };

  const db = {
    select: chain,
    insert: chain,
    update: chain,
    delete: chain,
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

beforeEach(() => {
  capturedWhere = null;
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
    resultQueue = [[{ id: "m_1" }]]; // returning() → one row updated
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
    // update().returning() → 0 rows (guard blocked); follow-up select → still
    // present (the sole owner).
    resultQueue = [[], [{ role: "owner" }]];
    const result = await setMemberRole("team_1", "user_1", "member");
    expect(result).toEqual({ ok: false, reason: "lastOwner" });
  });

  it("reports `noop` when the row simply doesn't exist", async () => {
    resultQueue = [[], []]; // 0 rows updated, 0 rows on the existence check
    const result = await setMemberRole("team_1", "ghost", "member");
    expect(result).toEqual({ ok: false, reason: "noop" });
  });
});

describe("removeMemberGuarded — last-owner-safe removal", () => {
  it("carries the owner-count guard in the DELETE WHERE", async () => {
    resultQueue = [[{ id: "m_1" }]];
    const result = await removeMemberGuarded("team_1", "user_2");
    expect(result).toEqual({ ok: true });
    expect(findOwnerCountGuard(capturedWhere)).toBe(true);
  });

  it("reports `lastOwner` when removing the sole owner is blocked (0 rows, still present)", async () => {
    resultQueue = [[], [{ role: "owner" }]];
    const result = await removeMemberGuarded("team_1", "user_1");
    expect(result).toEqual({ ok: false, reason: "lastOwner" });
  });

  it("reports `noop` when the member is already gone", async () => {
    resultQueue = [[], []];
    const result = await removeMemberGuarded("team_1", "ghost");
    expect(result).toEqual({ ok: false, reason: "noop" });
  });
});

describe("leaveTeamGuarded — last-owner-safe self-leave", () => {
  it("carries the owner-count guard in the DELETE WHERE and reports ok on a deleted row", async () => {
    resultQueue = [[{ id: "m_1" }]];
    const result = await leaveTeamGuarded("team_1", "user_2");
    expect(result).toEqual({ ok: true });
    expect(findOwnerCountGuard(capturedWhere)).toBe(true);
  });

  it("reports `lastOwner` on a 0-row delete WITHOUT a vanished-vs-blocked re-check (membership is proven live)", async () => {
    // Only ONE result set is consumed (the delete's returning()); a second
    // queued set would be left untouched if a re-check fired — assert it isn't.
    resultQueue = [[], [{ role: "owner" }]];
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
