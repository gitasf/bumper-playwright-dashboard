# 2026-07-03 — Monitor alerts: gate on real outcomes, not retryable infra errors (P1-3)

## What changed

Fixed a false-alarm class in synthetic-monitor email alerts: a single **retryable
infra error** (sandbox unavailable, token-mint failure, container boot timeout)
used to email every recipient "🔴 down", and the successful retry that followed
then emailed a spurious "✅ recovered" — a full down/recovery pair triggered by
our own infrastructure hiccup, not by the monitored target going down.

Two coordinated changes close it:

1. **`runMonitorJob` (`src/lib/monitors/executor.ts`)** — the alert (`safeAlert`)
   now fires only for a **real** (`!result.infraError`) outcome. The success path
   guards the call; the catch path (a thrown executor is always an infra error
   being retried) no longer alerts at all. The result is still recorded and
   broadcast, so the failed attempt stays visible in the timeline / `ExecStrip`.

2. **`recordExecutionResult` (`src/lib/monitors/monitors-repo.ts`)** — an infra
   error records the **execution row** (state `error`) but no longer bumps the
   monitor's denormalized `lastStatus`/`lastRunAt`. This keeps the health
   baseline the alert classifier reads on the _retry_ pointed at the last real
   health, so the retry can't be misclassified as a recovery. This mirrors the
   deliberate policy the stale-execution reaper (`sweepStaleExecutions`) already
   follows ("the monitor badge stays owned by real recorded executions").

Both are needed: gating the alert alone would still leave `lastStatus = 'error'`
polluting the baseline, so the successful retry (`error → pass`) would still be
classified as a recovery and email a spurious "recovered".

## Why

From the 2026-07-03 architecture review (P1-3, hand-verified). `DOWN_STATES`
includes `'error'` and `classifyAlert` is purely edge-triggered with no
`infraError` exclusion, so `infraErrorResult` (`state: 'error'`, `infraError:
true`) — which the executor pairs with a **queue retry** — tripped both a "down"
email on the failing attempt and a "recovery" email on the retry.

## Details

| File                                                  | Change                                                                                                                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/monitors/executor.ts`                        | `if (!result.infraError) await safeAlert(...)` on the success path; removed the catch-path `safeAlert`; doc note on the `alert` dep.                           |
| `src/lib/monitors/monitors-repo.ts`                   | `recordExecutionResult` skips the `monitors` `lastStatus`/`lastRunAt`/`updatedAt` bump when `result.infraError` (the execution-row write is unchanged).        |
| `src/lib/monitors/__tests__/executor.workers.test.ts` | Added 3 tests: alert fires on a real outcome with the prior status; alert is NOT fired on an `infraError` result; alert is NOT fired when the executor throws. |

No schema, wire-contract, or realtime-event change. The `monitor-result`
broadcast still surfaces the infra error live (the exec strip turns red); only
the persisted badge baseline and the email are affected.

## Verification

- `pnpm --filter @wrightful/dashboard test:workers src/lib/monitors/__tests__/executor.workers.test.ts` — 16 passed (3 new).
- Full dashboard suite (node + workers) green; `pnpm check` — 0 errors.
