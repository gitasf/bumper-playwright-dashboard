import { describe, expect, it } from "vite-plus/test";
import { buildRunsWhere } from "@/lib/runs/filters-where";
import {
  EMPTY_FILTERS,
  hasAnyFilter,
  parseRunsFilters,
  toSearchParams,
} from "@/lib/runs/filters";

/**
 * The `pr` / `commit` run filters (added for the MCP + public query API's
 * "failing tests on PR #123 / commit abc1234" lookups). Parse rules and the
 * WHERE fragments they compile to, under the void/db stub (each drizzle
 * operator records `{ __op, args }`, `sql\`…\`` records `{ strings, args }`).
 */

function params(q: string): URLSearchParams {
  return new URLSearchParams(q);
}

describe("parseRunsFilters pr", () => {
  it("parses a positive integer, with or without a leading '#'", () => {
    expect(parseRunsFilters(params("pr=123")).pr).toBe(123);
    expect(parseRunsFilters(params("pr=%23123")).pr).toBe(123);
  });

  it("rejects garbage, zero, and negatives as no-filter", () => {
    expect(parseRunsFilters(params("pr=abc")).pr).toBeNull();
    expect(parseRunsFilters(params("pr=0")).pr).toBeNull();
    expect(parseRunsFilters(params("pr=-4")).pr).toBeNull();
    expect(parseRunsFilters(params("")).pr).toBeNull();
  });
});

describe("parseRunsFilters commit", () => {
  it("accepts a 4–40 char hex prefix (either case), trimmed", () => {
    expect(parseRunsFilters(params("commit=abc1")).commit).toBe("abc1");
    expect(parseRunsFilters(params("commit=ABC123f")).commit).toBe("ABC123f");
    expect(parseRunsFilters(params(`commit=${"a".repeat(40)}`)).commit).toBe(
      "a".repeat(40),
    );
  });

  it("rejects non-hex, too-short, and too-long values as no-filter", () => {
    expect(parseRunsFilters(params("commit=xyz")).commit).toBeNull();
    expect(parseRunsFilters(params("commit=ab")).commit).toBeNull();
    expect(
      parseRunsFilters(params(`commit=${"a".repeat(41)}`)).commit,
    ).toBeNull();
    // LIKE metacharacters must never reach the WHERE builder via this filter.
    expect(parseRunsFilters(params("commit=abc%25")).commit).toBeNull();
  });
});

describe("pr/commit round-trip + hasAnyFilter", () => {
  it("survives toSearchParams → parseRunsFilters", () => {
    const filters = {
      ...EMPTY_FILTERS,
      pr: 42,
      commit: "deadbeef",
    };
    const roundTripped = parseRunsFilters(toSearchParams(filters));
    expect(roundTripped.pr).toBe(42);
    expect(roundTripped.commit).toBe("deadbeef");
  });

  it("counts as an active filter", () => {
    expect(hasAnyFilter({ ...EMPTY_FILTERS, pr: 1 })).toBe(true);
    expect(hasAnyFilter({ ...EMPTY_FILTERS, commit: "abcd" })).toBe(true);
    expect(hasAnyFilter(EMPTY_FILTERS)).toBe(false);
  });
});

type RecordedOp = { __op: string; args: readonly unknown[] };
type RecordedSql = {
  __op: string;
  strings?: readonly string[];
  args: readonly unknown[];
};

function flatten(node: unknown): RecordedOp[] {
  if (typeof node !== "object" || node === null) return [];
  const op = node as RecordedOp;
  if ((op.__op === "and" || op.__op === "or") && Array.isArray(op.args)) {
    return op.args.flatMap((a) => flatten(a));
  }
  return [op];
}

describe("buildRunsWhere pr/commit clauses", () => {
  it("binds pr as an eq(prNumber) param", () => {
    const where = buildRunsWhere({ ...EMPTY_FILTERS, pr: 123 });
    const eqOps = flatten(where).filter((op) => op.__op === "eq");
    const prClause = eqOps.find(
      (op) => (op.args[0] as { name?: string })?.name === "prNumber",
    );
    expect(prClause?.args[1]).toBe(123);
  });

  it("compiles commit to a PREFIX ilike (sha%, no leading wildcard) with ESCAPE", () => {
    const where = buildRunsWhere({ ...EMPTY_FILTERS, commit: "abc123" });
    const sqlOps = flatten(where).filter(
      (op) => op.__op === "sql",
    ) as RecordedSql[];
    const commitClause = sqlOps.find((op) =>
      op.args.some((a) => a === "abc123%"),
    );
    expect(commitClause, "expected a bound 'abc123%' pattern").toBeTruthy();
    const text = commitClause?.strings?.join("?") ?? "";
    expect(text).toContain("ilike");
    expect(text).toContain("escape");
  });

  it("emits NO pr/commit clause when both are null", () => {
    const where = buildRunsWhere({ ...EMPTY_FILTERS, origin: "all" });
    expect(where).toBeUndefined();
  });
});
