# 2026-07-23 — Dashboard downstream review remediation

## Why

A line-by-line review of the downstream dashboard merge exposed several places
where behavior was correct only on the happy path: a completed idempotency key
could reopen stale results, matrix jobs could collide, a sticky GitHub comment
could suppress a same-run recompletion, pagination conflated null and empty
group keys, and several related database writes were not atomic.

The same review found E2E synchronization, trace-viewer resilience, accessibility,
and oversized-module problems worth fixing before carrying the dashboard changes
downstream.

## What changed

### Run identity and lifecycle

- Reporter-generated execution keys now include the GitHub run attempt, the
  selected Playwright project set, and an optional `WRIGHTFUL_MATRIX_KEY`.
  Native shards continue to converge on one run while independently sharded
  browser-project jobs remain distinct.
- Ambiguous GitHub native-shard reruns fail closed unless the workflow supplies
  one fresh explicit key to the complete shard set. GitLab uses its changing job
  id for non-sharded retries and documents the provider's lack of a shared retry
  generation for individually retried native shards.
- An explicit `WRIGHTFUL_IDEMPOTENCY_KEY` remains authoritative, but the public
  contract now requires a distinct key for every new execution.
- Opening an already-terminal key returns a conflict instead of rearming or
  mutating its run. Late writes addressed by `runId` still use the existing
  bounded write grace.
- Run-quota enforcement resolves an existing idempotency key before rejecting
  a full monthly counter. A retry or late shard at the exact limit succeeds,
  while every new run still goes through the transaction's guarded usage bump.
- Native shards no longer post shard-local PR comments; the GitHub App owns the
  aggregate surface. Non-sharded local comments use workflow/job/project/matrix
  scoped markers, including a credential-derived project discriminator when an
  older dashboard omits `runUrl`. Sticky surfaces may repost the same run after
  recompletion, while older runs remain unable to overwrite newer ones.

### Query and UI correctness

- Group cursors encode null project names separately from empty strings.
- Slowest-test KPIs are computed over the full filtered window rather than the
  current page, sharing the table's ranking query rather than ranking twice.
- All monitor types use real 24-hour, 7-day, and 30-day uptime windows; only the
  HTTP response-time series remains type-specific.
- Usage-meter colors, trace image failures, bounded JSON/source previews, and
  keyboard-operable split panes now match their semantics.
- Trace JSON previews cap both top-level and nested property names, preserving
  distinct long keys with deterministic collision suffixes instead of copying
  unbounded names or silently merging them.
- Artifact GET/HEAD conditions distinguish cache validation (`304`) from failed
  write preconditions (`412`), including conditional HEAD requests.

### Transaction boundaries

- Token invite consumption and membership creation share one transaction.
- Group create/update and complete membership replacement are atomic. Member
  removal deletes group links in the same transaction; group writes serialize
  against removal, and reads exclude exceptional logical-FK orphans.
- Team-owned child mutations take a shared parent-first lock before any invite,
  group, project, or monitor row lock. Whole-team teardown takes the conflicting
  parent update lock, snapshots cleanup jobs, and deletes only the parent,
  relying on FK cascades; this removes the cross-resource deadlock cycle and
  redundant explicit child deletes.
- The pre-teardown team audit write was removed: a successful delete always
  cascaded it away, while a failed delete left behind a false deletion event.
- Monitor quota checks serialize on the team parent and then the owning project
  row before insertion.
- Project deletion, its surviving audit record, and an FK-free R2-cleanup outbox
  row commit together. Team deletion inserts the same outbox rows in its atomic
  teardown batch. Team deletion dispatches only one eager `waitUntil` cleanup
  pass so a large project fanout cannot exhaust a Worker's R2 subrequest budget;
  untouched jobs remain immediately due for the offset five-minute cron. The
  cron also retries transient failures and prefixes larger than one Worker's
  page budget. Direct-PUT signing holds the same parent-first locks as teardown,
  and cleanup timestamps are sampled only after the conflicting teardown lock
  lands, so every issued capability is covered by the final verification pass.
  Lease-losing workers report a superseded outcome instead of corrupting sweep
  counters or logging a failure they no longer own.
- Direct-R2 PUT capabilities are minted while holding team-to-project
  key-share locks. Teardown samples each cleanup job's capability cutoff only
  after acquiring the conflicting lock, so every returned URL expires before
  the job may finalize; a registration that loses the race returns not-found
  instead of emitting a URL for deleted rows.
- Team deletion no longer writes a team-scoped audit row that necessarily
  cascades on success and misleadingly survives a failed teardown. Durable
  deletion audit would require a separate non-cascading sink.

### Reliability and structure

- Monitor-scheduler E2E coordination now uses `proper-lockfile`, its consuming
  specs have a timeout above the lease-plus-action envelope, and global setup
  always closes its Playwright context and browser.
- Embedded trace loading waits for a controlling service worker and separates
  startup from post-ready progress deadlines. The replay E2E asserts one strict
  successful load instead of accepting terminal errors and retrying.
- Reporter payload construction, artifact read/response handling, monitor-page
  sections, ingest concerns, and the two oversized test suites were split into
  focused modules.
- Reporter UTF-8 truncation preserves mixed chunk order while decoding only
  bounded string/Buffer prefixes, and duration formatting no longer displays
  `60.0s`.
- Reporter packaging uses a build-only TypeScript scope. Contract tests still
  typecheck in the normal test/check lanes, but declaration generation no
  longer follows their cross-workspace imports and leaves generated `.d.ts`
  files beside dashboard source.

## Compatibility and operations

- Migration `20260724002653_aspiring_iron_lad.sql` adds
  `projectArtifactCleanupJobs`. It intentionally has no team/project foreign
  keys because it must outlive the rows whose R2 prefixes it reclaims.
- `proper-lockfile` is a development-only E2E dependency.
- Existing explicit idempotency keys still work. Callers that intentionally
  reused one key for separate executions must now generate a unique value.
- Complete GitHub native-shard reruns must set one fresh
  `WRIGHTFUL_IDEMPOTENCY_KEY` shared by every shard. GitLab users should retry
  the full pipeline rather than one native shard.
- `WRIGHTFUL_MATRIX_KEY` is needed only for arbitrary CI matrix axes that cannot
  be inferred from the Playwright project set. Use the same value across native
  shards that should aggregate into one run.

## Verification

- Focused dashboard, Postgres integration, reporter, trace-viewer, and E2E
  checks were run while implementing each slice.
- `pnpm test`: dashboard Node 729 passed / 7 skipped, dashboard Workers 1,401
  passed, reporter 326 passed.
- `pnpm check`: 0 errors (the repository's existing warning set remains).
- `pnpm build` passed, and the reporter declaration build left no generated
  files beside dashboard source.
- `void db generate` reported no schema drift.
- Dashboard, reporter, and E2E TypeScript checks passed. Live Postgres
  integration tests and the full-stack E2E harness could not run in this
  sandbox because Postgres is unavailable at `127.0.0.1:5432`.
