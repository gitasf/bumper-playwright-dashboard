import { sql } from "void/db";
import { assertSqlIdentifier } from "@/lib/analytics/sql-identifier";

/** A raw Drizzle SQL fragment — the `sql\`…\`` tagged-template result. */
type SqlFragment = ReturnType<typeof sql>;

/**
 * Coerce a selected aggregate / bigint SQL expression to a JS `number`.
 *
 * node-postgres returns `int8` (the type of `count(*)` / `sum(int)`) and
 * `numeric` as JS **strings** (to avoid silent 64-bit precision loss). A bare
 * `sql<number>\`count(*)\`` only sets the TS type — it adds NO runtime mapper —
 * so the value is a string at runtime while the types claim `number`, and
 * `"5" + 1` style bugs follow. `.mapWith(Number)` attaches Drizzle's decoder so
 * the value is `Number(…)` on read.
 *
 * Use this for ANY selected `count()`/`sum()`/`avg()`/bigint expression built
 * through the Drizzle query builder, in place of a bare `sql<number>`.
 * (Drizzle's own `count()` helper already does this; this covers the
 * hand-written `sql\`…\`` aggregates the builder can't express.)
 *
 * NOTE: this only works for expressions run through `db.select({...})` — Drizzle
 * applies the field decoders there. Raw `runRows`/`runRow` queries bypass that
 * mapping, so those must cast in SQL instead — use {@link intAggExpr} /
 * {@link numAggExpr} below, which bake the `cast(… as integer / double precision)`
 * so the coercion can't be forgotten.
 */
export function numericSql(fragment: SqlFragment) {
  return fragment.mapWith(Number);
}

/**
 * The raw-read counterpart to {@link numericSql}, for the `runRows`/`runRow`
 * path (`src/lib/runs/db.ts`).
 *
 * That path runs hand-written `sql\`…\`` queries straight through `db.execute`,
 * bypassing Drizzle's field decoders — so `.mapWith(Number)` never fires and the
 * int8-as-string trap above bites in full. The fix is a SQL-side `cast`: casting
 * an int8 `count()`/`sum()` to `int4` (`cast(… as integer)`) or a `numeric`
 * `avg()` to `double precision` makes BOTH node-postgres and pglite hand the
 * value back as a JS number.
 *
 * These two builders BAKE that cast into the emitted fragment — like
 * `statusCounter` in `analytics/per-test.ts` does for its status sums — so a
 * caller writing a raw count/sum/avg select can't forget the coercion and silently
 * read a `"5"` string typed as `number`. Adopt them in place of a re-typed inline
 * `cast(count(*) as integer)` / `cast(avg(x) as double precision)`.
 *
 * Scope is strictly the int8/numeric aggregates that need coercion — `count`,
 * `sum`, `avg`. `min()`/`max()` over an int4 column already return int4 → a JS
 * number, so they must NOT be cast (and have no helper here).
 *
 * The inner expression is in-code SQL text (`count(*) over ()`,
 * `avg("durationMs")`, `sum(case when … end)`), not an identifier, so it is NOT
 * routed through `assertSqlIdentifier` — only the optional output alias is (it is
 * a column name, matching `statusCounter`'s guard). Both are inlined as raw SQL
 * (`sql.raw`), never bound params, for the same text-affinity reason the analytics
 * fragment builders inline their identifiers.
 *
 * @param inner        the aggregate SQL expression to cast (e.g. `count(*)`,
 *                     `count(distinct tr."testId")`, `avg("durationMs")`).
 * @param opts.alias   optional output column name (e.g. `"avgDurationMs"`).
 */
function castAggExpr(
  inner: string,
  castType: "integer" | "double precision",
  alias?: string,
): SqlFragment {
  const expr = `cast(${inner} as ${castType})`;
  return sql.raw(
    alias ? `${expr} as ${assertSqlIdentifier(alias)}` : expr,
  ) as SqlFragment;
}

/**
 * `cast(<count/sum expr> as integer)` — the int8→int4 coercion for the raw-read
 * path. Use for `count(*)`, `count(distinct …)`, and `sum(int)` selects whose row
 * type claims `number`. See {@link castAggExpr}.
 */
export function intAggExpr(
  inner: string,
  opts: { alias?: string } = {},
): SqlFragment {
  return castAggExpr(inner, "integer", opts.alias);
}

/**
 * `cast(<avg expr> as double precision)` — the numeric→float coercion for the
 * raw-read path. Use for `avg(…)` selects whose row type claims `number`. See
 * {@link castAggExpr}.
 */
export function numAggExpr(
  inner: string,
  opts: { alias?: string } = {},
): SqlFragment {
  return castAggExpr(inner, "double precision", opts.alias);
}

/**
 * Fragment-accepting counterpart to {@link intAggExpr} / {@link numAggExpr}.
 *
 * `intAggExpr`/`numAggExpr` take in-code SQL *text* and emit via `sql.raw` — fine
 * for `count(*)` / `avg("durationMs")`, but they can't wrap an aggregate whose
 * inner expression carries BOUND PARAMS (e.g. uptime-analytics's window sums,
 * `sum(case when "createdAt" >= ${d1} then 1 else 0 end)`): `sql.raw` would
 * inline the param as text, changing the emitted SQL. These two wrap an EXISTING
 * `SqlFragment` with the `sql` tagged template, so the inner fragment's bound
 * params flow through unchanged while still baking the int8→int4 /
 * numeric→double-precision cast at the seam.
 *
 * Scope matches the text variants — only the int8/numeric aggregates that need
 * coercion (`count`/`sum`/`avg`). int4 `min()`/`max()` already return a JS number
 * and must NOT be cast.
 */
function castAggFragment(
  inner: SqlFragment,
  castType: "integer" | "double precision",
): SqlFragment {
  // The `sql` tagged template merges `inner`'s chunks + bound params into the
  // wrapping fragment, so `${d1}`/`${d7}` stay bound params (not inlined). The
  // cast literal is static raw text on both sides of the interpolation.
  if (castType === "integer") return sql`cast(${inner} as integer)`;
  return sql`cast(${inner} as double precision)`;
}

/**
 * `cast(<count/sum fragment> as integer)` — the int8→int4 coercion for a raw-read
 * aggregate whose inner expression carries bound params. See
 * {@link castAggFragment}.
 */
export function castIntAggFragment(inner: SqlFragment): SqlFragment {
  return castAggFragment(inner, "integer");
}

/**
 * `cast(<avg fragment> as double precision)` — the numeric→float coercion for a
 * raw-read aggregate whose inner expression carries bound params. See
 * {@link castAggFragment}.
 */
export function castNumAggFragment(inner: SqlFragment): SqlFragment {
  return castAggFragment(inner, "double precision");
}
