import { describe, expect, it } from "vite-plus/test";
import { buildTagComment, renderSqlCommenter } from "@/lib/db/query-tags";

/**
 * The SQLCommenter renderer is pure (no `void/db` / `void/env` imports) so it
 * unit-tests directly. These pin the serialization contract PlanetScale Query
 * Insights reads: deterministic key order, percent-encoding that can't break the
 * comment out of its own syntax, and the opt-in baseline the raw-SQL boundary
 * (`runRows`/`runRow`) appends.
 */
describe("renderSqlCommenter", () => {
  it("serializes pairs as a block comment with keys sorted", () => {
    expect(renderSqlCommenter({ b: "2", a: "1" })).toBe("/*a='1',b='2'*/");
  });

  it("drops empty / undefined values", () => {
    expect(renderSqlCommenter({ a: "1", b: undefined, c: "" })).toBe(
      "/*a='1'*/",
    );
  });

  it("returns an empty string when nothing renders", () => {
    expect(renderSqlCommenter({ a: undefined, b: "" })).toBe("");
  });

  it("percent-encodes characters that could break the comment or SQL string", () => {
    // A single quote would close the SQL string; `*/` would end the comment
    // early. Both must be encoded. `/` is already encoded by encodeURIComponent.
    const out = renderSqlCommenter({ route: "/a/*x*/'b" });
    expect(out).not.toContain("'/"); // no raw quote adjacent to a slash
    expect(out.slice(2, -2)).not.toContain("*/"); // body carries no comment terminator
    expect(out).toContain("route=");
    expect(out).toContain("%27"); // encoded single quote
    expect(out).toContain("%2A"); // encoded asterisk
  });

  it("normalizes a route template into a single low-cardinality value", () => {
    const out = renderSqlCommenter({ route: "/t/:team/p/:project/runs" });
    expect(out.startsWith("/*route='")).toBe(true);
    expect(out.endsWith("'*/")).toBe(true);
  });
});

describe("buildTagComment", () => {
  it("includes the app-wide baseline plus per-call tags", () => {
    const out = buildTagComment({ feature: "test-owners" });
    expect(out).toContain("application='wrightful'");
    expect(out).toContain("service='dashboard'");
    expect(out).toContain("source='app'");
    expect(out).toContain("feature='test-owners'");
    // Deploy SHA is unset in tests (no VITE_RELEASE_SHA) → tag omitted.
    expect(out).not.toContain("release_sha");
  });

  it("lets a call override service and source", () => {
    const out = buildTagComment({
      service: "monitor-worker",
      source: "worker",
    });
    expect(out).toContain("service='monitor-worker'");
    expect(out).toContain("source='worker'");
    expect(out).not.toContain("service='dashboard'");
  });
});
