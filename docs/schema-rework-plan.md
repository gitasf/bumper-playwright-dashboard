# Schema rework plan

**Status:** IMPLEMENTED 2026-07-04 (Phases 1, 2, 4, 6 in full; Phase 3 structural items

- jsonb conversion; status-CHECKs + reserved-column drops deferred). See
  `docs/worklog/2026-07-04-schema-rework.md` for what landed, what was deferred and why, and
  the real-Postgres migration verification. **Window:** early-production — one org is live
  and **its data must survive**. Everything ships as stacked, forward-only migrations with
  in-migration backfills; there is no reset.

> **Data decision (2026-07-03):** production has one active org and its data is NOT
> disposable. Consequences baked into this plan:
>
> - **Phase 5 (migration squash) is CUT** — a squash is incompatible with preserving
>   data. The clean-baseline door is closed; stacked migrations from here on.
> - Every step marked **[data]** below is **mandatory**: Phase 1's `tests` backfill,
>   Phase 3's `USING ::jsonb` casts + FK/CHECK pre-cleanup, Phase 4's backfill `UPDATE`s
>   before `SET NOT NULL`.
> - At the current data volume none of these migrations have locking or duration
>   concerns; the backfill-then-constrain / pre-check-then-cast discipline is the same
>   shape every future production migration will need anyway.

This plan comes out of a first-principles review of `apps/dashboard/db/schema.ts`, the
migration history in `db/migrations/`, and the hot query paths (ingest, run list/detail,
analytics, retention). The schema is in good shape overall — tenancy denormalization,
index hygiene, and the counter/cron drift design are deliberate and documented. The items
below are the places where feature accretion left seams that get more expensive to fix
as data accumulates — which is why they should land now, while production holds one org's
worth of rows.

Phases are ordered so each lands independently as its own migration + worklog entry.

---

## Phase 1 — Introduce a `tests` catalog table (the missing entity)

### Problem

Test identity (`title`, `file`) is repeated on every `testResults` row forever. Three
consumers have each re-derived the entity:

- The ⌘K palette search runs `ILIKE '%q%'` over **all retained history**, patched with two
  trigram GIN indexes on `testResults` (`testResults_title_trgm_idx`,
  `testResults_file_trgm_idx` — migration `20260703092642_slimy_layla_miller.sql`). GIN
  indexes on the largest, hottest-write table amplify every ingest flush, and search cost
  grows with retained history rather than suite size.
- The tests-catalog page (`pages/t/[teamSlug]/p/[projectSlug]/tests.server.ts`)
  reconstructs the entity with `GROUP BY testId` + a window CTE on every load.
- `quarantinedTests` and `testOwners` key on bare `(projectId, testId)` strings with no
  anchor row.

### Design

New table in `db/schema.ts`:

```ts
export const tests = pgTable(
  "tests",
  {
    id: text("id").primaryKey(), // ulid
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    testId: text("testId").notNull(), // stable Playwright test id (same value the child tables key on)
    title: text("title").notNull(), // latest-wins on upsert
    file: text("file").notNull(), // latest-wins on upsert
    firstSeenAt: big("firstSeenAt").notNull(),
    lastSeenAt: big("lastSeenAt").notNull(),
  },
  (t) => [
    uniqueIndex("tests_project_testId_idx").on(t.projectId, t.testId),
    index("tests_project_lastSeenAt_idx").on(t.projectId, t.lastSeenAt),
    // Palette search moves here — small table, bounded by suite size not history.
    index("tests_title_trgm_idx").using("gin", t.title.op("gin_trgm_ops")),
    index("tests_file_trgm_idx").using("gin", t.file.op("gin_trgm_ops")),
  ],
);
```

Deliberately minimal: no status/aggregate columns (those stay read-derived from
`testResults`); this is an identity/dimension table, not a rollup.

### Changes

1. **Ingest upsert** (`src/lib/ingest.ts`): both write paths that touch `testResults`
   gain a chunked `INSERT ... ON CONFLICT ("projectId", "testId") DO UPDATE SET title,
file, lastSeenAt` statement inside the same `runBatch` transaction:
   - the `openRun` queued-test prefill (~`ingest.ts:961`), and
   - `appendRunResults` (~`ingest.ts:1184`).
     Reuse the existing `chunkInsertRows` bound-param chunking (65,535 ceiling). One extra
     statement per batch, not per test.
2. **Palette search** (`src/lib/command-search.ts` → `buildTestSearchWhere`, consumed by
   `routes/api/t/[teamSlug]/p/[projectSlug]/search.ts`): switch the test group to query
   `tests` (scope predicate stays `childProjectScopeWhere(tests.projectId, scope)`).
   Verify the route's result shape — searching `tests` returns one row per test natively,
   so any DISTINCT/dedup the route does over `testResults` rows can be removed.
3. **Tests-catalog page** (`tests.server.ts`): keep the aggregate pass over `testResults`
   (pass counts etc. are genuinely historical), but source `title`/`file` from a join to
   `tests` instead of the latest-row window CTE, and consider driving pagination off
   `tests` so empty-history tests still appear.
4. **Drop from `testResults`**: `testResults_title_trgm_idx`, `testResults_file_trgm_idx`.
   The `pg_trgm` extension stays — it's already created by migration
   `20260703092642_slimy_layla_miller.sql` and the `tests` GIN indexes need it, so the new
   migration requires no hand-augmentation. Re-evaluate whether
   `testResults_project_testId_createdAt_idx` is still needed after the catalog page
   changes; keep it if the aggregate pass still groups by `testId` (it will).
5. **Anchoring (optional, recommended)**: add composite FKs from
   `quarantinedTests(projectId, testId)` and `testOwners(projectId, testId)` to
   `tests(projectId, testId)` with `onDelete: "cascade"`. Both tables are written from
   the UI for tests that already exist in the catalog, so insertion order is safe. If
   this feels too coupled, defer — it's additive later.
6. **Retention interplay**: `tests` rows are NOT swept by the retention cron — the
   catalog is bounded by suite size. Optionally, a later cron can prune rows with
   `lastSeenAt` older than the team's testResults window; not required for v1.
7. **[data] Backfill (mandatory)**: in the same migration, a one-time
   `INSERT INTO tests ... SELECT` of the latest `title`/`file` per `(projectId, testId)`
   from `testResults` (a `row_number()`-latest pick), with `firstSeenAt = min(createdAt)`
   and `lastSeenAt = max(createdAt)`. Without it, the live org's existing tests are
   invisible to palette search / FK anchoring until their next run. Order matters: the
   backfill must precede step 5's composite FKs if those land in the same migration.

No wire/contract change — the reporter payload is untouched, so
`packages/reporter/src/__tests__/contract.test.ts` should pass unmodified.

**Tests to update/add:** `command-search.workers.test.ts` (new table), ingest tests
(upsert present in batch, latest-wins title), `pg-integration.test.ts` (trigram search
against `tests`), tests-catalog loader tests.

---

## Phase 2 — Close the auth-boundary delete gap

### Problem

Every user reference is a logical FK by design (`memberships.userId`,
`memberGroupMembers.userId`, `userState.userId`, `userGithubAccounts.userId`, plus the
`createdBy`/`actorUserId` audit-style columns). There is **no user-deletion cleanup
anywhere** — a deleted Better Auth user silently orphans membership rows, including
sole-owner memberships of live teams.

### Options

- **A. Real FKs via hand-augmented migration.** All tables live in one Postgres database,
  and drizzle-kit diffs against its own snapshot, so an out-of-band
  `ALTER TABLE ... ADD CONSTRAINT ... REFERENCES "user"(id) ON DELETE CASCADE` persists
  fine (precedent: the hand-added `CREATE EXTENSION pg_trgm`). **Risk:** ordering — our
  migrations run on `void deploy`; the Better Auth tables are bootstrapped idempotently by
  `void/auth`. If migrations can run before the `user` table exists on a fresh database,
  the FK migration fails. This must be verified against a fresh `void db reset` + boot
  before choosing A.
- **B. App-level `deleteUser` hook** in `apps/dashboard/auth.ts` (Better Auth supports
  user-deletion lifecycle hooks): delete `memberships`, `memberGroupMembers`, `userState`,
  `userGithubAccounts` rows for the user in one `runBatch`, with a **sole-owner policy**
  decided explicitly (recommend: block deletion while the user is the only `owner` of any
  team, mirroring the existing leave-team guard).

### Recommendation

Do **B** regardless (the sole-owner policy needs app logic that FKs can't express), and
add **A** for `memberGroupMembers` / `userState` / `userGithubAccounts` as
defense-in-depth **only if** the fresh-boot ordering check passes. `memberships` cleanup
should stay app-level either way, because cascade-deleting a sole owner's membership
would strand a team.

Do **not** add FKs on `createdBy` / `actorUserId` / `auditLog.actorUserId` — those rows
must outlive the user (same principle as the audit-log project FK), so they stay logical
with the user id as an opaque historical label.

**Tests:** unit test the hook's batch + sole-owner guard; a pg-integration case for the
FKs if A lands.

---

## Phase 3 — `jsonb`, dead weight, and type fixes

All small, all additive-or-destructive-while-empty. One pass:

1. **`text`-JSON → `jsonb`** for: `monitors.alertTargets`, `monitors.config`,
   `monitors.retryConfig` (if kept — see below), `monitorExecutions.resultDetail`,
   `auditLog.metadata`. Evidence the blobs are already being mined:
   `monitorExecutions.statusCode` was hoisted into a real column to avoid JSON parsing.
   With drizzle's `jsonb(...).$type<T>()`, writers stop `JSON.stringify`-ing and readers
   stop `JSON.parse`-ing. Touch points: `src/lib/monitors/alert-targets.ts`,
   `src/lib/monitors/monitors-repo.ts`, the http executor's `resultDetail` writer,
   `src/lib/audit.ts` (`recordAudit`). Verify pglite/node-postgres parity in
   `pg-integration.test.ts` (both return jsonb as objects, but this is exactly the class
   of trap that suite exists for).
2. **Drop `runs_project_monitor_created_at_idx`** — self-documented as "pure write
   amplification" for a "runs for this monitor" list that hasn't landed. Re-add with the
   feature; index additions are cheap and additive.
3. **Drop `usageCounters.testResultsCount`** — the half-alive column: not bumped on the
   hot path, not what the usage page reads (`countTeamTestResults` derives it), only
   re-based by the `rollup-usage` cron as a "backstop". Remove the column, the cron's
   re-base of it, and any reads. The derived-on-read path stays as-is.
4. **Reserved-column audit** (each is trivially additive to restore later):
   - `testOwners.source` — only `'manual'` is ever written; the `'codeowners'` leg is
     derived on the fly. **Drop the column** (and narrow the type) until a
     materialize-at-ingest pass actually lands.
   - `monitors.schedulingStrategy`, `monitors.retryConfig` — reserved, unconsumed in v1.
     **Drop** unless multi-location work is scheduled this quarter.
   - `quarantinedTests.mode` — **keep**: it's part of the quarantine write API surface
     and the `'skip'` value is load-bearing in the reporter demotion flow.
5. **`artifacts.sizeBytes` → `bigint`** (`big()` helper). It's `integer` (2.1 GB max)
   while the cap is env-configurable via `WRIGHTFUL_MAX_ARTIFACT_BYTES` — a >2 GiB cap
   would overflow int4. `usage.ts`'s `coalesce(sum(...))` already goes through
   `numericSql`, so the read side is unaffected.
6. **Real FKs for `runs.monitorId` and `monitorExecutions.runId`** with
   `onDelete: "set null"`. The schema comments justify these logical FKs as avoiding "a
   cascade cycle in the generated migration", but no cycle exists — `monitors` references
   only `teams`/`projects`, so neither constraint closes a loop. Both columns are already
   nullable, and `SET NULL` is exactly the semantics the comments describe wanting
   (deleted monitor → run retained; deleted run → execution row retained with a null
   link) — strictly better than dangling ids. Update both doc-comments.
7. **Partial CHECK for the retention invariant**:
   `CHECK (retentionArtifactDays IS NULL OR retentionTestResultsDays IS NULL OR
retentionArtifactDays <= retentionTestResultsDays)`. Today the
   artifact-window ≤ testResults-window rule lives only in the settings action
   (`general.server.ts`). Note the limit: the invariant is really on _effective_ values
   (NULL falls back to `WRIGHTFUL_RETENTION_*` env defaults the DB can't see), so the
   CHECK only closes the both-set case — the settings-action validation stays
   load-bearing for the mixed NULL/env cases.
8. **CHECK constraints on protocol-fixed status columns** (`runs.status`,
   `testResults.status`, `monitorExecutions.state`) — these vocabularies are pinned by
   the wire contract / Playwright's outcome set, so a typo'd status is a silent bug today
   and widening them already implies a contract change. Do NOT extend this to
   product-evolving unions (`quarantinedTests.mode`, `memberships.role`,
   `monitors.lastStatus`) — the repo's documented stance (see the `MembershipRole`
   comment) is text + `$type<>` so widening is a type-only change, and that stands.
9. **[data] Preconditions (mandatory)**: the jsonb conversions need
   `ALTER ... TYPE jsonb USING col::jsonb` — run a pre-check `SELECT` for malformed
   stored JSON first (the cast hard-fails on it). Before adding the `SET NULL` FKs, null
   out any dangling `runs.monitorId` / `monitorExecutions.runId` values with an `UPDATE`
   in the same migration. Before adding CHECKs, verify no existing row violates them
   (query production, don't assume).

---

## Phase 4 — NOT NULL tightening (kill the migration-safety nullables)

Both of these are nullable only to protect early rows that predate the columns — a
one-time backfill converts them for good:

1. **`runs.lastActivityAt` → NOT NULL.** Every writer already sets it (initialized to
   `createdAt` at open, bumped in-transaction on every write). Remove the
   `coalesce(lastActivityAt, createdAt)` idiom — primary site is `staleRunFilter` in
   `src/lib/scope.ts:319`; grep for other `coalesce` readers of the pair. The
   `runs_status_lastActivityAt_idx` comment referencing the coalesce should be updated.
2. **`testResults.updatedAt` → NOT NULL.** Writers already set it on insert
   (`= createdAt`) and every upsert. The schema comment says no reader needs the coalesce
   yet — so this is just flipping the constraint and deleting the caveat from the
   doc-comment.

**[data] (mandatory)** Each flip is preceded by a backfill in the same migration:
`UPDATE runs SET "lastActivityAt" = "createdAt" WHERE "lastActivityAt" IS NULL;` and
`UPDATE "testResults" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;` —
exactly the semantics the coalesce readers assume today.

---

## Phase 5 — Migration squash: CUT (decision 2026-07-03)

The original plan squashed `db/migrations/*` to a single clean baseline, following the
pre-production precedent in `docs/worklog/2026-04-17-multi-tenancy.md`. **Cut**: one org
is live in production and its data must survive, and a squash is fundamentally
incompatible with that — the migration journal on the production database must remain a
prefix of the committed history. Phases 1–4 ship as ordinary stacked migrations with
their `[data]` backfills, which is the permanent operating mode from here on.

(If some future moment produces a genuinely empty production database again, the squash
steps live in this file's git history.)

---

## Phase 6 — ADR: `testResults` retention vs partitioning

Write `docs/adr/0004-testresults-retention-partitioning.md`. Decision to record
(recommend **defer, with a documented ceiling**):

- **Today:** retention is budget-bounded `DELETE` sweeps (`src/lib/retention.ts`). At
  scale, rolling deletes on the biggest table mean dead tuples, vacuum pressure, and disk
  that only autovacuum reclaims.
- **Alternative:** monthly range partitioning on `testResults.createdAt`, where retention
  becomes `DROP PARTITION`. Cost: the `(runId, testId)` unique and the PK must include
  the partition key; `testResultAttempts`/`testTags`/`testAnnotations`/`artifacts` FKs
  point at a partitioned parent; drizzle-kit has no first-class partitioning support, so
  the DDL becomes hand-managed; per-team retention windows don't align with global
  partition boundaries (partition drop handles the global floor, per-team deletes still
  handle the rest).
- **Trigger to revisit:** record a concrete threshold — e.g. `testResults` approaching
  ~100M rows, or the retention sweep's delete budget persistently saturating, or vacuum
  lag showing up in Hyperdrive latency.

No code change in this phase; the ADR is the deliverable.

---

## Sequencing & verification

| Phase                  | Depends on              | Ships alone?   |
| ---------------------- | ----------------------- | -------------- |
| 1. `tests` catalog     | —                       | yes            |
| 2. Auth delete gap     | —                       | yes            |
| 3. jsonb + dead weight | —                       | yes            |
| 4. NOT NULL tightening | —                       | yes            |
| 5. Migration squash    | **CUT** (data decision) | —              |
| 6. Partitioning ADR    | —                       | yes (any time) |

Per-phase verification: `pnpm check`, `pnpm test`, the real-Postgres leg
(`pg-integration.test.ts`), and the full e2e dashboard suite after the last schema phase
lands. Phase 1 also needs the reporter contract test
(`packages/reporter/src/__tests__/contract.test.ts`) — it should pass unmodified; if it
doesn't, the phase leaked into the wire contract. Because production data now survives
migrations, each schema phase should additionally be rehearsed against a copy/branch of
the production database (Neon branching or a `pg_dump` restore) before `void deploy`
applies it for real.

Each phase gets a `docs/worklog/` entry per the repo's worklog requirement.

## Explicitly considered and left alone

- **Epoch-seconds `bigint` timestamps** (vs `timestamptz`) — the Postgres-only worklog
  (`docs/worklog/2026-06-16-postgres-only.md`) explicitly deferred pg-native types as "a
  separate, optional follow-up", so this is a decision to _make_, not a default to keep
  silently. Decision: **keep epoch-seconds**. The convention is consistent, the bucketing
  SQL (`analytics/bucketing-sql.ts`), retention math, and every `nowSeconds` write site
  are built around it, and the wire contract speaks epoch numbers either way — switching
  buys readability in psql at the cost of churn across ingest/analytics/crons. Record
  this in the Phase 6 ADR (or a sibling decision note) so it stops resurfacing.
- **Denormalized `teamId` consistency** (`runs.teamId` vs `projects.teamId`) — currently
  guaranteed only by the single write path deriving both from one `TenantScope`. A DB
  backstop exists if more write paths ever appear: `UNIQUE (projects.id, teams."teamId")`
  - composite FK `runs(projectId, teamId) → projects(id, teamId)`. Filed, not done.
- **Denormalized `projectId`/`teamId` + branded scope types** — the load-bearing tenancy
  design; re-litigating it is off the table per
  `docs/worklog/void-migration-consolidated.md`.
- **Write-time run counters + drift-correcting recompute** — deliberate and tested.
- **Offset pagination** on runs list / tests catalog / audit log — degrades on deep pages,
  but page depth is humanly bounded and the keyset pattern already exists in-repo
  (run-results cursor) if a specific surface ever hurts.
