import { describe, expect, it } from "vite-plus/test";
import { and, eq } from "void/db";
import {
  artifacts,
  monitors,
  quarantinedTests,
  testResults,
  testTags,
} from "@schema";
import { EMPTY_FILTERS } from "@/lib/runs-filters";
import { scopedRunsWhere } from "@/lib/runs-filters-where";
import {
  childByIdWhere,
  childByRunWhere,
  childByTestIdWhere,
  childByTestResultWhere,
  childProjectScopeWhere,
  ciRunsScopeWhere,
  makeTenantScope,
  runByIdWhere,
  runScopeWhere,
  staleRunFilter,
  type TenantScope,
} from "@/lib/scope";

/**
 * `runScopeWhere` / `runByIdWhere` are the single owners of the tenant
 * predicate for the `runs` table — the shape ~10 readers/writers used to
 * hand-roll. Under the void/db stub, operators record their arguments
 * (`{ __op, args }`), so we can read back the EXACT predicate each helper
 * emits and pin the two invariants the finding is about:
 *
 *  1. `runScopeWhere` ANDs BOTH `teamId` AND `projectId` (the denormalized
 *     defense-in-depth pair), bound to the scope's auth-checked ids — not just
 *     one of them, and never a raw string.
 *  2. `runByIdWhere` ANDs `projectId` AND `id` (the run-by-id lookup shape),
 *     so a leaked run id can't be read outside its project.
 *
 * If a future edit drops a column (e.g. forgets `teamId`, or scopes a
 * by-id lookup on `id` alone) these tests fail — which is the whole point of
 * concentrating the predicate behind one seam.
 */

type RecordedOp = { __op: string; args: readonly unknown[] };
type RecordedColumn = { name?: unknown };

/** Read back `{ column, value }` from a recorded `eq(col, val)` op. */
function readEq(node: unknown): { column: string; value: unknown } {
  const op = node as RecordedOp;
  expect(op.__op).toBe("eq");
  const column = (op.args[0] as RecordedColumn)?.name;
  expect(typeof column).toBe("string");
  return { column: column as string, value: op.args[1] };
}

/** The `(column → value)` pairs ANDed together inside a recorded `and(...)`. */
function readAndPairs(node: unknown): Record<string, unknown> {
  const op = node as RecordedOp;
  expect(op.__op).toBe("and");
  const pairs: Record<string, unknown> = {};
  for (const child of op.args) {
    const { column, value } = readEq(child);
    pairs[column] = value;
  }
  return pairs;
}

const scope: TenantScope = {
  teamId: "team_abc" as TenantScope["teamId"],
  projectId: "proj_xyz" as TenantScope["projectId"],
  teamSlug: "acme",
  projectSlug: "web",
};

describe("runScopeWhere", () => {
  it("ANDs both teamId and projectId, bound to the scope ids", () => {
    const pairs = readAndPairs(runScopeWhere(scope));
    expect(pairs).toEqual({
      teamId: "team_abc",
      projectId: "proj_xyz",
    });
  });

  it("emits exactly two predicates (no extra, none dropped)", () => {
    const op = runScopeWhere(scope) as unknown as RecordedOp;
    expect(op.args).toHaveLength(2);
  });
});

/**
 * `ciRunsScopeWhere` = `runScopeWhere` + the CI-analytics policy clause
 * (`runs.origin <> 'synthetic'`). The Drizzle-side home for "this aggregate
 * reads CI history, not monitor traffic" — insights KPIs/buckets, suite-size
 * trend, branch filter options. Pinned separately from `runScopeWhere`, which
 * must NOT grow the clause: run-detail-by-id paths still see synthetic runs.
 */
describe("ciRunsScopeWhere", () => {
  it("ANDs the full runScopeWhere pair with the origin exclusion — exactly two children", () => {
    const op = ciRunsScopeWhere(scope) as unknown as RecordedOp;
    expect(op.__op).toBe("and");
    expect(op.args).toHaveLength(2);
    // First child IS the runScopeWhere predicate (teamId + projectId), so the
    // tenant boundary can't be weakened by the analytics variant.
    expect(readAndPairs(op.args[0])).toEqual({
      teamId: "team_abc",
      projectId: "proj_xyz",
    });
  });

  it("excludes synthetic monitor runs via ne(origin, 'synthetic') — not eq(origin, 'ci')", () => {
    // `ne` is load-bearing: a future origin value defaults to counting as
    // CI-like; only monitor traffic is carved out of the analytics surfaces.
    const op = ciRunsScopeWhere(scope) as unknown as RecordedOp;
    const neOp = op.args[1] as RecordedOp;
    expect(neOp.__op).toBe("ne");
    expect((neOp.args[0] as RecordedColumn)?.name).toBe("origin");
    expect(neOp.args[1]).toBe("synthetic");
  });

  it("leaves runScopeWhere itself untouched (no origin clause leaks into it)", () => {
    const op = runScopeWhere(scope) as unknown as RecordedOp;
    expect(op.args).toHaveLength(2);
    for (const child of op.args) {
      expect((child as RecordedOp).__op).toBe("eq");
    }
  });
});

describe("runByIdWhere", () => {
  it("ANDs projectId and the run id", () => {
    const pairs = readAndPairs(runByIdWhere(scope, "run_123"));
    expect(pairs).toEqual({
      projectId: "proj_xyz",
      id: "run_123",
    });
  });

  it("scopes by projectId (not teamId) plus the id — exactly two predicates", () => {
    const op = runByIdWhere(scope, "run_123") as unknown as RecordedOp;
    expect(op.args).toHaveLength(2);
    const pairs = readAndPairs(op);
    expect(Object.keys(pairs).sort()).toEqual(["id", "projectId"]);
  });
});

describe("scopedRunsWhere", () => {
  it("delegates the scope half to runScopeWhere (teamId + projectId)", () => {
    // EMPTY_FILTERS now carries the default origin=ci exclusion, so the
    // result is and(scopeClause, originClause) — the scope predicate is the
    // first child rather than the whole expression.
    const op = scopedRunsWhere(scope, EMPTY_FILTERS) as unknown as RecordedOp;
    expect(op.__op).toBe("and");
    expect(readAndPairs(op.args[0])).toEqual({
      teamId: "team_abc",
      projectId: "proj_xyz",
    });
  });

  it("applies the default synthetic-traffic exclusion even with no user filters", () => {
    const op = scopedRunsWhere(scope, EMPTY_FILTERS) as unknown as RecordedOp;
    expect(op.args).toHaveLength(2);
    expect(readEq(op.args[1])).toEqual({ column: "origin", value: "ci" });
  });

  it("collapses to the bare scope predicate when origin=all and nothing else filters", () => {
    // With every filter cleared INCLUDING origin, the result IS the scope
    // predicate — pinning that no phantom clause sneaks in.
    const pairs = readAndPairs(
      scopedRunsWhere(scope, { ...EMPTY_FILTERS, origin: "all" }),
    );
    expect(pairs).toEqual({
      teamId: "team_abc",
      projectId: "proj_xyz",
    });
  });

  it("ANDs the scope predicate with the filter clause when filters apply", () => {
    const op = scopedRunsWhere(scope, {
      ...EMPTY_FILTERS,
      status: ["passed"],
    }) as unknown as RecordedOp;
    // and(scopeClause, filterClause): two children, the first being the
    // teamId+projectId scope predicate.
    expect(op.__op).toBe("and");
    expect(op.args).toHaveLength(2);
    expect(readAndPairs(op.args[0])).toEqual({
      teamId: "team_abc",
      projectId: "proj_xyz",
    });
  });
});

/**
 * `makeTenantScope` is the single point where raw `teamId` / `projectId`
 * strings cross the brand boundary into a `TenantScope`. The three scope
 * producers (`tenantScopeForUserBySlugs`, `tenantScopeForApiKey`, `toScope`)
 * each used to inline this `{ teamId, projectId, teamSlug, projectSlug } →
 * TenantScope` projection with their own pair of `as Authorized*Id` casts;
 * now they all funnel through this factory. These tests pin the projection so
 * a future edit can't silently transpose a field (e.g. write the project id
 * into `teamId`) or drop one.
 */
describe("makeTenantScope", () => {
  it("maps each raw id/slug to the matching TenantScope field", () => {
    const result = makeTenantScope({
      teamId: "team_abc",
      projectId: "proj_xyz",
      teamSlug: "acme",
      projectSlug: "web",
    });
    expect(result).toEqual({
      teamId: "team_abc",
      projectId: "proj_xyz",
      teamSlug: "acme",
      projectSlug: "web",
    });
  });

  it("does not transpose teamId and projectId", () => {
    // Distinct values so a swapped projection would fail this assertion.
    const result = makeTenantScope({
      teamId: "T",
      projectId: "P",
      teamSlug: "ts",
      projectSlug: "ps",
    });
    expect(result.teamId).toBe("T");
    expect(result.projectId).toBe("P");
    expect(result.teamSlug).toBe("ts");
    expect(result.projectSlug).toBe("ps");
  });

  it("produces a scope usable by the run-table predicate helpers", () => {
    // The brand-laundered ids flow straight into the blessed predicate without
    // any further cast — proving the factory output is a real TenantScope.
    const result = makeTenantScope({
      teamId: "team_abc",
      projectId: "proj_xyz",
      teamSlug: "acme",
      projectSlug: "web",
    });
    expect(readAndPairs(runScopeWhere(result))).toEqual({
      teamId: "team_abc",
      projectId: "proj_xyz",
    });
  });
});

/**
 * `staleRunFilter` is the single definition of "this run is stuck" for the cron
 * watchdog (and any future admin force-complete / "stalled?" badge). The whole
 * point of the finding is that this predicate keys off the `lastActivityAt`
 * LIVENESS signal — not `createdAt` — so an actively-streaming long suite is no
 * longer force-flipped to 'interrupted'. These tests pin that shape so a future
 * edit can't silently revert to `lt(createdAt)` (which would re-introduce the
 * false positive) or forget the `status = 'running'` guard (which would let it
 * "finalize" already-terminal runs).
 *
 * Operators record their arguments under the `void/db` stub, so we read back
 * the exact predicate the helper emits.
 */
describe("staleRunFilter", () => {
  /** The `eq`/`lt` children of the top-level `and(...)`, by operator name. */
  function readStaleChildren(node: unknown) {
    const op = node as RecordedOp;
    expect(op.__op).toBe("and");
    const byOp: Record<string, RecordedOp> = {};
    for (const child of op.args) {
      const c = child as RecordedOp;
      byOp[c.__op] = c;
    }
    return byOp;
  }

  it("guards on status = 'running' so it can't finalize already-terminal runs", () => {
    const children = readStaleChildren(staleRunFilter(1000));
    expect(children.eq).toBeDefined();
    const { column, value } = readEq(children.eq);
    expect(column).toBe("status");
    expect(value).toBe("running");
  });

  it("compares the lastActivityAt liveness signal (not createdAt) against the cutoff", () => {
    const cutoff = 1_700_000_000;
    const children = readStaleChildren(staleRunFilter(cutoff));
    // The temporal half is `lt(lastActivityAt, cutoff)` — the column directly,
    // NOT createdAt, and no `coalesce` fallback (the column is now NOT NULL, so
    // every writer sets it; see schema-rework-plan Phase 4).
    expect(children.lt).toBeDefined();
    const [lhs, rhs] = children.lt.args;
    expect(rhs).toBe(cutoff);
    // The left operand is the lastActivityAt column itself (not a coalesce SQL
    // fragment, and never createdAt).
    expect((lhs as { name?: unknown })?.name).toBe("lastActivityAt");
  });

  it("ANDs exactly two predicates — the status guard and the staleness compare", () => {
    const op = staleRunFilter(0) as unknown as RecordedOp;
    expect(op.__op).toBe("and");
    expect(op.args).toHaveLength(2);
  });
});

/**
 * The child-table predicate family — the run-scoped CHILD tables
 * (`testResults`, `testResultAttempts`, `testTags`, `testAnnotations`,
 * `artifacts`, plus `monitors` / `monitorExecutions` / `quarantinedTests`)
 * carry a denormalized `projectId` precisely so scope is enforced WITHOUT
 * joining through `runs`. These predicates are the single home of "scope a
 * child by its own `projectId` (+ id), never by joining through runs" — the
 * most security-load-bearing shape in the tenancy model, previously hand-rolled
 * at ~two dozen sites and re-cloned privately (`quarantineByTestIdWhere`,
 * `monitorByIdWhere`).
 *
 * Each test pins (a) the predicate binds `projectId` off the BRANDED scope (not
 * a raw string) and (b) the EXACT shape — column count + the id column — so a
 * future edit can't drop the project filter (cross-tenant read) or scope on the
 * id alone. The void/db stub records the real schema column, so `col.name`
 * reads back the physical column name.
 */
describe("childProjectScopeWhere", () => {
  it("binds projectId off the branded scope (single-column scope)", () => {
    const { column, value } = readEq(
      childProjectScopeWhere(testTags.projectId, scope),
    );
    expect(column).toBe("projectId");
    expect(value).toBe("proj_xyz");
  });

  it("is just the bare eq — no extra AND wrapping", () => {
    const op = childProjectScopeWhere(
      testTags.projectId,
      scope,
    ) as unknown as RecordedOp;
    expect(op.__op).toBe("eq");
  });

  /**
   * The single-column member is adopted at composite sites that AND it with
   * sibling clauses no family member covers (the `(projectId, runId, status∈…)`
   * preview, the `(projectId, runId, testId∈…)` id-resolve, the 4-clause
   * test-detail summary). Routing only the projectId sub-clause must emit a
   * predicate byte-identical to the hand-rolled `eq(projectId, scope.projectId)`
   * it replaces — so the outer `and(...)` is unchanged. This pins that the
   * routed clause is exactly the same recorded `eq` the inline form produced,
   * guarding the adoption as behaviour-preserving.
   */
  it("inside an outer and(...) is identical to the hand-rolled projectId eq", () => {
    const routed = and(
      childProjectScopeWhere(testResults.projectId, scope),
      eq(testResults.runId, "run_123"),
    ) as unknown as RecordedOp;
    const inline = and(
      eq(testResults.projectId, scope.projectId),
      eq(testResults.runId, "run_123"),
    ) as unknown as RecordedOp;
    // Same top-level op, same arity.
    expect(routed.__op).toBe("and");
    expect(routed.args).toHaveLength(inline.args.length);
    // First child (the routed scope clause) matches the inline projectId eq
    // column-for-value; the sibling runId clause is untouched.
    expect(readEq(routed.args[0])).toEqual(readEq(inline.args[0]));
    expect(readEq(routed.args[1])).toEqual(readEq(inline.args[1]));
  });
});

describe("childByTestResultWhere", () => {
  it("ANDs projectId and testResultId, both bound off the scope/id", () => {
    const pairs = readAndPairs(
      childByTestResultWhere(artifacts, scope, "tr_123"),
    );
    expect(pairs).toEqual({
      projectId: "proj_xyz",
      testResultId: "tr_123",
    });
  });

  it("scopes by projectId plus testResultId — exactly two predicates", () => {
    const op = childByTestResultWhere(
      artifacts,
      scope,
      "tr_123",
    ) as unknown as RecordedOp;
    expect(op.args).toHaveLength(2);
    expect(Object.keys(readAndPairs(op)).sort()).toEqual([
      "projectId",
      "testResultId",
    ]);
  });
});

describe("childByRunWhere", () => {
  it("ANDs projectId and runId, both bound off the scope/id", () => {
    const pairs = readAndPairs(childByRunWhere(testResults, scope, "run_123"));
    expect(pairs).toEqual({
      projectId: "proj_xyz",
      runId: "run_123",
    });
  });

  it("scopes by projectId plus runId — exactly two predicates", () => {
    const op = childByRunWhere(
      testResults,
      scope,
      "run_123",
    ) as unknown as RecordedOp;
    expect(op.args).toHaveLength(2);
    expect(Object.keys(readAndPairs(op)).sort()).toEqual([
      "projectId",
      "runId",
    ]);
  });
});

describe("childByTestIdWhere", () => {
  it("ANDs projectId and the stable testId (folds quarantineByTestIdWhere)", () => {
    const pairs = readAndPairs(
      childByTestIdWhere(quarantinedTests, scope, "test::spec::a"),
    );
    expect(pairs).toEqual({
      projectId: "proj_xyz",
      testId: "test::spec::a",
    });
  });

  it("scopes by projectId plus testId — exactly two predicates", () => {
    const op = childByTestIdWhere(
      quarantinedTests,
      scope,
      "test::spec::a",
    ) as unknown as RecordedOp;
    expect(op.args).toHaveLength(2);
  });
});

describe("childByIdWhere", () => {
  it("ANDs projectId and the row id (folds monitorByIdWhere)", () => {
    const pairs = readAndPairs(childByIdWhere(monitors, scope, "mon_123"));
    expect(pairs).toEqual({
      projectId: "proj_xyz",
      id: "mon_123",
    });
  });

  it("scopes by projectId (not teamId) plus the id — exactly two predicates", () => {
    const op = childByIdWhere(
      monitors,
      scope,
      "mon_123",
    ) as unknown as RecordedOp;
    expect(op.args).toHaveLength(2);
    expect(Object.keys(readAndPairs(op)).sort()).toEqual(["id", "projectId"]);
  });
});
