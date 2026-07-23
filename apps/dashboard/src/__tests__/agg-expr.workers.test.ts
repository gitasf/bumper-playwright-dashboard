import { describe, expect, it } from "vite-plus/test";
import { sql } from "void/db";
import {
  castIntAggFragment,
  castNumAggFragment,
  intAggExpr,
  numAggExpr,
} from "@/lib/db/sql-ops";

/**
 * `intAggExpr` / `numAggExpr` are the raw-read counterpart to `numericSql`: they
 * BAKE the int8→int4 (`cast(… as integer)`) / numeric→float
 * (`cast(… as double precision)`) coercion into the emitted SQL fragment, so a
 * caller writing a hand-written `runRows`/`runRow` count/sum/avg select can't
 * forget it and silently read a `"5"` string typed as `number`.
 *
 * The raw `runRows` path bypasses Drizzle's field decoders, so the cast MUST live
 * in the SQL (a `.mapWith(Number)` never fires). These were re-typed inline at
 * ~6 sites across the insights/tests loaders; the helpers give that vocabulary a
 * single owner, mirroring `statusCounter` / `percentilePick`.
 *
 * Both emit raw SQL (`sql.raw`) — the inner aggregate is in-code SQL text and the
 * optional alias is a guarded identifier, never bound params, for the same
 * text-affinity reason the analytics fragment builders inline their identifiers.
 * Under the void/db stub `sql.raw(s)` records `s` in `strings`, so we read the
 * rendered text back without a real database. These assertions pin the emitted
 * SQL byte-for-byte against the inline casts the loaders previously typed, so a
 * drift fails loudly here.
 */

/** Read the rendered SQL text off a `sql.raw(...)` fragment from the stub. */
function rawText(expr: unknown): string {
  const chunk = expr as { strings: unknown; args: readonly unknown[] };
  const s = chunk.strings;
  return Array.isArray(s) ? s.join("") : String(s);
}

/** A `sql.raw(...)` fragment carries no bound params. */
function noBoundArgs(expr: unknown): void {
  const chunk = expr as { args: readonly unknown[] };
  expect(chunk.args).toHaveLength(0);
}

describe("intAggExpr — int8 → int4 coercion", () => {
  it("wraps a bare aggregate in cast(… as integer), no alias", () => {
    expect(rawText(intAggExpr("count(*)"))).toBe("cast(count(*) as integer)");
  });

  it("appends `as <alias>` when given an alias", () => {
    expect(rawText(intAggExpr("count(*)", { alias: "n" }))).toBe(
      "cast(count(*) as integer) as n",
    );
  });

  it("threads a quoted alias verbatim", () => {
    expect(
      rawText(intAggExpr("count(*) over ()", { alias: `"totalDistinct"` })),
    ).toBe(`cast(count(*) over () as integer) as "totalDistinct"`);
  });

  it("passes a table-qualified count(distinct …) inner through unaltered", () => {
    expect(
      rawText(intAggExpr(`count(distinct tr."testId")`, { alias: `"unique"` })),
    ).toBe(`cast(count(distinct tr."testId") as integer) as "unique"`);
  });

  it("binds nothing — inner + alias are inline raw SQL, never params", () => {
    noBoundArgs(intAggExpr("count(*)"));
    noBoundArgs(intAggExpr("count(*)", { alias: "n" }));
  });

  it("rejects an unsafe alias (defense-in-depth, like statusCounter)", () => {
    expect(() => intAggExpr("count(*)", { alias: "n; drop table" })).toThrow(
      /unsafe SQL identifier/,
    );
  });

  it("matches, byte-for-byte, the inline int casts the loaders previously typed", () => {
    // tests.server.ts runPageQuery / runAggregateQuery; slowest-tests totals;
    // suite-size testsAddedQuery.
    expect(
      rawText(intAggExpr("count(*) over ()", { alias: `"totalDistinct"` })),
    ).toBe(`cast(count(*) over () as integer) as "totalDistinct"`);
    expect(rawText(intAggExpr("count(*)", { alias: "n" }))).toBe(
      "cast(count(*) as integer) as n",
    );
    expect(
      rawText(intAggExpr(`count(distinct tr."testId")`, { alias: `"unique"` })),
    ).toBe(`cast(count(distinct tr."testId") as integer) as "unique"`);
    expect(rawText(intAggExpr("count(*)", { alias: "added" }))).toBe(
      "cast(count(*) as integer) as added",
    );
  });
});

describe("numAggExpr — numeric → double precision coercion", () => {
  it("wraps an avg in cast(… as double precision), no alias", () => {
    expect(rawText(numAggExpr(`avg("durationMs")`))).toBe(
      `cast(avg("durationMs") as double precision)`,
    );
  });

  it("appends `as <alias>` when given an alias", () => {
    expect(
      rawText(numAggExpr(`avg("durationMs")`, { alias: `"avgDurationMs"` })),
    ).toBe(`cast(avg("durationMs") as double precision) as "avgDurationMs"`);
  });

  it("binds nothing — inner + alias are inline raw SQL, never params", () => {
    noBoundArgs(numAggExpr(`avg("durationMs")`));
    noBoundArgs(numAggExpr(`avg("durationMs")`, { alias: "avg" }));
  });

  it("rejects an unsafe alias", () => {
    expect(() => numAggExpr(`avg("durationMs")`, { alias: "avg) --" })).toThrow(
      /unsafe SQL identifier/,
    );
  });

  it("matches, byte-for-byte, the inline avg casts the loaders previously typed", () => {
    // tests.server.ts runAggregateQuery; slowest-tests bottlenecks + sparkline.
    expect(
      rawText(numAggExpr(`avg("durationMs")`, { alias: `"avgDurationMs"` })),
    ).toBe(`cast(avg("durationMs") as double precision) as "avgDurationMs"`);
    expect(
      rawText(numAggExpr(`avg("durationMs")`, { alias: `"avgDur"` })),
    ).toBe(`cast(avg("durationMs") as double precision) as "avgDur"`);
    expect(rawText(numAggExpr(`avg(tr."durationMs")`, { alias: "avg" }))).toBe(
      `cast(avg(tr."durationMs") as double precision) as avg`,
    );
  });
});

/**
 * The fragment-accepting variants wrap an EXISTING `sql\`…\`` fragment (whose
 * inner expression may carry bound params, e.g. uptime-analytics's window sums)
 * in the cast via the `sql` tagged template — NOT `sql.raw` — so the inner
 * `${…}` params survive the wrap instead of being inlined as text. Adopted at
 * `httpUptimeWindows` for its `sum(case when "createdAt" >= ${dN} …)` counts.
 *
 * Under the void/db stub a tagged `sql\`cast(${inner} as integer)\`` records the
 * static cast literal in `strings` and the inner fragment in `args` — so we read
 * the wrapping text off `strings` and assert the inner fragment (with its own
 * bound params) is threaded through as an interpolated arg, never flattened into
 * a raw string. End-to-end param preservation is covered against pglite in
 * `pg-integration/` (the stub doesn't flatten nested fragments).
 */

/** A tagged-template `sql\`…\`` node records `strings` (chunks) + `args` (interps). */
interface StubSqlNode {
  strings: readonly string[];
  args: readonly unknown[];
}

describe("castIntAggFragment / castNumAggFragment — bound-param-preserving casts", () => {
  it("wraps a fragment in cast(… as integer) via the tagged template (not raw)", () => {
    const wrapped = castIntAggFragment(
      sql`sum(case when "createdAt" >= ${100} then 1 else 0 end)`,
    ) as unknown as StubSqlNode;
    // The cast literal is static text on both sides of the interpolation.
    expect(Array.from(wrapped.strings)).toEqual(["cast(", " as integer)"]);
    // The inner aggregate is threaded as ONE interpolated fragment, not inlined.
    expect(wrapped.args).toHaveLength(1);
  });

  it("wraps a fragment in cast(… as double precision)", () => {
    const wrapped = castNumAggFragment(
      sql`avg("durationMs")`,
    ) as unknown as StubSqlNode;
    expect(Array.from(wrapped.strings)).toEqual([
      "cast(",
      " as double precision)",
    ]);
    expect(wrapped.args).toHaveLength(1);
  });

  it("preserves the inner fragment's bound params (does not inline them)", () => {
    // The whole point: `${100}` rides along as a BOUND PARAM inside the wrapped
    // fragment, so the cast wrapper doesn't turn it into text. The stub keeps the
    // inner fragment intact in `args`, carrying its own `${…}` interpolations.
    const inner = sql`sum(case when "createdAt" >= ${100} and "createdAt" < ${200} then 1 else 0 end)`;
    const wrapped = castIntAggFragment(inner) as unknown as StubSqlNode;
    const innerNode = wrapped.args[0] as unknown as StubSqlNode;
    // Same fragment object threaded through — its bound params travel with it.
    expect(innerNode).toBe(inner as unknown as StubSqlNode);
    expect(Array.from(innerNode.args)).toEqual([100, 200]);
  });
});
