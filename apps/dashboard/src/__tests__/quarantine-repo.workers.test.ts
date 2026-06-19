import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { TenantScope } from "@/lib/scope";

/**
 * Quarantine repo scoping tests. Every query MUST filter by `scope.projectId`
 * (logical tenancy — there is no DO boundary), so a different project's scope
 * can never see another's quarantine rows. Rather than stand up a real D1, we
 * mock `void/db` with a chainable spy that records the WHERE predicate each
 * query builds (the same boundary-mock idiom as `ingest-pipeline.test.ts`), and
 * assert the predicate carries the scope's projectId — the cross-tenant
 * isolation the e2e `cross-tenant.spec.ts` proves end-to-end, pinned fast here.
 *
 * Operators (`and`/`eq`/`inArray`/`asc`) come from the real `void/db` stub
 * (`helpers/void-db-stub`), which records `{ __op, args }`, so we can read the
 * exact column/value pairs back out of the captured predicate.
 */

// ─── Controllable void/db mock ───────────────────────────────────────────────
//
// Operators are the recording placeholders from the project stub; `db` is a
// chainable builder whose terminal awaited result is an empty row set, and
// whose `.where(...)` arg is captured for assertion. `db.insert(...).values(...)
// .onConflictDoUpdate(...)` and `db.delete(...).where(...)` are also chainable
// thenables.

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
  node.limit = chain;
  node.values = chain;
  node.set = chain;
  node.onConflictDoUpdate = (cfg: unknown) => {
    capturedConflict = cfg;
    return node;
  };
  // Thenable: an awaited query resolves to an empty row set.
  (node as { then: unknown }).then = (onFulfilled?: (v: unknown) => unknown) =>
    Promise.resolve(onFulfilled ? onFulfilled([]) : []);

  const db = {
    select: chain,
    insert: chain,
    delete: chain,
  };
  return { ...stub, db };
});

const {
  listQuarantine,
  loadQuarantineByTestId,
  unquarantineTest,
  quarantineTest,
} = await import("@/lib/quarantine-repo");

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

describe("listQuarantine", () => {
  it("filters by the scope's projectId", async () => {
    await listQuarantine(scope);
    const { column, value } = readEq(capturedWhere);
    expect(column).toBe("projectId");
    expect(value).toBe("proj_xyz");
  });

  it("a different project's scope binds a different projectId (cross-tenant isolation)", async () => {
    await listQuarantine(otherScope);
    const { column, value } = readEq(capturedWhere);
    expect(column).toBe("projectId");
    expect(value).toBe("proj_OTHER");
    // The first scope's id can never leak into the second scope's query.
    expect(value).not.toBe("proj_xyz");
  });
});

describe("loadQuarantineByTestId", () => {
  it("ANDs projectId with an inArray over the testIds", async () => {
    await loadQuarantineByTestId("proj_xyz", ["t1", "t2"]);
    const and = capturedWhere as RecordedOp;
    expect(and.__op).toBe("and");
    const [projectEq, idsIn] = and.args as [RecordedOp, RecordedOp];
    expect(readEq(projectEq)).toEqual({
      column: "projectId",
      value: "proj_xyz",
    });
    expect(idsIn.__op).toBe("inArray");
    expect(idsIn.args[1]).toEqual(["t1", "t2"]);
  });

  it("a different projectId scopes the join to that project only", async () => {
    await loadQuarantineByTestId("proj_OTHER", ["t1"]);
    const and = capturedWhere as RecordedOp;
    const [projectEq] = and.args as [RecordedOp];
    expect(readEq(projectEq).value).toBe("proj_OTHER");
  });
});

describe("unquarantineTest", () => {
  it("scopes the delete by (projectId, testId)", async () => {
    await unquarantineTest(scope, "t1");
    const and = capturedWhere as RecordedOp;
    expect(and.__op).toBe("and");
    const [projectEq, testEq] = and.args as [RecordedOp, RecordedOp];
    expect(readEq(projectEq)).toEqual({
      column: "projectId",
      value: "proj_xyz",
    });
    expect(readEq(testEq)).toEqual({ column: "testId", value: "t1" });
  });
});

describe("quarantineTest", () => {
  it("upserts on the (projectId, testId) unique index", async () => {
    const row = await quarantineTest(
      scope,
      { testId: "t1", mode: "skip", reason: "flaky" },
      "user_1",
      1700,
    );
    // The returned row carries the scope's projectId + the supplied fields.
    expect(row.projectId).toBe("proj_xyz");
    expect(row.testId).toBe("t1");
    expect(row.mode).toBe("skip");
    expect(row.reason).toBe("flaky");
    expect(row.createdBy).toBe("user_1");
    expect(row.createdAt).toBe(1700);
    // Conflict target must be the unique (projectId, testId) pair — pin the
    // exact columns, not just the arity, so a wrong-but-2-element target
    // (e.g. [id, testId]) can't sneak past. `@schema` resolves to real Drizzle
    // columns in the test env, so each carries its `.name`.
    const cfg = capturedConflict as {
      target: { name?: string }[];
      set: Record<string, unknown>;
    };
    expect(cfg.target.map((col) => col.name)).toEqual(["projectId", "testId"]);
    // The update set refreshes mode/reason and re-stamps createdBy/createdAt
    // (documented intended behavior — re-quarantining updates the row).
    expect(cfg.set.mode).toBe("skip");
    expect(cfg.set.reason).toBe("flaky");
    expect(cfg.set.createdBy).toBe("user_1");
    expect(cfg.set.createdAt).toBe(1700);
  });
});
