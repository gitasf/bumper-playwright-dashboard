import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { TenantScope } from "@/lib/scope";

/**
 * Test-ownership repo tests (roadmap 2.3). Two surfaces:
 *
 *  1. The pure `mergeOwners` rule — manual owners override CODEOWNERS-derived
 *     ones per test. Unit-tested directly (no DB).
 *
 *  2. Query scoping — every mutation MUST filter by `scope.projectId` (logical
 *     tenancy — there is no DO boundary). Mirrors `quarantine-repo.test.ts`'s
 *     void/db-stub approach: a chainable spy records the WHERE predicate /
 *     conflict target so we can assert the scope's projectId is bound, and a
 *     different scope binds a different id (cross-tenant isolation).
 */

let capturedWhere: unknown = null;
let capturedConflict: unknown = null;
let capturedSet: unknown = null;
let setCalled = false;
let capturedValues: unknown = null;
let valuesCalled = false;
// Row the `select(...).limit(1)` read resolves to; drives the unchanged-guard
// in `setCodeownersFile` and `assignOwner`'s conflict-path fallback SELECT.
// Default `[]` (no current row); tests override it.
let selectResult: unknown[] = [];
// Set by a test to simulate the conflict path: `onConflictDoNothing` hit an
// existing row, `.returning()` is empty, so `assignOwner` falls back to the
// SELECT rather than fabricating a row from the discarded insert values.
let insertReturningResult: unknown[] | null = null;
// Which top-level `db.*` call opened the current chain — insert and its
// conflict-path follow-up SELECT share the same `node`/`.then`, so `.then`
// resolves insert (echoes `.values(...)` / `insertReturningResult`) vs. select
// (`selectResult`) accordingly.
let mode: "insert" | "select" | null = null;

vi.mock("void/db", async () => {
  const stub = await import("./helpers/void-db-stub");
  const node: Record<string, unknown> = {};
  const chain = () => node;
  node.from = chain;
  node.where = (w: unknown) => {
    capturedWhere = w;
    return node;
  };
  node.orderBy = chain;
  node.groupBy = chain;
  node.limit = chain;
  node.values = (v: unknown) => {
    capturedValues = v;
    valuesCalled = true;
    return node;
  };
  node.set = (v: unknown) => {
    capturedSet = v;
    setCalled = true;
    return node;
  };
  node.onConflictDoNothing = (cfg: unknown) => {
    capturedConflict = cfg;
    return node;
  };
  node.returning = () => node;
  (node as { then: unknown }).then = (
    onFulfilled?: (v: unknown) => unknown,
  ) => {
    const result =
      mode === "insert"
        ? (insertReturningResult ?? (capturedValues ? [capturedValues] : []))
        : selectResult;
    return Promise.resolve(onFulfilled ? onFulfilled(result) : result);
  };

  const select = () => {
    mode = "select";
    return node;
  };
  const insert = () => {
    mode = "insert";
    return node;
  };
  const db = {
    select,
    insert,
    delete: chain,
    update: chain,
    // `runBatch` builds its statements against the transaction executor; the
    // stub hands the same chainable node back so captures keep working.
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ select: chain, insert: chain, delete: chain, update: chain }),
  };
  return { ...stub, db };
});

const {
  assignOwner,
  mergeOwners,
  removeOwner,
  setCodeownersFile,
  setManualOwners,
} = await import("@/lib/owners-repo");

type RecordedOp = { __op: string; args: readonly unknown[] };

function readEq(node: unknown): { column: string; value: unknown } {
  const op = node as RecordedOp;
  expect(op.__op).toBe("eq");
  const column = (op.args[0] as { name?: unknown })?.name;
  return { column: column as string, value: op.args[1] };
}

const scope: TenantScope = {
  teamId: "team_abc" as TenantScope["teamId"],
  projectId: "proj_xyz" as TenantScope["projectId"],
  teamSlug: "acme",
  projectSlug: "web",
};

const otherScope: TenantScope = {
  teamId: "team_def" as TenantScope["teamId"],
  projectId: "proj_OTHER" as TenantScope["projectId"],
  teamSlug: "other",
  projectSlug: "site",
};

beforeEach(() => {
  capturedWhere = null;
  capturedConflict = null;
  capturedSet = null;
  setCalled = false;
  capturedValues = null;
  valuesCalled = false;
  selectResult = [];
  insertReturningResult = null;
  mode = null;
});

describe("mergeOwners (manual-wins union)", () => {
  it("uses ONLY manual owners when any manual owner exists", () => {
    expect(mergeOwners(["@web"], ["@codeowners-team"])).toEqual([
      { owner: "@web", source: "manual" },
    ]);
  });

  it("falls back to CODEOWNERS-derived owners when there are no manual owners", () => {
    expect(mergeOwners([], ["@a", "@b"])).toEqual([
      { owner: "@a", source: "codeowners" },
      { owner: "@b", source: "codeowners" },
    ]);
  });

  it("returns [] when neither leg has owners", () => {
    expect(mergeOwners([], [])).toEqual([]);
  });

  it("de-duplicates manual owners, preserving order", () => {
    expect(mergeOwners(["@a", "@b", "@a"], [])).toEqual([
      { owner: "@a", source: "manual" },
      { owner: "@b", source: "manual" },
    ]);
  });

  it("de-duplicates codeowners-derived owners, preserving order", () => {
    expect(mergeOwners([], ["@a", "@a", "@b"])).toEqual([
      { owner: "@a", source: "codeowners" },
      { owner: "@b", source: "codeowners" },
    ]);
  });

  it("manual fully shadows codeowners even if disjoint", () => {
    // A manual assignment is the source of truth: the codeowners owner is NOT
    // appended alongside it.
    expect(mergeOwners(["@manual"], ["@from-file"])).toEqual([
      { owner: "@manual", source: "manual" },
    ]);
  });
});

describe("assignOwner", () => {
  it("returns a row scoped to the project + upserts on (projectId, testId, owner)", async () => {
    const row = await assignOwner(scope, { testId: "t1", owner: "@web" }, 1700);
    expect(row.projectId).toBe("proj_xyz");
    expect(row.testId).toBe("t1");
    expect(row.owner).toBe("@web");
    expect(row.source).toBe("manual");
    expect(row.createdAt).toBe(1700);
    const cfg = capturedConflict as { target: { name?: string }[] };
    expect(cfg.target.map((col) => col.name)).toEqual([
      "projectId",
      "testId",
      "owner",
    ]);
  });

  it("falls back to the existing persisted row when onConflictDoNothing no-ops (conflict path), not a fabricated one", async () => {
    // Re-assigning an existing owner: the INSERT conflicts, `.returning()` is
    // empty, so `assignOwner` must read the real persisted row (original
    // `id`/`createdAt`), not the locally-built ulid+`now` that was never written.
    insertReturningResult = [];
    const persistedRow = {
      id: "existing_owner_id",
      projectId: "proj_xyz",
      testId: "t1",
      owner: "@web",
      source: "manual" as const,
      createdAt: 1000,
    };
    selectResult = [persistedRow];

    const row = await assignOwner(scope, { testId: "t1", owner: "@web" }, 1700);

    expect(row).toEqual(persistedRow);
    expect(row.id).toBe("existing_owner_id");
    expect(row.createdAt).toBe(1000);
  });
});

describe("removeOwner", () => {
  it("scopes the delete by (projectId, testId, owner)", async () => {
    await removeOwner(scope, "t1", "@web");
    const and = capturedWhere as RecordedOp;
    expect(and.__op).toBe("and");
    const [projectEq, testEq, ownerEq] = and.args as [
      RecordedOp,
      RecordedOp,
      RecordedOp,
    ];
    expect(readEq(projectEq)).toEqual({
      column: "projectId",
      value: "proj_xyz",
    });
    expect(readEq(testEq)).toEqual({ column: "testId", value: "t1" });
    expect(readEq(ownerEq)).toEqual({ column: "owner", value: "@web" });
  });

  it("a different scope binds a different projectId (cross-tenant isolation)", async () => {
    await removeOwner(otherScope, "t1", "@web");
    const and = capturedWhere as RecordedOp;
    const [projectEq] = and.args as [RecordedOp];
    expect(readEq(projectEq).value).toBe("proj_OTHER");
    expect(readEq(projectEq).value).not.toBe("proj_xyz");
  });
});

describe("setManualOwners", () => {
  it("deletes the manual rows scoped by (projectId, testId, source) then inserts the new set", async () => {
    await setManualOwners(scope, "t1", ["@web", "a@b.c"], 1700);
    // The delete's WHERE is captured first; the insert has no WHERE, so the
    // last-captured predicate is still the delete's.
    const and = capturedWhere as RecordedOp;
    expect(and.__op).toBe("and");
    const [projectEq, testEq, sourceEq] = and.args as [
      RecordedOp,
      RecordedOp,
      RecordedOp,
    ];
    expect(readEq(projectEq)).toEqual({
      column: "projectId",
      value: "proj_xyz",
    });
    expect(readEq(testEq)).toEqual({ column: "testId", value: "t1" });
    expect(readEq(sourceEq)).toEqual({ column: "source", value: "manual" });

    const rows = capturedValues as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.owner)).toEqual(["@web", "a@b.c"]);
    for (const row of rows) {
      expect(row.projectId).toBe("proj_xyz");
      expect(row.testId).toBe("t1");
      expect(row.source).toBe("manual");
      expect(row.createdAt).toBe(1700);
    }
  });

  it("de-duplicates the incoming owners, preserving order", async () => {
    await setManualOwners(scope, "t1", ["@a", "@b", "@a"], 1700);
    const rows = capturedValues as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.owner)).toEqual(["@a", "@b"]);
  });

  it("an empty set only deletes (clears manual ownership, no insert)", async () => {
    await setManualOwners(scope, "t1", [], 1700);
    expect(valuesCalled).toBe(false);
    const and = capturedWhere as RecordedOp;
    expect(and.__op).toBe("and");
  });

  it("a different scope binds a different projectId (cross-tenant isolation)", async () => {
    await setManualOwners(otherScope, "t1", ["@web"], 1700);
    const and = capturedWhere as RecordedOp;
    const [projectEq] = and.args as [RecordedOp];
    expect(readEq(projectEq).value).toBe("proj_OTHER");
    const rows = capturedValues as Array<Record<string, unknown>>;
    expect(rows[0]?.projectId).toBe("proj_OTHER");
  });
});

describe("setCodeownersFile", () => {
  it("writes the trimmed value + bump, scoped to the project, when changed", async () => {
    selectResult = [{ file: null }];
    await setCodeownersFile(scope, "  * @web  ", 1700);
    expect(setCalled).toBe(true);
    expect(capturedSet).toEqual({
      codeownersFile: "* @web",
      codeownersUpdatedAt: 1700,
    });
    // The update's WHERE is the last `.where(...)` recorded (after the read's).
    const { column, value } = readEq(capturedWhere);
    expect(column).toBe("id");
    expect(value).toBe("proj_xyz");
  });

  it("a different scope binds a different projectId (cross-tenant isolation)", async () => {
    selectResult = [{ file: null }];
    await setCodeownersFile(otherScope, "* @web", 1700);
    expect(readEq(capturedWhere).value).toBe("proj_OTHER");
  });

  it("UNCHANGED-GUARD: skips the write AND the timestamp bump when the normalized next equals current", async () => {
    selectResult = [{ file: "* @web" }];
    // Same content with surrounding whitespace normalizes to the current value.
    await setCodeownersFile(scope, "  * @web  ", 9999);
    expect(setCalled).toBe(false);
    expect(capturedSet).toBeNull();
  });

  it("UNCHANGED-GUARD: empty/whitespace against an already-null file is a no-op", async () => {
    selectResult = [{ file: null }];
    await setCodeownersFile(scope, "   ", 9999);
    expect(setCalled).toBe(false);
  });

  it("NULL-CLEAR: empty/whitespace clears a non-null file to null (and bumps)", async () => {
    selectResult = [{ file: "* @web" }];
    await setCodeownersFile(scope, "   ", 1700);
    expect(setCalled).toBe(true);
    expect(capturedSet).toEqual({
      codeownersFile: null,
      codeownersUpdatedAt: 1700,
    });
  });

  it("NULL-CLEAR: an explicit null clears a non-null file", async () => {
    selectResult = [{ file: "* @web" }];
    await setCodeownersFile(scope, null, 1700);
    expect(setCalled).toBe(true);
    expect(capturedSet).toEqual({
      codeownersFile: null,
      codeownersUpdatedAt: 1700,
    });
  });
});
