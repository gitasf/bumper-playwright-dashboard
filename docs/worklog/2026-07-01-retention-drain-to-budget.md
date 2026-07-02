# 2026-07-01 — Retention sweep: drain-to-budget instead of a fixed per-pass row cap

## What changed

The retention cron (`sweep-retention`) used to delete a **fixed slice** of expired rows per project per pass — `WRIGHTFUL_RETENTION_SWEEP_BATCH_SIZE` (default **200**) `testResults` + 200 artifacts per project, every 6 hours = ~800/project/day. That's a hand-tuned guess that a busy project **silently outpaces**: if a project expires more than ~800 `testResults`/day, the backlog grows and the DB keeps growing past the retention window regardless of how short the window is set. Retention only keeps a DB lean if the sweep keeps _pace_ with ingest.

The fix reworks the sweep to **drain until its execution budget is spent**, not until a fixed row count:

- It keeps deleting chunks (round-robin across projects) until a **wall-clock deadline** OR a **subrequest ceiling** is hit — whichever comes first — or until a full round frees nothing (backlog cleared).
- `WRIGHTFUL_RETENTION_SWEEP_BATCH_SIZE` is now the **per-iteration chunk size** (default raised 200 → **1000**), _not_ a per-invocation cap. Total rows per invocation now scales with the budget.

This means the drain rate tracks what one Cloudflare Workers invocation can actually do, rather than a conservative constant. Because R2 deletes are **bulk** (`DELETE_KEYS_PER_CALL = 1000` keys per call) and a ~1000-row chunk costs only a handful of subrequests, wall-clock is normally the binding limit; the subrequest ceiling is a backstop for a project with a massive artifact backlog.

## Details

| Area                           | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`src/lib/retention.ts`**     | New `SweepBudget` interface + `createSweepBudget({ deadlineAtMs, maxSubrequests, clock })` factory (injectable clock). New pure `drainRetention(projects, sweepOne, budget)` orchestrator — round-robin, stop-on-budget, stop-on-no-progress — mirroring `drainStaleRuns`. `sweepRetention` reworked to `{ now, chunkSize, defaults, budget }` and delegates the loop to `drainRetention`, wiring the real per-project chunk (both axes) + a subrequest estimate. `sweepProjectArtifacts`/`sweepProjectTestResults` unchanged. |
| **`src/lib/artifacts.ts`**     | `DELETE_KEYS_PER_CALL` (R2 bulk-delete cap, 1000) exported so retention charges 1 R2 subrequest per 1000 keys without a drift-prone hardcode.                                                                                                                                                                                                                                                                                                                                                                                  |
| **`crons/sweep-retention.ts`** | Builds a `createSweepBudget` from wall-clock (`Date.now()`) + env, passes `chunkSize` + `budget`. Cron cadence unchanged (every 6h).                                                                                                                                                                                                                                                                                                                                                                                           |
| **`env.ts`**                   | `WRIGHTFUL_RETENTION_SWEEP_BATCH_SIZE` redefined as per-iteration chunk (default 200 → **1000**). New `WRIGHTFUL_RETENTION_SWEEP_BUDGET_MS` (wall-clock budget, default **20000**) and `WRIGHTFUL_RETENTION_SWEEP_MAX_SUBREQUESTS` (subrequest backstop, default **800**).                                                                                                                                                                                                                                                     |

### Why a budget instead of just raising the number

A fixed row cap forces you to _guess_ a number that's simultaneously safe for the smallest deployment and adequate for the busiest — impossible. The real constraint is the **serverless invocation budget** (Workers wall-clock + subrequest cap; each DB query and each _bulk_ R2 delete is a subrequest). Draining to that budget self-tunes to whatever the platform allows and never falls behind ingest until you're genuinely at the platform ceiling — at which point running the cron more often (or raising `_BUDGET_MS`) is the lever. Correctness invariants of the per-project functions (R2-objects-before-rows, cascade-artifact R2 cleanup, per-project scoping) are untouched — only the orchestration loop changed.

### Concurrency / termination

`drainRetention` re-checks the budget between projects (a budget that runs out mid-round stops immediately) and exits when a full round deletes nothing (backlog cleared — don't spin against the remaining budget). The eligible set only shrinks (each chunk deletes what it selects), so the loop always terminates; the budget is the hard upper bound.

## Verification

- `pnpm check` (format + lint + type-aware typecheck, whole repo) — **0 errors** (pre-existing `packages/e2e` warnings only).
- New unit tests in `src/__tests__/retention.workers.test.ts` (14 total): `createSweepBudget` (deadline-exclusive time cutoff; subrequest-ceiling cutoff independent of time) and `drainRetention` (empty project list is a no-op; stops after one idle round; drains across rounds accumulating counts; stops when the budget runs out with work remaining; round-robins every project). Existing `resolveRetentionWindows` / `chunkIdsForInList` tests unchanged.
- Regression: artifacts (node + workers lanes) + pg-integration all pass. `sweepRetention`'s only caller is the cron (updated).

## Follow-ups / notes

- The DB-touching `sweepRetention` (project query + real deletes) is still exercised only by the e2e dogfood suite per the standing real-DB-harness gap; the _new logic_ (the drain loop + budget) is pure and unit-tested here.
- For a very high-volume tenant, the operational levers are now: raise `WRIGHTFUL_RETENTION_SWEEP_BUDGET_MS`, run the cron more frequently, and/or shorten the retention windows — rather than guessing a row cap.
