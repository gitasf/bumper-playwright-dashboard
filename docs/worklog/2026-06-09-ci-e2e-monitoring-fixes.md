# 2026-06-09 — Fix failing e2e CI on feat/monitoring

## What changed

The synthetic-monitoring PR (#27, `feat/monitoring`) was red on two CI jobs. Both
were fixed:

1. **`E2E UI Tests (Playwright)`** — the `monitors.spec.ts` synthetic-monitor test
   failed deterministically.
2. **`E2E Tests`** (vitest e2e) — the dashboard fixture failed to boot at all.

## Details

### 1. Monitors spec — two latent bugs (commit `63dcf7b`)

The test had never passed in CI; the first failure masked the second.

- **Wrong assertion** (`monitors.spec.ts:70`): asserted `getByText(/enabled/i)` on a
  fresh monitor's list row, but the row has no "enabled" text — the enabled state is a
  Base UI `<Switch>` (the word "Enabled" is only the column header). Replaced with
  `expect(row.getByRole("switch")).toBeChecked()`.
- **`create()` captured `"new"` as the monitor id** (`pages/monitors.page.ts`): the
  `detailUrlRe` also matched `/monitors/new`, so `waitForURL` resolved on the
  pre-redirect URL before the create action redirected to `/monitors/<ULID>`. The page
  object then navigated to the _create_ form instead of the detail page. Fixed with a
  negative lookahead excluding the `new` sentinel.

### 2. e2e dashboard boot — sandbox container build (commit `d08206c`)

The monitoring feature added a `sandbox` block to `void.json`, which makes Void add a
Cloudflare **container** binding. The Cloudflare vite plugin then builds
`apps/dashboard/Dockerfile.sandbox` (`FROM docker.io/cloudflare/sandbox:0.10.2`) on
**every `vp dev` boot** (gate: `containers?.length && dev.enable_containers`, default
true) — regardless of `WRIGHTFUL_MONITOR_EXECUTOR`. In CI that build timed out reaching
Docker Hub, so the e2e dashboard-fixture never came up ("Server at
http://localhost:5188 did not start within 90s").

Fix: `apps/dashboard/wrangler.jsonc` now sets `"dev": { "enable_containers": false }`.
The Cloudflare plugin reads `wrangler.jsonc` during dev and Void's `mergeBindings` only
adds missing bindings, so the `dev` block is honored. Local dev + e2e use the in-process
`StubExecutor` (`WRIGHTFUL_MONITOR_EXECUTOR=stub`, the documented local/test path in
`env.ts`), never the real container, so the build was pure overhead. Production
`void deploy` is unaffected — it ships the container via the sandbox `platformImage`,
not the dev gate. Side benefit: local `pnpm dev` no longer requires Docker.

## Verification

- `pnpm --filter @wrightful/e2e exec playwright test --config=playwright.dashboard.config.ts tests-dashboard/monitors.spec.ts`
  → **1 passed** (dashboard booted with no Docker build).
- `pnpm test:e2e` (the exact command the `E2E Tests` job runs) → **12/12 passed**,
  dashboard booted with no Docker build.
- `pnpm check` clean for the changed files (only unrelated gitignored `.context/`
  scratch files were flagged for formatting).
