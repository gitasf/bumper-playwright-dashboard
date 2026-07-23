import { describe, it, expect } from "vite-plus/test";
import { bucketExpr } from "@/lib/analytics/bucketing-sql";
import { buildRunsWhere, escapeLike } from "@/lib/runs/filters-where";
import { EMPTY_FILTERS, parseRunsFilters } from "@/lib/runs/filters";

/**
 * `escapeLike` hand-writes the LIKE-metacharacter escaping that the typed
 * `like()` operator can't express. A regression here would let a user's search
 * term (`50%`, `a_b`, a literal backslash) be interpreted as wildcards — wrong
 * results, invisible until someone searches with those characters.
 */
describe("escapeLike", () => {
  it("doubles each LIKE metacharacter with a leading backslash", () => {
    expect(escapeLike("%")).toBe("\\%");
    expect(escapeLike("_")).toBe("\\_");
    expect(escapeLike("\\")).toBe("\\\\");
  });

  it("escapes every occurrence, leaving ordinary characters untouched", () => {
    expect(escapeLike("50%_x")).toBe("50\\%\\_x");
    expect(escapeLike("a\\b%c_d")).toBe("a\\\\b\\%c\\_d");
    expect(escapeLike("plain text 123")).toBe("plain text 123");
    expect(escapeLike("")).toBe("");
  });
});

/**
 * `buildRunsWhere` wraps the escaped term in `%…%` and feeds it to three
 * `likeEscaped` fragments. Under the void/db stub, `sql\`…\`` records
 * `{ __op: "sql", strings, args }`, so we can read back both the bound pattern
 * AND the SQL text. The `ESCAPE '\'` clause is load-bearing: SQLite defines NO
 * default LIKE escape character, so without it the escaped pattern matches a
 * literal backslash instead of the metacharacter — i.e. searches containing
 * `%`/`_`/`\` silently return nothing.
 */
describe("buildRunsWhere search escaping", () => {
  type RecordedSql = {
    __op: string;
    strings?: readonly string[];
    args: readonly unknown[];
  };

  // A `likeEscaped` fragment is identified by its `ESCAPE '\'` clause (which
  // stays in the parent template's `.strings`). The LIKE/ILIKE operator itself
  // is now a SUB-fragment (`${likeOperator()}`) carried in `args`, not literal
  // template text — so detecting by `" like "` would miss it.
  function collectLikeFragments(node: unknown): RecordedSql[] {
    if (typeof node !== "object" || node === null) return [];
    const op = node as Partial<RecordedSql>;
    if (
      op.__op === "sql" &&
      Array.isArray(op.strings) &&
      op.strings.join("").includes("escape '\\'")
    ) {
      return [op as RecordedSql];
    }
    if (Array.isArray(op.args)) {
      return op.args.flatMap((arg) => collectLikeFragments(arg));
    }
    return [];
  }

  /** The bound pattern arg of a likeEscaped fragment (the lone string in args). */
  function boundPattern(fragment: RecordedSql): unknown {
    return fragment.args.find((a) => typeof a === "string");
  }

  it("wraps the escaped term in %…% for each searched column", () => {
    const where = buildRunsWhere({ ...EMPTY_FILTERS, q: "50%_x" });
    const fragments = collectLikeFragments(where);
    // commitMessage, commitSha, branch — three LIKE predicates, same bound pattern.
    expect(fragments).toHaveLength(3);
    for (const fragment of fragments) {
      expect(boundPattern(fragment)).toBe("%50\\%\\_x%");
    }
  });

  it("pairs every LIKE with an ESCAPE '\\' clause", () => {
    const where = buildRunsWhere({ ...EMPTY_FILTERS, q: "x" });
    const fragments = collectLikeFragments(where);
    expect(fragments).toHaveLength(3);
    for (const fragment of fragments) {
      expect((fragment.strings ?? []).join("")).toContain("escape '\\'");
    }
  });

  it("does not emit any LIKE predicate when the search term is empty", () => {
    const where = buildRunsWhere({ ...EMPTY_FILTERS, q: "" });
    expect(collectLikeFragments(where)).toEqual([]);
  });
});

/**
 * The `origin` filter is the synthetic-traffic boundary on the runs list: the
 * default (`ci`) must EXCLUDE monitor runs (a 1-minute monitor mints 1,440
 * runs/day that would drown the CI history), `synthetic` flips the view to
 * monitor traffic, and only an explicit `all` drops the clause.
 */
describe("buildRunsWhere origin filter", () => {
  type RecordedOp = { __op?: string; args?: readonly unknown[] };

  function collectEqOps(node: unknown): RecordedOp[] {
    if (typeof node !== "object" || node === null) return [];
    const op = node as RecordedOp;
    const self = op.__op === "eq" ? [op] : [];
    const nested = Array.isArray(op.args)
      ? op.args.flatMap((arg) => collectEqOps(arg))
      : [];
    return [...self, ...nested];
  }

  function originValues(node: unknown): unknown[] {
    return collectEqOps(node)
      .filter((op) => {
        const col = op.args?.[0] as { name?: string } | undefined;
        return col?.name === "origin";
      })
      .map((op) => op.args?.[1]);
  }

  it("excludes synthetic runs by default (origin=ci)", () => {
    expect(originValues(buildRunsWhere(EMPTY_FILTERS))).toEqual(["ci"]);
  });

  it("flips to synthetic-only when requested", () => {
    expect(
      originValues(buildRunsWhere({ ...EMPTY_FILTERS, origin: "synthetic" })),
    ).toEqual(["synthetic"]);
  });

  it("drops the clause entirely for origin=all", () => {
    expect(
      originValues(buildRunsWhere({ ...EMPTY_FILTERS, origin: "all" })),
    ).toEqual([]);
  });
});

/**
 * `bucketExpr` inlines its divisor as a SQL literal (not a bound parameter) to
 * dodge D1's text-affinity coercion of numeric params — a runtime property no
 * unit test can prove. What a test CAN pin is the structural precondition for
 * it: the divisor lives in the template string and is never a bound PRIMITIVE
 * arg. The bucketed column is interpolated as a nested `sql` fragment (the only
 * arg) so it renders as raw identifier text, not a param — so we assert no arg
 * is a primitive number/string. If someone "tidies" the divisor into an
 * interpolated `${86400}`, a numeric arg appears and this fails — flagging the
 * exact change that would reintroduce the param-affinity landmine.
 */
describe("bucketExpr literal inlining", () => {
  type SqlChunk = {
    __op: "sql";
    strings: readonly string[];
    args: readonly unknown[];
  };

  function asChunk(expr: unknown): SqlChunk {
    expect((expr as { __op?: unknown }).__op).toBe("sql");
    return expr as SqlChunk;
  }

  function expectNoBoundPrimitive(chunk: SqlChunk) {
    for (const a of chunk.args) {
      expect(typeof a).not.toBe("number");
      expect(typeof a).not.toBe("string");
    }
  }

  it("inlines the day divisor (86400) with no bound primitive", () => {
    const chunk = asChunk(bucketExpr("day"));
    expectNoBoundPrimitive(chunk);
    expect(chunk.strings.join("")).toContain("/ 86400");
  });

  it("inlines the week divisor (604800) with no bound primitive", () => {
    const chunk = asChunk(bucketExpr("week"));
    expectNoBoundPrimitive(chunk);
    expect(chunk.strings.join("")).toContain("/ 604800");
  });

  it("renders the month bucket via to_char with no bound primitive", () => {
    const chunk = asChunk(bucketExpr("month"));
    expectNoBoundPrimitive(chunk);
    expect(chunk.strings.join("")).toContain("to_char(to_timestamp(");
    expect(chunk.strings.join("")).toContain("AT TIME ZONE 'UTC', 'YYYY-MM')");
  });

  it('defaults the bucketed column to runs."createdAt"', () => {
    const chunk = asChunk(bucketExpr("day"));
    const col = chunk.args[0] as SqlChunk;
    expect(col.strings.join("")).toContain('runs."createdAt"');
  });
});

/**
 * `parseRunsFilters` date-range normalization. An inverted range (`from > to`)
 * would AND two mutually-exclusive bounds into an always-empty page — a silent
 * footgun on the public query/export API — so it is swapped to the intended
 * window. (roadmap 2.5 review)
 */
describe("parseRunsFilters date range", () => {
  it("swaps an inverted from/to into the intended window", () => {
    const f = parseRunsFilters(
      new URLSearchParams({ from: "2026-06-14", to: "2020-01-01" }),
    );
    expect(f.from).toBe("2020-01-01");
    expect(f.to).toBe("2026-06-14");
  });

  it("leaves a correctly-ordered range untouched", () => {
    const f = parseRunsFilters(
      new URLSearchParams({ from: "2020-01-01", to: "2026-06-14" }),
    );
    expect(f.from).toBe("2020-01-01");
    expect(f.to).toBe("2026-06-14");
  });

  it("ignores an invalid date and never swaps a one-sided range", () => {
    const f = parseRunsFilters(
      new URLSearchParams({ from: "2026-06-14", to: "not-a-date" }),
    );
    expect(f.from).toBe("2026-06-14");
    expect(f.to).toBeNull();
  });
});
