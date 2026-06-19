import { describe, expect, it } from "vite-plus/test";
import {
  branchFragment,
  ciRunsJoinFragment,
  ciRunsJoinOn,
  ciRunsScopeRawWhere,
  searchFragment,
  tagFragment,
  testResultsScopeJoin,
} from "@/lib/analytics/filters";
import { makeTenantScope } from "@/lib/scope";

/**
 * `branchFragment` / `ciRunsJoinFragment` / `searchFragment` are the single
 * home for the raw-SQL filter fragments the analytics loaders (tests /
 * slowest-tests / run-duration / flaky) used to copy-paste inline. The
 * invariants worth pinning:
 *
 *  1. A `null` filter collapses to an EMPTY fragment so it drops out of the
 *     surrounding `where … ${fragment}` — the "all branches" / no-search case.
 *  2. A real value is carried as a BOUND parameter (`sql\`${value}\``), never
 *     interpolated into the query string — the injection-safety guarantee.
 *  3. Every testResults→runs join carries the `runs.origin <> 'synthetic'`
 *     exclusion, so monitor traffic can't leak into a CI-analytics aggregate.
 *
 * Under the void/db stub, `sql\`…\`` records `{ __op: "sql", strings, args }`
 * and operators record `{ __op, args }`, so we can read both the literal
 * chunks and the bound params straight back.
 */

type RecordedSql = {
  __op: "sql";
  strings: readonly string[];
  args: readonly unknown[];
};

function readSql(node: unknown): RecordedSql {
  const op = node as RecordedSql;
  expect(op.__op).toBe("sql");
  return op;
}

/**
 * Reconstruct the SQL text from the stub's recorded fragments, inlining nested
 * `sql`/`sql.raw` fragments (e.g. the dialect-aware `likeOperator()`) and
 * rendering bound params as `?`. Needed because `searchFragment` now carries the
 * LIKE/ILIKE operator as a SUB-fragment, so it no longer sits in the parent
 * template's `.strings` — reading `.strings` alone would miss it.
 */
function renderSql(node: unknown): string {
  if (
    node &&
    typeof node === "object" &&
    (node as RecordedSql).__op === "sql"
  ) {
    const { strings, args } = node as {
      strings: readonly string[] | string;
      args: readonly unknown[];
    };
    if (typeof strings === "string") return strings; // sql.raw(...)
    return strings
      .map((s, i) => s + (i < args.length ? renderSql(args[i]) : ""))
      .join("");
  }
  return "?"; // bound parameter
}

/** A fragment is "empty" when it contributes no literal text and no params. */
function isEmptyFragment(node: unknown): boolean {
  const op = readSql(node);
  return op.args.length === 0 && op.strings.join("") === "";
}

describe("branchFragment", () => {
  it("is empty for a null branch (the all-branches case)", () => {
    expect(isEmptyFragment(branchFragment(null))).toBe(true);
  });

  it("emits an `and runs.branch = ?` predicate for a real branch", () => {
    const op = readSql(branchFragment("main"));
    expect(op.strings.join("").trim()).toBe("and runs.branch =");
  });

  it("binds the branch as a parameter, never interpolating it", () => {
    const op = readSql(branchFragment("feature/x"));
    // The branch value lives in `args`, not in the literal SQL text.
    expect(op.args).toEqual(["feature/x"]);
    expect(op.strings.join("")).not.toContain("feature/x");
  });
});

describe("ciRunsJoinFragment", () => {
  it("always emits the runs join with the synthetic exclusion in the ON clause", () => {
    // No branch parameter, no conditionality: the old branchJoinFragment only
    // joined `runs` when a branch filter was active, which let monitor-run
    // results through every no-branch analytics pass (flaky sparklines,
    // suite-size tests-added). The join is now load-bearing for correctness.
    const op = readSql(ciRunsJoinFragment());
    expect(op.strings.join("")).toBe(
      `inner join runs on runs.id = tr."runId" and runs.origin <> 'synthetic'`,
    );
    expect(op.args).toEqual([]);
  });

  it("emits the exact join testResultsScopeJoin opens with, so the policy can't drift", () => {
    const scope = makeTenantScope({
      teamId: "team_01",
      projectId: "proj_42",
      teamSlug: "acme",
      projectSlug: "web",
    });
    const join = readSql(ciRunsJoinFragment()).strings.join("");
    const scoped = readSql(testResultsScopeJoin(scope))
      .strings.join("")
      .replace(/\s+/g, " ");
    expect(scoped.startsWith(join)).toBe(true);
  });
});

describe("ciRunsScopeRawWhere", () => {
  it("binds BOTH the projectId AND the teamId (the team half run-duration used to drop)", () => {
    const scope = makeTenantScope({
      teamId: "team_01",
      projectId: "proj_42",
      teamSlug: "acme",
      projectSlug: "web",
    });
    const op = readSql(ciRunsScopeRawWhere(scope));
    // Both tenant ids ride as bound params — never interpolated into the text.
    expect(op.args).toEqual(["proj_42", "team_01"]);
    const text = op.strings.join("");
    expect(text).not.toContain("proj_42");
    expect(text).not.toContain("team_01");
  });

  it("scopes by projectId AND teamId and excludes synthetic monitor traffic", () => {
    const scope = makeTenantScope({
      teamId: "team_01",
      projectId: "proj_42",
      teamSlug: "acme",
      projectSlug: "web",
    });
    const text = readSql(ciRunsScopeRawWhere(scope)).strings.join("");
    expect(text).toContain(`runs."projectId" =`);
    expect(text).toContain(`runs."teamId" =`);
    expect(text).toContain(`runs.origin <> 'synthetic'`);
    expect(text.trimStart().startsWith("where")).toBe(true);
  });
});

describe("ciRunsJoinOn", () => {
  type RecordedOp = { __op: string; args: readonly unknown[] };
  const colName = (node: unknown) => (node as { name?: unknown })?.name;

  it("ANDs the runId equality with the synthetic-origin exclusion", () => {
    // The Drizzle twin of ciRunsJoinFragment, for `.innerJoin(runs, …)` query
    // builders (flaky ranking aggregate, suite-size file/tag distributions).
    const op = ciRunsJoinOn() as unknown as RecordedOp;
    expect(op.__op).toBe("and");
    expect(op.args).toHaveLength(2);

    const [eqOp, neOp] = op.args as RecordedOp[];
    expect(eqOp.__op).toBe("eq");
    expect(colName(eqOp.args[0])).toBe("id");
    expect(colName(eqOp.args[1])).toBe("runId");

    expect(neOp.__op).toBe("ne");
    expect(colName(neOp.args[0])).toBe("origin");
    expect(neOp.args[1]).toBe("synthetic");
  });
});

describe("testResultsScopeJoin", () => {
  const scope = makeTenantScope({
    teamId: "team_01",
    projectId: "proj_42",
    teamSlug: "acme",
    projectSlug: "web",
  });

  it("emits the testResults→runs join plus the tenant WHERE clause", () => {
    const op = readSql(testResultsScopeJoin(scope));
    const text = op.strings.join("").replace(/\s+/g, " ").trim();
    // The join (with the synthetic-traffic exclusion baked into its ON clause,
    // so every analytics surface inherits it) + the leading
    // `where tr."projectId" =` the loaders all open with.
    expect(text).toBe(
      `inner join runs on runs.id = tr."runId" and runs.origin <> 'synthetic' where tr."projectId" =`,
    );
  });

  it("binds the auth-checked projectId as a parameter, never interpolating it", () => {
    const op = readSql(testResultsScopeJoin(scope));
    // The tenant boundary lives in `args` (a bound param), not the SQL text —
    // injection-safe, and the single source of the cross-tenant predicate.
    expect(op.args).toEqual(["proj_42"]);
    expect(op.strings.join("")).not.toContain("proj_42");
  });

  it("scopes by projectId only — never leaks teamId into the predicate", () => {
    // The named scope-join filters `testResults` by projectId (testResults has
    // no teamId column); the teamId on the branded scope must not appear.
    const op = readSql(testResultsScopeJoin(scope));
    expect(op.args).not.toContain("team_01");
    expect(op.strings.join("")).not.toContain("teamId");
  });
});

describe("searchFragment", () => {
  it("is empty for a null query", () => {
    expect(isEmptyFragment(searchFragment(null))).toBe(true);
  });

  it("is empty for an empty-string query", () => {
    expect(isEmptyFragment(searchFragment(""))).toBe(true);
  });

  it("emits a title-or-file ILIKE predicate with an ESCAPE clause", () => {
    // The ESCAPE '\' clause is load-bearing: without it the escaped pattern
    // below matches nothing. On Postgres the search is case-insensitive, so the
    // fragment renders `ilike`.
    expect(renderSql(searchFragment("login")).replace(/\s+/g, " ").trim()).toBe(
      "and (tr.title ilike ? escape '\\' or tr.file ilike ? escape '\\')",
    );
  });

  it("escapes ILIKE metacharacters, wraps in %…%, and binds twice (title + file)", () => {
    const op = readSql(searchFragment("50%"));
    // Same escaped, %-wrapped pattern is bound for both comparisons — `%` in
    // the user's term matches literally (same semantics as the runs search).
    // The operator sub-fragments are also in `args`, so filter to the bound
    // string params.
    const bound = op.args.filter((a) => typeof a === "string");
    expect(bound).toEqual(["%50\\%%", "%50\\%%"]);
    expect(renderSql(op)).not.toContain("50%");
  });
});

describe("tagFragment", () => {
  it("is empty for an empty tag list (the no-tag-filter case)", () => {
    expect(isEmptyFragment(tagFragment([]))).toBe(true);
  });

  it("emits an EXISTS correlated subquery against testTags on tr.id", () => {
    const op = readSql(tagFragment(["smoke"]));
    const text = op.strings.join("").replace(/\s+/g, " ").trim();
    expect(text).toContain(
      `and exists (select 1 from "testTags" tt where tt."testResultId" = tr.id and tt.tag in (`,
    );
  });

  it("binds every tag as a parameter, never interpolating it", () => {
    const op = readSql(tagFragment(["smoke", "slow"]));
    // The IN list is a `sql.join` node whose chunks each carry one bound tag.
    const join = op.args[0] as { __op: string; chunks: unknown[] };
    expect(join.__op).toBe("sql.join");
    const tagValues = join.chunks.map((c) => readSql(c).args[0]);
    expect(tagValues).toEqual(["smoke", "slow"]);
    // No tag value leaks into the literal SQL text — injection-safe.
    expect(op.strings.join("")).not.toContain("smoke");
    expect(op.strings.join("")).not.toContain("slow");
  });
});
