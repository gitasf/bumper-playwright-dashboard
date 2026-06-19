import { sql } from "void/db";

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
 * mapping, so those must cast in SQL instead (`cast(… as integer)` → `int4`,
 * which the driver parses to a number).
 */
export function numericSql(fragment: SqlFragment) {
  return fragment.mapWith(Number);
}
