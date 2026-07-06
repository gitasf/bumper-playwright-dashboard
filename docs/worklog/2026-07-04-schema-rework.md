# 2026-07-04 — Schema rework: tests catalog, auth-delete gap, integrity FKs, NOT NULL tightening

Implements `docs/schema-rework-plan.md` — the first-principles schema pass. The
app is early-production with one active org whose data must survive, so
**everything ships as stacked forward-only migrations with in-migration
backfills** (the plan's Phase 5 squash was cut). Three new migrations, all
hand-augmented with data steps drizzle-kit can't emit.

## What changed

### Phase 1 — `tests` identity catalog (the missing entity)

Test identity (`title`/`file`) was repeated on every `testResults` row, and three
consumers each re-derived it. Added a `tests` catalog table (one row per
`(projectId, testId)`: `title`, `file`, `firstSeenAt`, `lastSeenAt`), upserted at
ingest inside the same `runBatch` as the results it describes — from BOTH the
`openRun` queued prefill and `appendRunResults` (`buildTestCatalogUpsertStatements`
in `src/lib/ingest.ts`, deduped by `testId`, latest-wins on `title`/`file`).

- The two trigram GIN indexes MOVED off `testResults` onto `tests`, so ⌘K search
  cost is bounded by suite size, not retained-result history. The `pg_trgm`
  extension stays (already created by an earlier migration).
- ⌘K palette search (`command-search.ts` + `routes/.../search.ts`) now reads
  `tests` directly — one row per test, no `GROUP BY` over fact rows.
- The catalog + slowest-tests `q` filter (`searchFragment`) resolves matching
  `testId`s via an `EXISTS` against `tests` (correlated on `tr."testId"`), so it
  uses the relocated trigram indexes instead of scanning the result partition.
- **[data] backfill** (migration `20260703233922`): one-time `INSERT … SELECT`
  seeding the catalog from existing `testResults` (latest-by-`createdAt`
  title/file via `DISTINCT ON`, min/max `createdAt` for first/last-seen).
- Deferred (explicitly, per plan): the hard composite FK from
  `quarantinedTests`/`testOwners` → `tests` — additive later, and adding it now
  could fail against a quarantine/owner row for a test with no results yet.

### Phase 2 — auth-boundary delete gap

Every user reference (`memberships`, `memberGroupMembers`, `userState`,
`userGithubAccounts`, plus `createdBy`/`actorUserId`) is a logical FK across the
void/auth boundary, and NOTHING cleaned them up on user deletion. Added
`src/lib/user-teardown.ts` and wired Better Auth's `user.deleteUser` hooks in
`auth.ts` (deferred dynamic import, matching the github-mirror pattern):

- `beforeDelete` → `assertUserDeletable`: blocks deleting a user who is the SOLE
  owner of any team (a cascade would strand it). Two-query, no N+1.
- `afterDelete` → `cleanupUserData`: sweeps the four logical-FK tables in one
  atomic `runBatch`.
- `createdBy`/`actorUserId` are deliberately NOT swept — those rows (audit log,
  monitors, quarantine) must outlive the user as an opaque historical label.
- `deleteUser.enabled: true` — a dormant hook wouldn't close the gap. This
  activates self-service account deletion, made safe by the sole-owner guard.
  **Flag for review:** this is a new user-facing capability; flip `enabled` back
  to `false` if account self-deletion isn't wanted yet (the guard + cleanup logic
  stays ready to use).
- No schema change — the real-FK variant (option A in the plan) was NOT added,
  pending the fresh-boot ordering check against void/auth's table bootstrap.

### Phase 3 — integrity FKs, dead weight, overflow fix (structural items)

Migration `20260703235606`:

- **Real `SET NULL` FKs** for `runs.monitorId → monitors.id` and
  `monitorExecutions.runId → runs.id`. The old "logical FK to avoid a cascade
  cycle" rationale was disproven — no cycle exists (`monitors` references only
  `teams`/`projects`) — and `SET NULL` is exactly the semantics the comments
  described wanting. **[data]** dangling values are nulled before the constraint
  is added (`NOT EXISTS` precondition).
- **`artifacts.sizeBytes` → `bigint`** — it was `integer` (2.1 GB) while the cap
  is env-configurable via `WRIGHTFUL_MAX_ARTIFACT_BYTES`; a >2 GiB cap overflowed
  int4.
- **Dropped `usageCounters.testResultsCount`** — a half-alive column (never
  bumped on the hot path, never read by the usage page, only re-based by the
  cron). `src/lib/usage.ts` cleaned up: removed from `UsageDelta`,
  `usageBumpStatement`, `checkQuota` (the `testResults` dimension now derives via
  `countTeamTestResults` if ever asked), and `reconcileUsage`.
- **Dropped `runs_project_monitor_created_at_idx`** — self-documented "pure write
  amplification" for a feature that never landed.
- **Retention CHECK** on `teams` (`retentionArtifactDays ≤ retentionTestResultsDays`,
  both-set case) — closes the seed-script/admin-tool gap the settings action
  can't. Partial by design (a CHECK can't see the env-default a NULL falls back
  to), so the settings-action validation stays load-bearing.

### Phase 3 (jsonb) — text → jsonb for the JSON-blob columns

Migration `20260704002439` converts `monitors.alertTargets` / `config` /
`retryConfig`, `monitorExecutions.resultDetail`, and `auditLog.metadata` from
`text` to `jsonb`. The driver now hands back parsed objects and accepts objects
on write, so every `JSON.stringify` (write) and `JSON.parse` (read) around these
columns is gone:

- **Writes** store the object directly: `monitors-repo.ts` (config + resultDetail),
  `setMonitorAlertTargets` (signature `string` → `AlertTargets | null`),
  `audit.ts` `buildAuditRow` (metadata). `serializeAlertTargets` and
  `serializeMetadata` were deleted (identity now).
- **Reads** validate the already-parsed value: the four Zod parsers in
  `monitor-schemas.ts` (`parseHttp/TcpMonitorConfig`, `parseHttp/TcpResultDetail`)
  and `parseAlertTargets` / audit `parseMetadata` take `unknown` and drop the
  `JSON.parse`. `alertTargets`/`metadata` carry a `$type`; the polymorphic
  `config`/`resultDetail` stay untyped and are narrowed by the parsers.
- **[data]** the migration is hand-augmented with `USING "col"::jsonb` on each
  `SET DATA TYPE` (drizzle-kit emits a bare cast that fails on non-empty text).
  These columns only ever held `JSON.stringify` output or NULL, so the cast is
  lossless — validated on real Postgres with seeded text-JSON rows (below).

Deferred from Phase 3 (documented, protects the live org):

- **Status CHECKs** (`runs.status`, `testResults.status`, `monitorExecutions.state`).
  The DB vocabulary is a SUPERSET of the wire enum — `testResults.status` also
  holds `queued`, `runs.status` holds `running`, `monitorExecutions.state` holds
  `queued`/`running`/`degraded`. Freezing these risks rejecting a valid
  production write for the live org, for the lowest-value item, and contradicts
  the repo's documented `text + $type` union stance. Enumerated supersets for a
  future change: runs `{running,passed,failed,flaky,skipped,timedout,interrupted}`;
  testResults `{queued,passed,failed,flaky,skipped,timedout}`; state
  `{queued,running,pass,degraded,fail,error}`.
- **Reserved-column drops** (`testOwners.source`, `monitors.schedulingStrategy`/
  `retryConfig`). `source` has a column-vs-resolved-tag ambiguity in
  `owners-repo.ts` and the monitor fields touch several test files; lowest-value,
  deferred to avoid entangling them with the safe structural changes.

### Phase 4 — NOT NULL tightening

Migration `20260703234617`: `runs.lastActivityAt` and `testResults.updatedAt` →
NOT NULL, each preceded by a **[data]** backfill `UPDATE … = "createdAt" WHERE …
IS NULL` (the exact value the `coalesce` readers assumed). `staleRunFilter`
(`src/lib/scope.ts`) drops its `coalesce(lastActivityAt, createdAt)` for a direct
compare.

### Phase 6 — partitioning ADR

`docs/adr/0004-testresults-retention-partitioning.md`: records the **defer**
decision for `testResults` range-partitioning (keep DELETE-based retention) with
concrete revisit triggers, plus the **keep epoch-seconds timestamps** decision so
neither resurfaces.

## Details

| Migration                             | Phase | Contents                                                                                                     |
| ------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------ |
| `20260703233922_unique_vapor`         | 1     | `tests` table + indexes; drop testResults trigram indexes; **catalog backfill**                              |
| `20260703234617_brief_marvex`         | 4     | **backfill** lastActivityAt/updatedAt; SET NOT NULL                                                          |
| `20260703235606_mixed_the_fury`       | 3     | drop dead index; sizeBytes→bigint; **null danglers**; 2 SET NULL FKs; drop testResultsCount; retention CHECK |
| `20260704002439_romantic_dragon_lord` | 3     | text→jsonb (5 columns) with **`USING ::jsonb`** casts                                                        |

New: `src/lib/user-teardown.ts`, `docs/adr/0004-*.md`, `docs/schema-rework-plan.md`.

## Verification

- **`vp check`**: format + typecheck clean on all changed files. (One pre-existing
  type-aware lint warning in `src/lib/error-cause.ts:39` — unmodified by this
  work, unrelated to it.)
- **Tests**: node lane 241 passed / 4 skipped; workers lane 1131 passed. Added
  pg-integration coverage for the catalog upsert (insert / latest-wins / in-batch
  dedup), user-teardown (sole-owner guard / cleanup isolation), and a **jsonb
  round-trip** (object in → object out for `resultDetail` + `metadata`, catching
  any double-encoding). Updated the monitor/audit unit tests + executor fixtures
  to the object-based contract (the failing http/tcp-run tests were exactly the
  "tests catch it" signal — fixtures were still passing stringified config).
- **Migration chain on real Postgres 16** (not just pglite): all 9 migrations
  apply cleanly in order. Seeded a pre-change DB and confirmed each backfill with
  data — catalog latest-wins (`title`/`file` from the newest run, `firstSeenAt`=min,
  `lastSeenAt`=max), NOT NULL backfill (NULLs → `createdAt`, constraint holds),
  dangling `monitorId` nulled before its FK, retention CHECK + FKs present, and
  the **`USING ::jsonb` cast on real text-JSON rows** (`config`/`alertTargets`/
  `metadata`/`resultDetail` become jsonb with every value preserved + queryable).

## Follow-ups

1. Status CHECKs — only if wanted, using the enumerated supersets above.
2. Reserved-column drops (`testOwners.source`, monitor `schedulingStrategy`/`retryConfig`).
3. Decide whether to keep `deleteUser.enabled: true` (self-service account deletion).
4. Before each deploy: rehearse the migration against a branch/copy of the
   production DB (Neon branching or `pg_dump` restore), per the plan.
