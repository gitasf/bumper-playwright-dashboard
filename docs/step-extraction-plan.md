# Plan: server-side step extraction at ingest

Status: SCOPED, not implemented. Split out of the 2026-07-10 trace-viewer
work (see `docs/worklog/2026-07-10-custom-trace-viewer-consolidated.md`)
because it touches the ingest path + schema and deserves its own
migration, contract review, and rollout — bundling it into a large UI change
would have made both harder to review.

## Goal

Persist a test's **step tree** (from the trace's `test.trace` file) into
Postgres at ingest time, so:

1. the test-detail page can show an inline step timeline **without opening
   the Replay modal** (no browser SW involved, works for API/MCP consumers);
2. the MCP server can answer "which step failed / how long did each step
   take" without downloading or parsing a zip.

This complements the Replay viewer (full time-travel) rather than
overlapping it.

## Why it's cheap now

- `test.trace` is tiny (~10% of the zip; NDJSON of `before`/`after` pairs
  with `callId`, `parentId`, `title`, `class`/`method`, timestamps,
  attachments, error) and its TypeScript types are already vendored at
  `apps/dashboard/src/trace-viewer/vendor/trace.ts`.
- Zip entries are individually deflate-compressed; Workers have
  `DecompressionStream("deflate-raw")`, so extracting ONE entry needs only:
  read the central directory (last ~64KB of the object via an R2 ranged GET),
  locate `test.trace`, ranged-GET its bytes, inflate, split lines. No zip
  library required; ~100 lines of focused code.

## Design

**Trigger.** After a trace artifact's bytes land in R2 (the
`PUT /api/artifacts/:id/upload` handler completes the R2 write), enqueue a
message on a new `"trace-steps"` Void queue: `{ artifactId, projectId,
teamId }` (IDs only, like the monitors queue). Parsing inline in the upload
request would hold the ingest path hostage to CPU/latency; the queue keeps
ingest fast and gives retries for free. Follow `queues/monitors.ts`'s
thin-adapter pattern (tuning constants in the queue file, pure logic in
`src/lib/steps/`).

**Parsing.** In the consumer: ranged-read `test.trace` from R2 (helper
`src/lib/steps/zip-entry.ts` — central-directory walk + `deflate-raw`),
parse events with the vendored types, fold `before`/`after` pairs into step
rows (same fold the viewer's model does, minus snapshots). Cap: skip
parsing when the zip exceeds `WRIGHTFUL_MAX_ARTIFACT_BYTES` or the step
count exceeds ~1,000 (store a truncation marker).

**Schema.** New tenant table `testSteps` (follows the tenant-table rules —
denormalized `projectId`, every query scoped):

| column                                   | type              | notes                                                                               |
| ---------------------------------------- | ----------------- | ----------------------------------------------------------------------------------- |
| `id`                                     | text PK           | ULID                                                                                |
| `projectId` / `testResultId` / `attempt` | text / text / int | scope + join keys (index on `(projectId, testResultId, attempt)`)                   |
| `callId`                                 | text              | trace-local id                                                                      |
| `parentCallId`                           | text nullable     | tree structure                                                                      |
| `title`                                  | text              | step title (`Expect "toHaveText"`, hook/fixture names)                              |
| `category`                               | text              | `hook` / `fixture` / `pw:api` / `expect` / `test.step` (derived from callId prefix) |
| `startMs` / `durationMs`                 | int               | relative to test start                                                              |
| `error`                                  | text nullable     | step error message (truncated)                                                      |
| `ord`                                    | int               | stable render order                                                                 |

One migration; rows deleted by the existing run-retention cascade (verify
`testResults` FK cascade covers it, mirroring `testResultAttempts`).

**Read surface.**

- Test-detail loader: fetch steps for the displayed attempt, render a
  compact indented timeline (reuse the viewer's action-list row styling) in
  the existing diagnostics tabs.
- MCP: extend `get_test_result` with `steps` (bounded), or a dedicated
  `get_test_steps` tool — decide against the token-budget guidance in
  `docs/api/mcp.md`.
- v1 public API: optional `include=steps` on the test-result endpoint
  (keep out of the default payload; it's per-test bounded but chatty).

**Wire contract.** No reporter changes — the data source is the trace zip
the reporter already uploads. (Alternative rejected: emitting
`TestResult.steps` from the reporter would double-ship the data, grow the
ingest payload, and require a protocol-version bump.)

## Risks / open questions

- **Traces are opt-in.** Steps exist only when tracing is on
  (`retain-on-failure` in the seed). The UI must degrade to "no steps
  recorded" — which it already does by rendering nothing.
- **Format drift.** `test.trace` events ride the same trace-format version
  as the viewer (v8, `vendor/version.ts` guard applies). The parser must
  version-gate exactly like the SW does and skip-not-fail on unknown
  versions.
- **Backfill.** Existing traces in R2 could be backfilled by enqueueing all
  `type='trace'` artifacts once; decide whether it's worth it vs.
  new-runs-only.
- **Queue provisioning.** Managed `void deploy` auto-provisions queues; the
  own-account `deploy:cf` path needs the queue added to
  `wrangler.template.jsonc` (NOT the generated wrangler.jsonc).

## Estimate

Roughly one focused day: ~½ for the zip-entry reader + fold + tests (pure,
node-lane testable with the committed fixture trace), ~½ for queue wiring,
migration, UI timeline, and an e2e assertion piggybacking on the existing
fixture seed.
