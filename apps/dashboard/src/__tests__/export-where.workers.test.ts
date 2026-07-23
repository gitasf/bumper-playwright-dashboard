import { describe, expect, it } from "vite-plus/test";
import { buildRunsPageWhere } from "@/lib/export";
import { EMPTY_FILTERS } from "@/lib/runs/filters";
import type { TenantScope } from "@/lib/scope";

/**
 * The public query/export runs-list WHERE construction (roadmap 2.5). Mirrors
 * `runs-filters-where.test.ts` / `run-diff.test.ts`'s void/db-stub idiom: under
 * test `eq`/`and`/`or`/`lt` record `{ __op, args }`, so we can read the exact
 * predicate tree back and assert:
 *
 *   1. EVERY page WHERE is project-scoped — it ALWAYS ANDs `eq(runs.teamId, …)`
 *      AND `eq(runs.projectId, …)` (the `runScopeWhere` pair, via
 *      `scopedRunsWhere`). This is the security invariant: a project-A export can
 *      never read project-B rows.
 *   2. A different scope binds a different `projectId`/`teamId` (cross-tenant).
 *   3. The cursor tuple comparison is built from BOUND params (`lt`/`eq` args),
 *      never string-interpolated — no SQL-injection surface from `?cursor=`.
 */

type RecordedOp = { __op: string; args: readonly unknown[] };

/** Recursively flatten an `and(...)` / `or(...)` tree to its leaf recorded ops. */
function flatten(node: unknown): RecordedOp[] {
  if (typeof node !== "object" || node === null) return [];
  const op = node as RecordedOp;
  if ((op.__op === "and" || op.__op === "or") && Array.isArray(op.args)) {
    return op.args.flatMap((a) => flatten(a));
  }
  return [op];
}

function eqValueFor(node: unknown, column: string): unknown {
  for (const op of flatten(node)) {
    if (op.__op !== "eq") continue;
    const col = op.args[0] as { name?: unknown } | undefined;
    if (col?.name === column) return op.args[1];
  }
  return undefined;
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

describe("buildRunsPageWhere tenant scoping", () => {
  it("always binds BOTH teamId and projectId from the scope (no filters, no cursor)", () => {
    const where = buildRunsPageWhere(scope, EMPTY_FILTERS, null);
    expect(eqValueFor(where, "projectId")).toBe("proj_xyz");
    expect(eqValueFor(where, "teamId")).toBe("team_abc");
  });

  it("stays project-scoped with filters applied", () => {
    const where = buildRunsPageWhere(
      scope,
      { ...EMPTY_FILTERS, status: ["failed"], branch: ["main"] },
      null,
    );
    expect(eqValueFor(where, "projectId")).toBe("proj_xyz");
    expect(eqValueFor(where, "teamId")).toBe("team_abc");
  });

  it("stays project-scoped with a cursor applied", () => {
    const where = buildRunsPageWhere(scope, EMPTY_FILTERS, {
      createdAt: 1700000000,
      id: "run_123",
    });
    expect(eqValueFor(where, "projectId")).toBe("proj_xyz");
    expect(eqValueFor(where, "teamId")).toBe("team_abc");
  });

  it("binds a DIFFERENT projectId/teamId for a different scope (cross-tenant isolation)", () => {
    const where = buildRunsPageWhere(otherScope, EMPTY_FILTERS, null);
    expect(eqValueFor(where, "projectId")).toBe("proj_OTHER");
    expect(eqValueFor(where, "teamId")).toBe("team_def");
    // And never leaks the other scope's id.
    expect(eqValueFor(where, "projectId")).not.toBe("proj_xyz");
  });
});

describe("buildRunsPageWhere cursor (bound params, not interpolation)", () => {
  it("emits a strict (createdAt, id) tuple comparison from bound lt/eq args", () => {
    const where = buildRunsPageWhere(scope, EMPTY_FILTERS, {
      createdAt: 1700000000,
      id: "run_123",
    });
    const ops = flatten(where);
    // The createdAt-strict half: lt(runs.createdAt, 1700000000).
    const ltCreatedAt = ops.find(
      (op) =>
        op.__op === "lt" &&
        (op.args[0] as { name?: unknown })?.name === "createdAt",
    );
    expect(ltCreatedAt?.args[1]).toBe(1700000000);
    // The id tiebreak half: lt(runs.id, "run_123") — the cursor id is a BOUND
    // value, never spliced into SQL text.
    const ltId = ops.find(
      (op) =>
        op.__op === "lt" && (op.args[0] as { name?: unknown })?.name === "id",
    );
    expect(ltId?.args[1]).toBe("run_123");
  });

  it("omits the cursor tuple entirely when no cursor is given", () => {
    const where = buildRunsPageWhere(scope, EMPTY_FILTERS, null);
    const hasCursorLt = flatten(where).some(
      (op) =>
        op.__op === "lt" &&
        (op.args[0] as { name?: unknown })?.name === "createdAt",
    );
    expect(hasCursorLt).toBe(false);
  });
});
