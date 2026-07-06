# 2026-07-03 — Command-palette search: pg_trgm GIN indexes for the ILIKE scan (P1-5)

## What changed

The ⌘K command-palette test search matches `testResults.title`/`file` with a
**leading-wildcard** `ILIKE '%q%'`. A b-tree can't accelerate a leading wildcard,
and the only other predicate is the project-scope equality — so the query was a
full scan of the project's `testResults` partition on every (debounced)
keystroke, a multi-second query at a busy project's retained-row scale.

Added two `pg_trgm` GIN indexes on `testResults(title)` and `(file)` so the ILIKE
becomes a **Bitmap Index Scan**. Two single-column indexes (rather than one
combined) let the planner `BitmapOr` the title/file match and `BitmapAnd` it with
the existing project-scope b-tree.

**No code/query change** — the existing `buildTestSearchWhere` (`ILIKE '%q%'
ESCAPE '\'`) is exactly what `gin_trgm_ops` accelerates. The finding's second
half ("debounce server-side") was dropped after verification: the client already
debounces (`command-menu.tsx` `useDebouncedValue(query, 200)`), gates the fetch
(`enabled: open && hasProject`), dedupes via a 15s react-query `staleTime`, and
the route sets `Cache-Control: private, max-age=15`.

## Why

From the 2026-07-03 architecture review (P1-5, partially confirmed — the
"per keystroke" framing overstated it given the existing client debounce, but the
un-indexable scan is real).

## Details

| File                                                  | Change                                                                                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db/schema.ts`                                        | Two GIN indexes on `testResults`: `.using("gin", t.title.op("gin_trgm_ops"))` and the same for `file`.                                                                                                  |
| `db/migrations/20260703092642_slimy_layla_miller.sql` | Generated `CREATE INDEX … USING gin`, hand-augmented with `CREATE EXTENSION IF NOT EXISTS pg_trgm;` as the first statement — drizzle-kit does not emit the extension DDL, and the index build needs it. |

## Deployment note (self-hosting)

The `pg_trgm` extension must be available in the Postgres install (it is a
standard `contrib` module — present in the official `postgres:16` image, managed
Postgres, and Cloudflare Hyperdrive's backend). `CREATE EXTENSION IF NOT EXISTS`
enables it on first migrate and is a no-op thereafter. A Postgres built without
contrib will fail this migration — documented in SELF-HOSTING.md.

## Verification

- Applied the migration to a real Postgres 16 (`postgresql16-server` +
  `postgresql16-contrib`): `CREATE EXTENSION` + both `CREATE INDEX` succeed;
  `EXPLAIN` of the search query shows `BitmapOr → Bitmap Index Scan on
testResults_title_trgm_idx / testResults_file_trgm_idx` (not a Seq Scan), and a
  mid-string `%widget%` match returns all seeded rows (leading-wildcard still
  works post-index).
- Full pg-integration suite passes against **real node-postgres**
  (`PG_TEST_URL`), 36 tests — confirms the schema still round-trips on the
  production driver.
- Fast lane (pglite) + full dashboard suite green; `pnpm check` — 0 errors. (The
  pglite test lane builds DDL from the schema config and omits indexes, so the
  trgm index is validated on real Postgres, not pglite.)
