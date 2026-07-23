# 2026-07-16 → 2026-07-20 — Architecture review + platform hardening (PR #58)

Consolidated record of the platform-hardening pass and its four PR-review
follow-up rounds (commits `d71eb74` → `1cd863b`). Replaces the eleven
per-workstream/per-round worklogs previously in this directory; organized by
subsystem, with each area's final (post-review) state.

## Background work: scheduler, billing, retention, provisioning

- **Monitor scheduler** (`src/lib/monitors/scheduler.ts`): due monitors are
  claimed via a compare-and-swap re-arm (`monitorReArmCasWhere`: id + enabled +
  `nextRunAt <= now`, `.returning()`), and the execution insert shares the SAME
  transaction as its claim — overlapping sweeps can't double-fire, and a crash
  can't advance `nextRunAt` without a queued execution. Failed queue sends are
  logged with `logger.error` (execution/monitor/reason) and the execution is
  flipped to terminal `error` (guarded on `state='queued'`), so a dropped
  enqueue can't blind a monitor until the stale reaper.
- **Billing reconcile** (`src/lib/billing/reconcile.ts`): bounded to
  `WRIGHTFUL_BILLING_RECONCILE_BATCH_SIZE` (default 500) with
  `order by random()` rotation so the tail always heals. Kept `random()` over a
  keyset cursor deliberately: the scanned set is Polar-LINKED teams (bounded by
  paying customers) and the sort is a top-k heap on a weekly cron; the
  doc-comment records the evolution path.
- **Retention** (`src/lib/retention.ts`): projects whose sweep freed nothing
  join an in-invocation idle set and are never re-probed — probe cost O(projects)
  per invocation instead of O(projects × rounds).
- **First-team bootstrap** (`src/lib/provisioning.ts`): the zero-teams team
  creation path is gated behind `WRIGHTFUL_BOOTSTRAP_FIRST_TEAM` (default off) so
  an anonymous stranger can't claim a fresh instance; SELF-HOSTING.md documents
  the enable → create → disable window. Policy check and team insert are
  serialized by a transaction-scoped Postgres advisory lock used by every team
  creation path.
- **Deferred (needs schema)**: `claimExecution` can re-run a settled REAL-error
  execution on duplicate queue delivery; the clean fix is a
  `monitorExecutions.infraError` column so the claim only re-admits infra
  errors. Named in a comment at the CAS site.

## Schema indexes, invites, quarantine

- **Indexes** (migration `20260717080140_clean_psynapse.sql`, the PR's only
  schema change — index-only): `monitorExecutions_runId_idx` (partial,
  `WHERE runId IS NOT NULL`) and `runShards_runId_idx`, so run-deletion cascades
  stop seq-scanning FK children. Plain `CREATE INDEX` (not `CONCURRENTLY`) —
  drizzle-kit migrations run in a transaction; build one manually out-of-band if
  these tables ever grow large. `userState.lastTeamId/lastProjectId` analogs
  deliberately skipped (hot-path write amplification for a rare cheap scan;
  documented in `db/schema.ts`).
- **Invite accept race** (`src/lib/invites.ts`): validate-and-consume is a
  `DELETE … RETURNING` (re-checking expiry + addressee) inside the same
  transaction as the membership insert; a concurrent duplicate membership
  (23505) is treated as idempotent success. Expired invites are GC'd by
  `sweepExpiredInvites` via the new `crons/sweep-invites.ts` (`15 4 * * *` —
  cron expressions must be unique; Void dispatches on `controller.cron`).
- **Quarantine** (`src/lib/quarantine-repo.ts`): the upsert updates only
  `reason`/`mode`, preserving `createdAt`/`createdBy` provenance.
- **Project teardown**: deletion predicates scope by BOTH `teamId` and
  `projectId`; R2 cleanup is scheduled only after the row delete commits.

## Ingest contract + quota enforcement

- **Atomic quota gates** (`src/lib/usage.ts`): `usageGuardedBumpStatement` is a
  single gate+increment upsert (`setWhere: col + delta <= limit`,
  `.returning()`; empty → overshoot) used by run opens and artifact registration
  inside their write transactions — closes the `checkQuota` read-then-gate
  TOCTOU. First inserts are guarded too (an over-limit delta can't seed a
  missing counter row).
- **Usage reconciliation**: the daily rollup runs at repeatable-read, snapshots
  the live counters, repairs stale overcounts DOWNWARD, and carries only
  post-snapshot increments onto the authoritative aggregates — concurrent bumps
  survive without making drift permanent.
- **Per-run row ceiling** (`WRIGHTFUL_MAX_TEST_RESULTS_PER_RUN`, default
  500,000; 0 disables): enforced in `appendRunResults` UNDER the per-run
  `FOR UPDATE` lock using the projected distinct-row delta (413
  `rowCapExceeded`), and at open — a fresh `openRun` whose planned-test set
  exceeds the ceiling throws `RunRowCapExceededError` before any write
  (`/api/runs` maps it to the same 413), since the schema's
  `MAX_PLANNED_TESTS` (100k) can exceed a lower configured cap.
- **Wire contract**: the reporter clamps `batchSize` and truncates
  `plannedTests` to the dashboard caps (constants exported from `schemas.ts`,
  pinned by the reporter contract test); duplicate attempt indices and shard
  `index > total` are 400s at validation.
- **Sharded completion**: the run-side `expectedShards` wins over the payload
  (a mixed-version fleet can't legacy-finalize while siblings stream);
  `/complete` shard metadata must agree with the authoritative total
  (`invalidShard` otherwise); an anonymous complete is a liveness bump only.
- **Terminal re-run reset** (`reopenRunForWrites` / `applyShardExpectedTests`):
  a duplicate open of a TERMINAL run (deterministic CI re-run reusing the
  idempotency key) resets stale shard state. A shardless re-open clears
  `expectedShards`/`shardExpectedTests` and deletes `runShards` rows so the
  legacy finalize path applies; a sharded re-open restarts the expected-tests
  map from `'{}'`, replaces `expectedShards`, deletes every previous completion
  row, and re-arms the run as in-flight (`status='running'`,
  `completedAt=null`). Exactly-once under racing sibling opens via the run-row
  `FOR UPDATE` lock (same lock order as `completeShardedRun`); the terminal
  check is evaluated in SQL so a mid-flight duplicate open can't wipe a sibling
  shard's backfill. Accepted trade-off: a duplicate open delayed past finalize
  re-arms the run for the watchdog — requires the idempotency key, and beats
  mixing stale and fresh shard results.

## Security, rate limiting, API posture

- **Rate limits** (`middleware/03.rate-limit.ts`): the cookie-authed
  `/api/t/:team/p/:project/*` family (incl. CSV export) is throttled under the
  query limiter, keyed by client IP (`isTenantApiRoute` in
  `src/lib/ingest-routes.ts`, disjoint from the Bearer surfaces). The artifact
  download limiter keys on `${clientIp}:${artifactId}` so a guessed id can't
  starve other viewers.
- **GitHub webhook replay** (`src/lib/github-http.ts`): `installation.deleted`
  dedups on `X-GitHub-Delivery` via the Workers Cache API — the read is a check
  only; the marker is written AFTER the delete succeeds, and Cache API failures
  log (`logger.warn`) and fail open. Per-colo/best-effort is acceptable:
  re-deletion is idempotent and GitHub never reuses installation ids.
- **MCP OAuth scopes** are captured but intentionally unenforced (every tool is
  read-only + membership-checked); comments at both seams say a future mutating
  tool must gate on scopes in `registerScopedTool`.
- **Leak-safe 404s**: the JSON tenant/settings routes answer 404 (not 403) when
  the caller can't be confirmed entitled to know the resource exists.

## Trace-viewer origin isolation (snapshot XSS hardening)

The embedded replay viewer rendered attacker-craftable DOM snapshots (trace zip
bytes, mintable with any ingest key) in a same-origin iframe with
`allow-same-origin allow-scripts` — which neutralizes the sandbox, leaving the
vendored Playwright SW sanitizer as a single point of failure for stored XSS.

- **Safe same-origin default**: `snapshotSandbox()` drops `allow-scripts`
  unless the viewer runs on a genuinely different origin, and
  `/trace-viewer/snapshot/*` gets a `script-src 'none'` CSP
  (`middleware/00.defensive-headers.ts`). The strict CSP is keyed on
  `isTraceViewerHost` — it applies on EVERY serving origin except the
  configured cookieless viewer host itself, so the dashboard-hosted snapshot
  scope (the same Worker serves both hostnames) can never hand
  attacker-craftable snapshot HTML a scripting CSP under the session origin,
  configured or not. Cost of the default: snapshot fidelity scripts
  (scroll/canvas/point marker) don't run; static DOM still renders.
- **Configurable cookieless origin**: `VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN`
  (declared in `env.ts`, read through `void/env`, normalized to an http(s)
  origin — malformed/same-origin/unavailable fail closed to same-origin mode).
  `src/trace-viewer/origin.ts` is the single source of truth for origin-aware
  URLs, the non-wildcard postMessage bridge origin, and the sandbox decision.
  The snapshot iframe mounts only after the page origin is known, so the first
  document load carries the final sandbox. The artifact download route's CORS
  allow-list echoes the configured viewer origin (bridge fetches of signed
  trace URLs are cross-origin there).
- **Deploy-side halves (documented in SELF-HOSTING.md, not automatable
  in-repo)**: the second hostname bound to the same Worker; the
  `frame-ancestors 'self' <dashboard-origin>` allowance on the viewer origin
  (the framed documents are static assets whose headers the worker middleware
  never stamps — the app keeps `frame-ancestors 'self'` and fails closed);
  under direct-R2, the bucket CORS `AllowedOrigins` must include the viewer
  origin.
- `playwright-core` is a security-relevant pin (`sw.bundle.js` is the snapshot
  sanitizer); `scripts/sync-trace-vendor.mjs` carries the warning.

## Frontend, tooling, E2E fixtures

- `src/lib/page-loader.ts` (`pageProjectFields`, `deferredNoStore`) dedupes the
  deferred-loader boilerplate across the six analytics loaders; the flaky
  loader's int8 `createdAt` is cast per the repo convention so node-postgres
  and pglite agree.
- Root deploy script renamed to `deploy:void` — pnpm's built-in `deploy`
  shadowed the script, so the documented command silently didn't run
  `void deploy`.
- E2E fixture (`packages/e2e/src/dashboard-fixture.ts`): async teardown awaits
  process-group exit with SIGKILL escalation; a suffix-agnostic
  `.env.local.lock` plus stray-backup scan makes the two preview suites
  mutually exclusive locally; `.env.local` is restored before the lock
  releases. Follow-up left open: the demo suite still targets the external
  `playwright.dev`.

## Verification (final state)

- `pnpm check` (= `vp check`: format + lint + typecheck) — 0 errors, 143
  pre-existing warnings; the Vite+ pre-commit hook ran on every commit (no
  `--no-verify`).
- `pnpm test` — dashboard node lane 668 passed / 4 skipped, dashboard workers
  lane 1371 passed (= `vp test run && vp test run -c
vitest.workers.config.ts`), reporter 304 passed. New/extended suites cover
  the scheduler CAS, invite races (real pglite), quota guards (first-write and
  concurrent), row caps (open, crossing, and racing appends), terminal re-run
  resets, download-route CORS, tenant context, project teardown scoping, and
  webhook replay.
- Full-stack pass on the hardening commit: `pnpm build`, `pnpm test:e2e`
  (29 passed against a production preview + PostgreSQL 16), and the canonical
  dashboard Playwright suite (51 passed / 1 skipped).
- Still requiring a real two-hostname deployment to verify: the separate-origin
  trace-viewer path end-to-end (DNS/routing, framing headers, SW registration,
  cookie isolation, postMessage handshake).
