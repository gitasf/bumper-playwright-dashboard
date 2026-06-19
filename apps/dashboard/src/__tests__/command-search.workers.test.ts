import { describe, expect, it } from "vite-plus/test";
import {
  buildRecentRunsWhere,
  buildTestSearchWhere,
} from "@/lib/command-search";
import type { TenantScope } from "@/lib/scope";

/**
 * The ⌘K command-menu search (roadmap 4.1c) is project-scoped on the server.
 * These tests pin the security invariant the route's doc-comment promises:
 * EVERY query filters by the scope's projectId, and the test-title/file search
 * runs the term through `escapeLike` (so a `%`/`_`/`\` in a search can't act as
 * a LIKE wildcard). Mirrors `runs-filters-where.test.ts`'s recorded-op idiom —
 * the `void/db` operators return inspectable `{ __op, args }` placeholders.
 */

type RecordedOp = {
  __op?: string;
  args?: readonly unknown[];
  strings?: readonly string[];
};

/** Recursively collect every `eq(...)` leaf in a recorded predicate tree. */
function collectEqOps(node: unknown): RecordedOp[] {
  if (typeof node !== "object" || node === null) return [];
  const op = node as RecordedOp;
  const self = op.__op === "eq" ? [op] : [];
  const nested = Array.isArray(op.args)
    ? op.args.flatMap((a) => collectEqOps(a))
    : [];
  return [...self, ...nested];
}

/**
 * Recursively collect every `likeEscaped` fragment, identified by its
 * `ESCAPE '\'` clause. The LIKE/ILIKE operator is now a dialect-aware
 * SUB-fragment (`${likeOperator()}`) in `args`, not literal `" like "` text in
 * `.strings` — so detect by the escape clause, which stays in `.strings`.
 */
function collectLikeFragments(node: unknown): RecordedOp[] {
  if (typeof node !== "object" || node === null) return [];
  const op = node as RecordedOp;
  if (
    op.__op === "sql" &&
    Array.isArray(op.strings) &&
    op.strings.join("").includes("escape '\\'")
  ) {
    return [op];
  }
  return Array.isArray(op.args)
    ? op.args.flatMap((a) => collectLikeFragments(a))
    : [];
}

/** The bound pattern arg of a likeEscaped fragment (the lone string in args). */
function boundPattern(fragment: RecordedOp): unknown {
  return fragment.args?.find((a) => typeof a === "string");
}

function readEq(op: RecordedOp): { column: unknown; value: unknown } {
  const column = (op.args?.[0] as { name?: unknown })?.name;
  return { column, value: op.args?.[1] };
}

function projectIdValue(node: unknown): unknown {
  const eq = collectEqOps(node).find((op) => readEq(op).column === "projectId");
  expect(eq).toBeDefined();
  return eq ? readEq(eq).value : undefined;
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

describe("buildRecentRunsWhere", () => {
  it("scopes recent runs by the scope's projectId", () => {
    expect(projectIdValue(buildRecentRunsWhere(scope))).toBe("proj_xyz");
  });

  it("a different scope binds a different projectId (cross-tenant isolation)", () => {
    expect(projectIdValue(buildRecentRunsWhere(otherScope))).toBe("proj_OTHER");
  });
});

describe("buildTestSearchWhere", () => {
  it("a blank query yields the projectId scope alone (no LIKE)", () => {
    const where = buildTestSearchWhere(scope, "");
    expect(projectIdValue(where)).toBe("proj_xyz");
    expect(collectLikeFragments(where)).toEqual([]);
  });

  it("a whitespace-only query is treated as blank", () => {
    expect(collectLikeFragments(buildTestSearchWhere(scope, "   "))).toEqual(
      [],
    );
  });

  it("ANDs projectId with an escaped LIKE on title + file", () => {
    // `%` is a LIKE metacharacter — escapeLike must escape it so it matches
    // literally, not as a wildcard.
    const where = buildTestSearchWhere(scope, "a%b");
    expect(projectIdValue(where)).toBe("proj_xyz");

    const likes = collectLikeFragments(where);
    expect(likes).toHaveLength(2); // title + file
    for (const fragment of likes) {
      // Wrapped in %…% with the inner `%` escaped to `\%`.
      expect(boundPattern(fragment)).toBe("%a\\%b%");
      // ESCAPE '\' clause is load-bearing — without it the escape is inert.
      expect((fragment.strings ?? []).join("")).toContain("escape '\\'");
    }
  });

  it("a different scope binds a different projectId on the search", () => {
    expect(projectIdValue(buildTestSearchWhere(otherScope, "x"))).toBe(
      "proj_OTHER",
    );
  });
});
