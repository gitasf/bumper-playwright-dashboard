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
  node.values = chain;
  node.set = chain;
  node.onConflictDoNothing = (cfg: unknown) => {
    capturedConflict = cfg;
    return node;
  };
  (node as { then: unknown }).then = (onFulfilled?: (v: unknown) => unknown) =>
    Promise.resolve(onFulfilled ? onFulfilled([]) : []);

  const db = {
    select: chain,
    insert: chain,
    delete: chain,
    update: chain,
  };
  return { ...stub, db };
});

const { assignOwner, mergeOwners, removeOwner, setCodeownersFile } =
  await import("@/lib/owners-repo");

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

describe("setCodeownersFile", () => {
  it("scopes the update to the project", async () => {
    await setCodeownersFile(scope, "* @web", 1700);
    const { column, value } = readEq(capturedWhere);
    expect(column).toBe("id");
    expect(value).toBe("proj_xyz");
  });
});
