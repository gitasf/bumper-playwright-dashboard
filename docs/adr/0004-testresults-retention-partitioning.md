# ADR 0004 — `testResults` retention stays DELETE-based; range partitioning is deferred with a documented ceiling

- **Status:** Accepted — decision to **defer** partitioning. Records the durable call so it isn't re-litigated each time `testResults` growth is discussed. Revisit only when a trigger below is hit; a worklog entry is required if/when partitioning lands.
- **Date:** 2026-07-04
- **Deciders:** dashboard team
- **Related:** `docs/schema-rework-plan.md` (Phase 6), `src/lib/retention.ts`, the `sweep-retention` cron.

## Context

`testResults` is the largest, hottest-write table: one row per test per run,
retained for the team's `retentionTestResultsDays` window (env default via
`WRIGHTFUL_RETENTION_TEST_RESULTS_DAYS`). Retention is enforced today by the
`sweep-retention` cron, which runs **budget-bounded `DELETE`s** of rows older
than each project's cutoff (`src/lib/retention.ts`), with the artifact byte
sweep gated to stay ≤ the testResults window so an expiring row's FK cascade
never orphans a still-live R2 object.

`DELETE`-based retention has a known long-run cost profile on Postgres: deleted
rows become dead tuples that only autovacuum reclaims, high-churn windows create
vacuum pressure, and table/index disk does not shrink back without a `VACUUM
FULL` (which locks). At small scale this is a non-issue; at large scale it can
show up as Hyperdrive-visible latency and steadily growing disk.

The structural alternative is **monthly range partitioning** on
`testResults.createdAt`, where retention of a whole month becomes an instant
`DROP PARTITION` (a catalog operation, no dead tuples, disk returned
immediately).

## Decision

**Keep DELETE-based retention. Do not partition now.** The current sweep is
adequate for the near term (the app is early-production, one active org), and
partitioning carries real, permanent complexity that is not yet justified:

- The `(runId, testId)` unique and the primary key must both **include the
  partition key** (`createdAt`) — a partitioned table's unique constraints must
  contain the partition column. That reshapes the table's identity and every
  `ON CONFLICT (runId, testId)` upsert path in `src/lib/ingest.ts`.
- The child tables (`testResultAttempts`, `testTags`, `testAnnotations`,
  `artifacts`) FK-reference `testResults`; FKs **to** a partitioned parent work
  in modern Postgres but the DDL and cascade behavior become something to manage
  by hand.
- **drizzle-kit has no first-class partitioning support**, so the partitioned
  DDL + per-month partition creation/drop becomes hand-authored, out-of-band
  migration code — a standing maintenance surface the rest of the schema avoids.
- Per-team retention windows do **not** align with global monthly partition
  boundaries. `DROP PARTITION` only handles a global floor (the oldest month
  every team has aged past); per-team windows tighter than that still need the
  row-level `DELETE` sweep. So partitioning **augments** the sweep, it doesn't
  replace it — the cron stays either way.

Net: partitioning trades a well-understood, already-shipped mechanism for a
hand-managed one that only partially removes the thing it's meant to remove. Not
worth it until the DELETE cost is actually biting.

## Triggers to revisit (record the number, not a vibe)

Adopt partitioning when **any** of these is observed, not before:

- `testResults` approaches **~100M rows**, or table+index disk becomes a material
  fraction of the instance.
- The `sweep-retention` delete budget **persistently saturates** (a run can't
  clear a window's backlog within its bounded slice, so age keeps growing).
- Autovacuum lag on `testResults` shows up as **Hyperdrive/query latency** in
  production telemetry.

When adopting: partition by month on `createdAt`, keep the row-level sweep for
sub-month per-team windows, and land it as hand-authored migrations with a
worklog entry (drizzle-kit won't generate it).

## Related decision — epoch-seconds timestamps (not `timestamptz`)

Recorded here so it stops resurfacing. `createdAt` / `lastActivityAt` / etc. are
`bigint` epoch-seconds, not `timestamptz`. The Postgres-only migration worklog
(`docs/worklog/2026-06-16-postgres-only.md`) explicitly deferred pg-native types
as "a separate, optional follow-up." **Decision: keep epoch-seconds.** The
convention is consistent, the time-bucketing SQL (`analytics/bucketing-sql.ts`),
the retention math, and every `nowSeconds` write site are built around it, and
the reporter wire contract speaks epoch numbers regardless — switching buys
readability in `psql` at the cost of churn across ingest / analytics / crons with
no functional gain. (Note: if partitioning is ever adopted, `to_timestamp(createdAt)`
range bounds are trivial to express, so this decision does not block that one.)
