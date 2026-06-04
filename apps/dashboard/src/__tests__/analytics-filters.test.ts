import { describe, expect, it } from "vite-plus/test";
import {
  branchFragment,
  branchJoinFragment,
  searchFragment,
  testResultsScopeJoin,
} from "@/lib/analytics/filters";
import { makeTenantScope } from "@/lib/scope";

/**
 * `branchFragment` / `branchJoinFragment` / `searchFragment` are the single home
 * for the raw-SQL filter ternaries the analytics loaders (tests / slowest-tests
 * / run-duration / flaky) used to copy-paste inline. The two invariants worth
 * pinning:
 *
 *  1. A `null` filter collapses to an EMPTY fragment so it drops out of the
 *     surrounding `where … ${fragment}` — the "all branches" / no-search case.
 *  2. A real value is carried as a BOUND parameter (`sql\`${value}\``), never
 *     interpolated into the query string — the injection-safety guarantee.
 *
 * Under the void/db stub, `sql\`…\`` records `{ __op: "sql", strings, args }`,
 * so we can read both the literal chunks and the bound params straight back.
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

describe("branchJoinFragment", () => {
  it("is empty for a null branch (no runs join needed)", () => {
    expect(isEmptyFragment(branchJoinFragment(null))).toBe(true);
  });

  it("emits the inner join for a real branch", () => {
    const op = readSql(branchJoinFragment("main"));
    expect(op.strings.join("")).toBe('inner join runs on runs.id = tr."runId"');
    expect(op.args).toEqual([]);
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
    // The join + leading `where tr."projectId" =` the loaders all open with.
    expect(text).toBe(
      'inner join runs on runs.id = tr."runId" where tr."projectId" =',
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

  it("emits a title-or-file LIKE predicate for a real query", () => {
    const op = readSql(searchFragment("login"));
    expect(op.strings.join("").replace(/\s+/g, " ").trim()).toBe(
      "and (tr.title like or tr.file like )",
    );
  });

  it("wraps the term in %…% and binds it twice (title + file), never interpolating", () => {
    const op = readSql(searchFragment("50%"));
    // Same %-wrapped pattern is bound for both the title and file comparison.
    expect(op.args).toEqual(["%50%%", "%50%%"]);
    expect(op.strings.join("")).not.toContain("50%");
  });
});
