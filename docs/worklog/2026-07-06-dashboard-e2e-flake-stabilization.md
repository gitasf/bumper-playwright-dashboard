# 2026-07-06 — Stabilize the dashboard UI e2e leg against shared-server contention

## What changed

The **E2E UI Tests (Playwright)** CI leg (`pnpm --filter @wrightful/e2e test:dashboard`)
was failing on the `unify-dashboard-filter-ui` PR. Investigation showed this is
**not** a regression from that branch — it is pre-existing, environmental flake
that also fails on `main`:

- PR run `28794272937` (first attempt): `1 failed, 3 flaky` — hard failure was
  `groups.spec.ts:46` (duplicate-group inline error not visible within timeout).
- Same commit, re-run of the failed leg only: `18 failed, 1 flaky` — a
  server-wide collapse, all pure timeouts (`page.waitForEvent websocket`,
  `locator.getAttribute`, navigation), spanning `realtime`, `runs-filters`,
  `test-detail`, `monitors`, `uptime-monitors`, etc.
- `main` run `28756559604` (independent of this branch): `1 failed, 4 flaky` —
  same recurring heavy-test set (`monitor-alerts`, `monitors`, `test-detail`),
  hard failure landed on `api-keys` that time.

The pattern is textbook single-shared-server contention: the whole suite runs
against one dev server (miniflare + Vite + Better Auth on a local Postgres). At
3 CI workers, on a resource-starved runner, the server slows enough that
client-side auth calls, `void/ws` socket opens, and navigations blow their
timeouts and flip pass↔fail. Whichever heavy test happens to exhaust its 2
retries becomes "the" hard failure that run; the rest report flaky. The config
already documented this trade-off and chose to "absorb residual flake" — the
starved-runner runs simply exceeded what retries could absorb.

The branch under test is a pure UI-consistency refactor (color tokens, shared
`TabBar`/`RowLink`/`StatusPill` chrome) and touches none of the e2e specs, the
groups server action, or the `Alert` component that surfaces the error. It
cannot be the cause.

## Fix

Reduce contention on the shared server and give a merely-slow (not dead) server
more room, rather than papering over it with more re-runs:

| File                                            | Change                                                                               | Why                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `packages/e2e/playwright.dashboard.config.ts`   | CI `workers` 3 → 2                                                                   | ~33% more headroom on the shared server; keeps `retries: 2` to absorb the remainder.        |
| `packages/e2e/playwright.dashboard.config.ts`   | CI `actionTimeout` 10s → 15s, `navigationTimeout` 15s → 25s (local values unchanged) | Ceilings now bite only on a genuinely stalled server, not a slow one.                       |
| `packages/e2e/tests-dashboard/realtime.spec.ts` | `waitForEvent("websocket")` timeout 20s → 30s under CI                               | The 3 realtime tests failed on this hardcoded wait, which the config timeouts don't govern. |

Local runs (1 worker, responsive server) keep the tighter timeouts so genuine
regressions still fail fast.

## Verification

- `vp lint` on both edited files: clean (only the pre-existing `__dirname`
  `no-underscore-dangle` warning, unrelated to this change).
- `vp fmt --check` on both files: correctly formatted.
- Root cause corroborated across three CI runs (two branch, one main) as
  documented above.
- Full green confirmation depends on the next CI run of the leg; the change is a
  contention/timeout mitigation, so residual flake on an extremely starved
  runner is still possible but should be within the retry budget again.
