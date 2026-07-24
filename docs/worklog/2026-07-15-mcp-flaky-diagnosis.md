# 2026-07-15 — MCP flaky-test diagnosis

## What changed

The Wrightful MCP server now has a higher-level flaky-test investigation
surface, built entirely from existing Postgres data:

- `diagnose_flaky_tests` keeps the dashboard's shared `rankFlakyTests`
  ordering, then returns explicit sample/retry/hard-failure counters, grouped
  normalized error signatures, representative flaky/failed/passed result ids,
  same-run co-failures, and each test's status in the latest completed CI run.
- `get_test_history` accepts exactly one stable `test_id`, exact spec `file`,
  or free-text `query` and returns a newest-first commit-to-attempt timeline.
  Free-text resolution uses the project-scoped, trigram-indexed `tests`
  catalog; attempts contain status/duration summaries only.
- `list_flaky_tests` now labels its flake-rate semantics, and
  `get_test_result` exposes the already-stored `workerIndex`.
- MCP flow instructions route proactive flake hunting to the diagnosis tool,
  known tests/files to history, and retain `list_flaky_tests` as the cheaper
  ranking-only call.

`src/lib/error-signature.ts` owns the pure fingerprint normalization:
ANSI stripping, first-meaningful-line selection, volatile value masking,
whitespace normalization, and a bounded output length.

## Query and tenancy decisions

No schema, migration, reporter, or ingest change was needed. The diagnosis
read is bounded on every axis: a 5,000-row window budget split across the
selected tests, at most 500 rows per test (the full 500 at the default
`limit: 10`), error text fetched as a 2,048-char
`left(coalesce(nullif(trim(errorMessage), ''), errorStack), …)` head (blank
messages fall back to the stack; signatures only use the first meaningful
line, and ingest allows 64/128 KB messages/stacks, which must not be pulled
whole into a Worker), and co-failure analysis bounded to 200 flaky runs
(budgeted per test, newest first, so one high-volume test cannot starve the
others) and 5,000 failure rows (budgeted per run, so one mass-failure run
cannot starve the other budgeted runs), and at most 10 signature groups
returned per test (`distinctSignatures` reports the uncapped total). Sampling is
disclosed: each dossier reports `analyzedRows` and `coFailureRunsAnalyzed`,
while the counters and the representative result ids always cover the full
window (representatives come from a dedicated latest-per-(test, status)
`distinct on` read, so a high-volume test's newest flaky occurrence cannot
fall out of the sample). History reports `matchedTestsTruncated` when a
file/query selector matches more than 50 catalog tests; the `file` selector
deliberately matches the test's current cataloged path (resolving historical
paths would mean unindexed fact-table scans — `query` covers fuzzy needs). `get_test_history` resolves its selector as a
discriminated `{ kind, value }` union built by the tool layer's
exactly-one-non-blank validation, and resolves all selector kinds through the
`tests` catalog (ingest catalogs every test atomically with its results).
Every new fact-table read filters the branded child `projectId`; joined run
reads also apply the branded `(teamId, projectId)` scope and exclude synthetic
monitor traffic through the canonical CI join/scope helpers.

The shared flaky ranking gained a hard-failure counter projection so diagnosis
can report `failed`/`timedout` accurately without treating queued rows as hard
failures. Its rank formula and ordering are unchanged, preserving dashboard/MCP
parity.

## Verification

- `pnpm --filter @wrightful/dashboard typecheck`
- `pnpm --filter @wrightful/dashboard test` — Node lane: 606 passed / 4
  skipped; Workers lane: 1,340 passed
- `pnpm --filter @wrightful/dashboard exec vitest run src/__tests__/pg-integration/mcp-diagnose.test.ts`
  — 2 passed locally on pglite
- `pnpm check` — 0 errors (139 existing warnings)

The Postgres integration suite runs on pglite locally and the same file runs
against node-postgres under `PG_TEST_URL` in CI, covering numeric result
coercion as well as identifier/query compatibility.
