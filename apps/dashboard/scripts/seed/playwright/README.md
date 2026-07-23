# Playwright-driven seed suite

Synthetic Playwright specs that `pnpm setup:local` runs against a freshly
bootstrapped local dashboard so the demo data has realistic test results
and artifacts (traces, videos, screenshots, visual diffs). **These aren't
tests** — they don't assert anything about Wrightful itself. They drive
the streaming reporter end-to-end so ingest, R2 uploads, and the per-test
DB rows all get exercised. The directory is named for the runner, not for
the file's role.

## What gets generated

[`scripts/upload-fixtures.mjs`](../../upload-fixtures.mjs) runs this
suite two or three times with different CI env vars (branch, commit,
build id). Each invocation goes through the real ingest + artifact flow,
so the seeded runs include actual traces, videos, screenshots, and a
visual-diff triple in R2.

The specs drive a fake storefront ([`mock-site.ts`](./mock-site.ts)) via
`gotoShop(page)` rather than static `page.setContent` — everything is
served from Playwright route handlers (no live server / internet), so each
trace carries realistic **Console** and **Network** entries (document +
CSS/JS/image sub-resources, GET/POST `fetch` calls, a deliberate 404) for
the trace viewer's Console + Network tabs. `trace: "on"` (see
`playwright.config.ts`) records a trace for **passing** tests too — the
all-green scenarios would otherwise ship none. `visual-regression.spec.ts`
keeps its `setContent` render (compared against a committed baseline).

## Prerequisites

1. `pnpm setup:local` — runs migrations and bootstraps the demo user/team/
   project/API key (written to `.dev.vars.seed.json`, gitignored).
2. `pnpm dev` — dashboard must be running on `http://localhost:5173`.

Then:

```
pnpm fixtures:generate
```

## Demo credentials

After `setup:local`:

- Email: `demo@wrightful.local`
- Password: `demo1234`
- Team slug: `demo`, project slug: `playwright`

## Scenarios

| File               | Branch                | Outcome                    |
| ------------------ | --------------------- | -------------------------- |
| 01 main-green      | `main`                | all green                  |
| 02 feature-flaky   | `feat/discount-codes` | fail + flaky + visual diff |
| 03 main-historical | `main` (3 days ago)   | all green                  |

The failure-driven specs (`flaky.spec.ts`, `visual-regression.spec.ts`)
are gated behind `WRIGHTFUL_FIXTURE_FAILURES=1` so the suite stays silent
unless the generator opts in.

## Visual regression baseline

`visual-regression.spec.ts` compares a `setContent`-rendered V2 landing
page against a baseline at
`visual-regression.spec.ts-snapshots/landing.png`. The baseline is the V1
version of the same markup, rendered once by
[`make-visual-baseline.mjs`](./make-visual-baseline.mjs) via Chromium.
Rerun the script if V1 ever needs to change — keep V1_HTML in the script
in sync with V2_HTML in the spec; only the three documented delta lines
should differ.

## Why Playwright-in-dashboard, not Playwright-in-e2e

`packages/e2e/` houses the real Playwright E2E suite. Those tests must
stay green. The seed suite lives here so induced failures don't leak
into that signal.
