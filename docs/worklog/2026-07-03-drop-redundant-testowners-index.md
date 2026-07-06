# 2026-07-03 — Drop redundant `testOwners_project_testId_idx` index

## What changed

Implemented PlanetScale schema recommendation #1 (`duplicate_index`,
`left_prefix`): dropped the standalone non-unique index
`testOwners_project_testId_idx` on `public."testOwners"` — `(projectId,
testId)`.

That index is a strict left-prefix of the unique index
`testOwners_project_testId_owner_idx` on `(projectId, testId, owner)`. Postgres
serves any equality/range predicate on the leading `(projectId, testId)`
columns from the composite unique index, so the standalone index carried no
query benefit — only write amplification (every `testOwners` insert/delete
maintained a second B-tree) and ~8 KiB of storage. Removing it is a pure
performance/storage win with no behavioural change.

## Details

- **Recommendation:** <https://app.planetscale.com/wrigthful/wrightful/insights/recommendations/1>
  - DDL: `DROP INDEX "postgres"."public"."testOwners_project_testId_idx";`
  - Redundant index: `CREATE INDEX "testOwners_project_testId_idx" ON public."testOwners" USING btree ("projectId", "testId")`
  - Covered by: `CREATE UNIQUE INDEX "testOwners_project_testId_owner_idx" ON public."testOwners" USING btree ("projectId", "testId", owner)`

| File                                                                                   | Change                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard/db/schema.ts`                                                          | Removed the `index("testOwners_project_testId_idx")` definition from the `testOwners` table; folded its purpose comment (it served the `resolveTestOwners` per-test lookup) into the unique-index comment, noting the `(projectId, testId)` prefix now covers that lookup. |
| `apps/dashboard/db/migrations/20260703211031_massive_justice.sql`                      | Generated migration: `DROP INDEX "testOwners_project_testId_idx";`                                                                                                                                                                                                         |
| `apps/dashboard/db/migrations/meta/_journal.json`, `meta/20260703211031_snapshot.json` | Drizzle journal + snapshot updates (snapshot `prevId` chains off `20260703205234_groovy_madripoor`).                                                                                                                                                                       |

### Why this is safe (not the two-step drop process)

This is an **index** drop, not a table/column drop, so the "remove code first,
drop schema later" two-step process does not apply. No application code
references the index by name (verified via a repo-wide sweep — the name
appeared only in `schema.ts` and the migration that created it). The one query
that used the `(projectId, testId)` access pattern — `resolveTestOwners`
(`src/lib/owners-repo.ts`, `WHERE projectId = ? AND source = 'manual' AND testId
IN (…)`) — continues to be served by the left-prefix of the unique index.

## Verification

- `pnpm check` (format + lint + type-check): **0 errors**, 121 warnings — all
  pre-existing `no-unsafe-type-assertion` warnings in unrelated files; none in
  the changed files.
- `pnpm --filter @wrightful/dashboard db:generate` produced exactly the expected
  single-statement `DROP INDEX` migration; verified the snapshot `prevId` chains
  correctly off the latest committed migration (`groovy_madripoor`).
- `vp test run -c vitest.workers.config.ts owners-repo` — 15/15 passed (the code
  path that used the dropped index).
