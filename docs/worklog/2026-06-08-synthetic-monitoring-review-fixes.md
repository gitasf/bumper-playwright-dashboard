# 2026-06-08 — Synthetic monitoring: code-review fixes

Full code+flow review of the synthetic-monitoring feature, then fixes. Findings
were independently re-validated by an adversarial agent workflow (7 agents,
refute-style) before any change; this records what was confirmed and addressed.

## Findings (validated)

| #   | Finding                                                                                                                      | Verdict                                        | Action                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| 1   | `openRun` never persisted `payload.run.origin` / `monitorId` — every synthetic run stored as `origin='ci'`, `monitorId=null` | **Confirmed, high**                            | Fixed                                           |
| 2   | Monitor mutations gated on `requireTenantContext` (any member) while API-key mgmt is owner-only                              | **Confirmed, medium**                          | Fixed (owner-gated, per product decision)       |
| 3   | `monitorExecutions.attempt` always `0`, never read                                                                           | Confirmed, none                                | No change (reserved scaffolding)                |
| 4   | `recordExecutionResult` bumps `monitors.lastStatus` with no ordering guard                                                   | Confirmed, low                                 | Deferred (cosmetic, self-heals; see follow-ups) |
| 5   | `monitor.source ?? ""` → empty spec → no run → infra-error retry loop                                                        | Refuted as reachable (schema forces non-empty) | Cheap fast-fail guard added anyway              |
| 6   | Per-test `PLAYWRIGHT_TIMEOUT_MS` == whole-suite budget                                                                       | Refuted — intentional layered defense          | No change                                       |

The validation also surfaced **4 issues the original review missed** (see Follow-ups).

## What changed

- **`src/lib/ingest.ts` — the headline bug.** The sole `db.insert(runs)` copied
  ~16 `payload.run.*` fields but not `origin` / `monitorId`, so the columns +
  `runs_project_monitor_created_at_idx` added for synthetic monitoring were
  inert and synthetic runs were indistinguishable from CI. The run-row mapping
  is now a pure `buildRunInsertValues(runId, scope, payload, nowSeconds)` with a
  `runs.$inferInsert` return type (so dropping a column is a compile error, not a
  silent data gap), and it carries the provenance (`origin ?? 'ci'`,
  `monitorId ?? null`). `openRun` wraps it. The call site can't run under the
  vitest harness (live D1), so the pure builder is the regression surface:
  `src/__tests__/build-run-insert-values.test.ts` pins that synthetic provenance
  survives and CI runs default correctly.

- **Owner-gate for monitor mutations.** Product decision: authoring a monitor is
  a greater capability than minting an API key (it mints a per-run ingest key +
  runs user code server-side), so it should match the owner-only API-key page.
  New `requireOwnerTenantContext(c)` in `src/lib/tenant-context.ts` (reuses the
  middleware-resolved active project, 404s non-owners — mirrors the
  `requireOwnedProjectScope` settings seam). All four actions
  (`createMonitor` / `updateMonitor` / `toggleEnabled` / `deleteMonitor`) + the
  create-mode loader now use it; reading stays member-level.
  UI hides every mutation affordance for non-owners (list "New monitor" + empty
  CTA + per-row toggle; detail Pause/Resume + Edit + edit form + danger zone),
  so a member sees a coherent read-only view rather than hitting a 404. The
  `editingOpen = isOwner && editing` guard also keeps the read-only definition
  visible if a member hand-types `?edit=1`.

- **Empty-source fast-fail** (`src/lib/monitors/sandbox-executor.ts`). A browser
  monitor with blank source now returns a terminal `error` (`infraError: false`
  → the consumer acks) _before_ acquiring a container, instead of launching one
  that finds no tests, streams no run, and reads as an infra error retried to the
  dead-letter. Unreachable via the form schemas today (they force non-empty), but
  cheap insurance against a bad direct write / future code path.

## Additional fixes (validation-surfaced, then approved + implemented)

The adversarial validation found 4 issues the original review missed (2 high, 2
medium). All were approved and implemented in the same pass.

- **[high] Stuck-execution reaper.** `monitorExecutions` had no equivalent of the
  runs watchdog, so an execution stranded at `queued` (enqueue send failed) or
  `running` (Worker evicted after the claim, before `recordResult`) leaked
  forever, grew the append-only table, and skewed uptime. Added
  `sweepStaleExecutions` (`monitors-repo.ts`) — selects a bounded
  oldest-first slice of `state IN ('queued','running') AND createdAt < cutoff`
  and flips each to terminal `error` (per-row guard `state IN
('queued','running')` so it can't clobber a row that settled mid-sweep) — driven
  by `crons/sweep-stuck-executions.ts` (every 5 min). New env
  `WRIGHTFUL_MONITOR_EXECUTION_STALE_MINUTES` (default 30, > a full
  retry lifecycle). New index `monitorExecutions_state_created_at_idx` (migration
  `20260608204959_faulty_vulcan.sql`, a single additive `CREATE INDEX`) so the
  reaper seeks the non-terminal slice instead of scanning, mirroring
  `runs_status_lastActivityAt_idx`. The monitor's denormalized `lastStatus` is
  left untouched (reaped rows still show `error` in the timeline/`ExecStrip`; the
  badge stays owned by real executions to avoid regressing a healthy one).

- **[high] Synthetic-key sweeper backstop.** Per-run keys had no expiry and the
  executor's `revokeSyntheticKey` is best-effort, so a Worker eviction mid-run
  left a permanently-valid project-scoped Bearer key. Added
  `sweepStaleSyntheticKeys` (`synthetic-key.ts`) — hard-deletes a bounded slice
  of `synthetic-monitor:*` keys older than the cutoff — driven by
  `crons/sweep-synthetic-keys.ts` (every 5 min). The cutoff reuses
  `WRIGHTFUL_MONITOR_EXECUTION_STALE_MINUTES`: a key that old can't belong to a
  still-running execution (it would itself have been reaped), so the two sweeps
  never disagree about what's in flight.

- **[medium] At-least-once delivery claim (closes the double-run + terminal
  overwrite).** `markExecutionRunning` was an unconditional UPDATE, so concurrent
  queue redelivery could double-run a container and a spurious redelivery of a
  terminal row could overwrite it. Replaced with `claimExecution` — a CAS
  `SET state='running' WHERE id=? AND state IN ('queued','error')` returning
  whether THIS delivery won (`.returning()`). `runMonitorJob` now acks without
  running on a lost claim. The `('queued','error')` set is deliberate: it admits
  a fresh job and a legit infra-retry (which re-enters from `error`) but excludes
  a terminal SUCCESS (`pass`/`fail`/`degraded`), making those rows immutable to a
  redelivery. Dep `markRunning` → `claim` (now `Promise<boolean>`); `executor.test.ts`
  updated + a lost-claim case added.

## Still deferred (documented, low)

- **#4 cross-execution `lastStatus` regression.** The claim makes a terminal row
  immutable, but does NOT cover the distinct case where two _different_
  executions of one monitor overlap (a container overrunning a full interval) and
  the older one records last, regressing the denormalized badge. A correct
  monotonic guard needs a `scheduledFor`-keyed comparison (a naive
  `lastRunAt <= now` guard is wrong-direction, and a `scheduledFor` guard breaks
  the legit same-execution retry-updates-status case without a new
  `lastScheduledFor` column). Left as documented low — cosmetic, self-heals on the
  next tick, and only reachable via a >interval overrun.

## Re-review (round 2) — adversarial pass over the fixes

A second workflow (32 agents: per-area review → per-finding refutation → regression
critic) re-reviewed everything above. It confirmed the fixes are correct (CAS claim,
owner-gate, reaper cutoff, empty-source guard all verified sound) and surfaced one
**critical regression I had introduced** plus a real medium gap. Both fixed:

- **[critical] Cron schedule collision.** Both new reaper crons used `*/5 * * * *`,
  the same expression as the pre-existing `sweep-stuck-runs`. Void's scheduled
  dispatch is `switch (controller.cron) { case <expr>: … return }` (one case per
  cron _expression_ — `node_modules/void/dist/index.mjs:2932-2948`), so duplicate
  expressions collide: only the first by filename order runs. Net effect after
  deploy: `sweep-stuck-executions` would run, **`sweep-stuck-runs` (the existing
  run-watchdog) would silently STOP**, and `sweep-synthetic-keys` would never run.
  Invisible to typecheck/tests (runtime dispatch). Fixed by phase-offsetting the two
  new crons to distinct still-every-5-min expressions — `2-59/5` and `4-59/5` — with
  a do-not-normalize comment on each.

- **[medium] Reserved the `synthetic-monitor:` key-label namespace.** The key sweeper
  identifies its keys solely by label prefix, so a user-created API key labelled
  `synthetic-monitor:*` would be silently hard-deleted after the stale window. The
  owner-only mint route (`routes/api/.../keys.ts`) now rejects that reserved prefix
  (case-insensitively, matching SQLite `LIKE`).

- **[nits, fixed]** Corrected the `buildRunInsertValues` docstring (it overstated
  `$inferInsert` — `origin`/`monitorId` are optional there, so the unit test is the
  real guard); hardened `CreateMonitorSchema.source` to reject whitespace-only at the
  form (was slipping past `.min(1)` to fail later as a wasted execution); made the
  reaper's `reaped` tally count rows actually flipped (via `.returning()`) rather than
  the SELECT size; cross-referenced `MAX_DURATION_SECONDS` ↔ `EXECUTION_STALE_MINUTES`
  so an operator raising one knows to raise the other.

### Still deferred (added by re-review, low)

- **Execution-row retention.** The reaper terminalises stuck rows but nothing prunes
  old _terminal_ `monitorExecutions` rows — they accumulate. This is consistent with
  every other table (`runs`/`testResults`/`artifacts` also grow unbounded; no
  age-based prune exists project-wide), so it's an inherited deferred concern, not a
  regression. Pairs with the two-axis retention already on the roadmap.
- **`sweepStaleExecutions` lacks unit coverage.** Its logic is all IO (SELECT +
  guarded batch UPDATE, no pure decision to extract like `drainStaleRuns`), so it's
  covered only by the e2e happy path. A D1-backed integration test for the
  settled-mid-sweep guard would close it.

## Verification

- `pnpm check` (fmt + lint + type): **0 errors** (90 warnings — unchanged baseline).
- Dashboard vitest: **629 passed**.
- Migration `20260608204959_faulty_vulcan.sql` is a single additive `CREATE INDEX`
  (verified — no destructive drift); journal updated.
- Crons: `sweep-monitors` (`* * * * *`), `sweep-stuck-runs` (`*/5`),
  `sweep-stuck-executions` (`2-59/5`), `sweep-synthetic-keys` (`4-59/5`) — four
  distinct expressions, no `switch`-dispatch collision.
