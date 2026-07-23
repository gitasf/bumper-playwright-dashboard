# 2026-07-05 — Capture per-attempt stdout/stderr (reporter → ingest → MCP)

## What changed

Test `stdout`/`stderr` was never captured, so `console.log`-style CI debugging
was invisible to the dashboard and the MCP read surface. This change captures
each Playwright attempt's stdout/stderr in the reporter, ingests it into two new
nullable text columns on `testResultAttempts`, and surfaces it per-attempt via
the `get_test_result` MCP tool (and the shared test-detail children loader).

This is a self-contained change: `src/lib/mcp/queries.ts` is **not edited here**
— `loadMcpTestResultDetail` already passes `children.attempts` straight through,
so surfacing the new columns required only extending the
`test-result-children.ts` SELECT.

### Corrected premise

An earlier research pass wrongly claimed Playwright doesn't expose test
stdout/stderr. It does: `TestResult.stdout` / `TestResult.stderr` are
`Array<string | Buffer>`, fully populated at `onTestEnd` (verified in
`playwright@1.61.1/types/testReporter.d.ts`, `stdout` ~L705 / `stderr` ~L700).
We read those arrays at `onTestEnd` — **no** custom reporter, seam, or
`onStdOut`/`onStdErr` streaming.

## Details

| Area                                                                    | Change                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/reporter/src/limits.ts`                                       | New `joinStdio(chunks, max)` — decode `Buffer` chunks as UTF-8, join in emission order, truncate to `max`, `null` when empty.                                                                                                                       |
| `packages/reporter/src/types.ts`                                        | `TestAttemptPayload` gains `stdout: string \| null` / `stderr: string \| null` (always emitted, `null`-when-absent, mirroring `errorMessage`/`errorStack`).                                                                                         |
| `packages/reporter/src/payload.ts`                                      | `AttemptInput` + `buildAttempt` (seeder builder) carry/emit `stdout`/`stderr` (truncated to `MAX_MESSAGE`, default `null`).                                                                                                                         |
| `packages/reporter/src/index.ts`                                        | Live `buildPayload` attempt loop joins `r.stdout` / `r.stderr` via `joinStdio(…, MAX_MESSAGE)`.                                                                                                                                                     |
| `apps/dashboard/src/lib/schemas.ts`                                     | `TestAttemptSchema` gains `stdout`/`stderr` as `truncatedText(MAX.MESSAGE)` (nullable + optional — server-side truncation prevents oversized batches from 413ing; optional keeps pre-capture reporters parsing clean).                              |
| `apps/dashboard/db/schema.ts`                                           | `testResultAttempts` gains two nullable `text()` columns `stdout`/`stderr` (NOT indexed — never filtered/joined on).                                                                                                                                |
| `apps/dashboard/db/migrations/20260705153048_overconfident_mach_iv.sql` | Generated migration: `ADD COLUMN "stdout" text` + `ADD COLUMN "stderr" text`.                                                                                                                                                                       |
| `apps/dashboard/src/lib/ingest.ts`                                      | `buildResultInsertStatements` `attemptRows` shape + populate from `attempt.stdout ?? null` / `attempt.stderr ?? null`. The chunked insert picks up the columns automatically; `resultUpsertSet()` unchanged (logs are per-attempt, not aggregated). |
| `apps/dashboard/src/lib/test-result-children.ts`                        | `loadTestResultChildren` SELECTs `stdout`/`stderr` per attempt, so `get_test_result` (via `loadMcpTestResultDetail`) and the test-detail page surface them.                                                                                         |

### Sizing decision

Each log is capped at `MAX.MESSAGE` (65536 chars), truncated (surrogate-pair
safe) and stored **inline** in the TEXT columns. Attempts per test are few
(1–10) and the wire schema truncates, so there is no R2 spillover and no new cap
constant — logs share the existing `MAX.MESSAGE` cap with error messages.

### Wire-contract sync

The reporter interface (`types.ts`) and the dashboard Zod schema
(`schemas.ts`) are kept in step by `packages/reporter/src/__tests__/contract.test.ts` —
its structural-equivalence canary compares the emitted `TestAttemptPayload` key
set against `TestAttemptSchema`'s declared keys, so a one-sided add on either
side fails the build. Emitting `stdout`/`stderr` always (as `null` when empty)
keeps that key set exact.

## Tests

- **Reporter — `joinStdio` unit** (`packages/reporter/src/__tests__/limits.test.ts`, new):
  mixed string + `Buffer` chunks decode + join in order; missing/empty/all-empty
  → `null`; multi-byte UTF-8 decodes without mojibake; over-cap joins truncate to
  `MAX_MESSAGE`.
- **Reporter — live path** (`contract.test.ts`, new block): `buildPayload` joins
  mixed string + `Buffer` stdout/stderr per attempt, emits `null` for a quiet
  attempt, clamps an over-cap stream to `MAX.MESSAGE`, keeps per-attempt logs
  distinct across a flaky test's retries — and each still parses through
  `AppendResultsPayloadSchema`.
- **Reporter — builders** (`payload.test.ts`): `buildAttempt` fills/preserves/
  truncates `stdout`/`stderr`; the existing exact-equality attempt assertions
  (here + `aggregation.test.ts`, `batcher.test.ts`, `quarantine.test.ts`) updated
  for the two new `null` keys.
- **Dashboard — ingest persist + MCP read-back**
  (`apps/dashboard/src/__tests__/pg-integration.test.ts`, new test in the
  "ingest /results upsert" block): flushes a flaky result whose two attempts carry
  distinct stdout/stderr through `buildResultInsertStatements` against real
  Postgres (pglite lane locally, node-postgres in CI), asserts the raw columns
  persist per-attempt (including a `null` for a quiet retry), then asserts
  `loadTestResultChildren` (the exact loader `get_test_result` returns) reads them
  back in attempt order.

## Verification

- `pnpm --filter @wrightful/reporter test` → **290 passed** (17 files).
- `pnpm --filter @wrightful/dashboard test` → **248 passed / 4 skipped** (default env)
  - **1184 passed** (workers env).
- `pnpm check` (oxfmt + oxlint + type-aware typecheck) → **0 errors** (128
  pre-existing warnings in unrelated files, none introduced here).
- Migration generated cleanly (`db:generate`) — exactly the two `ADD COLUMN`
  statements, no schema drift.

## Notes / deviations

- The brief pointed at `payload.ts buildAttempt` as the truncation site; the
  **live** capture site is `index.ts buildPayload`'s attempt loop (that's where
  the Playwright `TestResult` is in scope). `buildAttempt` is the seeder-facing
  builder — it also emits the fields (from already-string input) so the contract
  canary's key-set stays exact. The join/decode helper `joinStdio` lives in
  `limits.ts` next to the other text-clamp helpers and is used by the live path.
- `src/lib/mcp/queries.ts` was **not** modified (coordination note honored) — the
  surfacing rides entirely on the `test-result-children.ts` SELECT.
- `docs/api/mcp.md` intentionally **not** edited (orchestrator integrates docs).
- The test-detail UI (optional per the brief) is left as a follow-up; the data is
  now available to that loader via `loadTestResultChildren`.
