import { describe, it, expect } from "vite-plus/test";
import { bucketExpr } from "@/lib/analytics/bucketing-sql";
import { buildRunsWhere, escapeLike } from "@/lib/runs-filters-where";
import { EMPTY_FILTERS } from "@/lib/runs-filters";

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
 * `like()` calls. Under the void/db stub, operators record their arguments
 * (`{ __op, args }`), so we can read back the exact pattern string the search
 * filter binds and assert the escaping survives into the predicate.
 */
describe("buildRunsWhere search escaping", () => {
  type RecordedOp = { __op: string; args: readonly unknown[] };

  function collectLikePatterns(node: unknown): string[] {
    if (typeof node !== "object" || node === null) return [];
    const op = node as Partial<RecordedOp>;
    if (op.__op === "like" && Array.isArray(op.args)) {
      const pattern = op.args[1];
      return typeof pattern === "string" ? [pattern] : [];
    }
    if (Array.isArray(op.args)) {
      return op.args.flatMap((arg) => collectLikePatterns(arg));
    }
    return [];
  }

  it("wraps the escaped term in %…% for each searched column", () => {
    const where = buildRunsWhere({ ...EMPTY_FILTERS, q: "50%_x" });
    const patterns = collectLikePatterns(where);
    // commitMessage, commitSha, branch — three LIKE predicates, same pattern.
    expect(patterns).toHaveLength(3);
    for (const pattern of patterns) {
      expect(pattern).toBe("%50\\%\\_x%");
    }
  });

  it("does not emit any LIKE predicate when the search term is empty", () => {
    const where = buildRunsWhere({ ...EMPTY_FILTERS, q: "" });
    expect(collectLikePatterns(where)).toEqual([]);
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

  it("renders the month bucket via strftime with no bound primitive", () => {
    const chunk = asChunk(bucketExpr("month"));
    expectNoBoundPrimitive(chunk);
    expect(chunk.strings.join("")).toContain("strftime('%Y-%m'");
  });

  it('defaults the bucketed column to runs."createdAt"', () => {
    const chunk = asChunk(bucketExpr("day"));
    const col = chunk.args[0] as SqlChunk;
    expect(col.strings.join("")).toContain('runs."createdAt"');
  });
});
