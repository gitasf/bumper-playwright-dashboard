# 2026-06-24 — Embedded test replay (self-hosted Playwright Trace Viewer)

## What changed

We're sunsetting the Cypress Cloud dashboard in favour of Wrightful now that the
main app's E2E suite runs on Playwright. Cypress Cloud's headline feature is
**test replay / time-travel debugging** — a command log, a scrubbable DOM-snapshot
replay of the app under test, plus network and console panels. A Playwright
`trace.zip` already contains all of that, and the reporter already captures and
uploads traces (artifact type `"trace"`), per attempt, into R2.

The only gap was the UI: the test-detail "Trace Viewer" button used to **link out
to the public `trace.playwright.dev`**, which (a) shipped our trace bytes to a
third party and (b) bounced the user out of the dashboard. We now **self-host the
official Playwright Trace Viewer and embed it in-app** in a near-full-viewport
dialog, so replay happens on our own origin without leaving the page.

No schema, ingest, or wire-contract changes — this is purely a serving + UI change
on top of artifacts we already store.

## Details

| Area         | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vendoring    | New `apps/dashboard/scripts/vendor-trace-viewer.mjs` copies the trace-viewer bundle out of `playwright-core/lib/vite/traceViewer` into `public/trace-viewer/`, pinned to the installed playwright-core version (currently 1.59.1). Idempotent (version stamp at `public/trace-viewer/.vendored-version`); **fails loudly** if the source layout/required files move on a Playwright upgrade.                                                                                                                           |
| Build wiring | `predev` / `prebuild` / `predeploy` / `predeploy:cf` now also run `vendor:trace-viewer`. Output dir is gitignored (`apps/dashboard/.gitignore`) — it's a generated artifact regenerated every build.                                                                                                                                                                                                                                                                                                                   |
| Headers      | `void.json` gains a `/trace-viewer/*` `routing.headers` block (last-match-wins over `/*`): `X-Frame-Options: SAMEORIGIN`, `Service-Worker-Allowed: /trace-viewer/`, and a path-scoped CSP with `frame-ancestors 'self'` + `worker-src`/`frame-src 'self'` + `'unsafe-eval'` (the settings/codeMirror chunks need it) + `data:`/`blob:` for snapshot media. The strict global `/*` CSP (`frame-ancestors 'none'`, `X-Frame-Options: DENY`) is unchanged for every other route.                                          |
| URL builder  | `signedTraceViewerUrl()` (`src/lib/artifact-tokens.ts`) now returns `/trace-viewer/index.html?trace=<absolute signed download URL>` instead of the `trace.playwright.dev` URL. New exported `TRACE_VIEWER_PATH` constant. The `?trace=` value stays the **absolute** same-origin download URL so the viewer's fetch + HTTP range requests work.                                                                                                                                                                        |
| UI           | New `src/components/trace-viewer-dialog.tsx` — a controlled near-full-viewport `Dialog` whose iframe is mounted only while open (defers the ~1.6 MB bundle + SW registration to first use, reloads fresh each open). Header offers **New tab** / **Download trace.zip** / a low-emphasis **Public viewer** fallback (trace.playwright.dev, still CORS-allowed in `download.ts`). `RailTraceButton` in `artifacts-rail.tsx` swapped from an external `<a target="_blank">` to this dialog, mirroring `RailVideoButton`. |

## Why this is clean (no rewrites / scope hacks)

The vendored bundle is position-independent: all asset refs in `index.html` are
relative, and the service worker registers **relatively** (`serviceWorker.register("sw.bundle.js")`)
and derives its internal routes from `self.registration.scope`. Served at
`/trace-viewer/`, the SW scope becomes `/trace-viewer/` automatically and snapshot
interception "just works" — no Void rewrites and no mandatory `Service-Worker-Allowed`
header (we set it defensively anyway).

## Verification

- `vendor-trace-viewer.mjs` run + re-run → vendors playwright-core 1.59.1, then reports "up to date" (idempotent). ✓
- `pnpm --filter @wrightful/dashboard run typecheck` → clean. ✓
- `pnpm check:fix` → 0 errors (the 114 warnings are pre-existing `no-unsafe-type-assertion` in `packages/e2e`, untouched). ✓
- Unit tests: `artifact-tokens.workers.test.ts` (URL shape updated to the self-hosted path), `test-artifact-actions.test.ts`, `artifact-response.workers.test.ts` → all pass. ✓
- Live `vp dev` probe:
  - `GET /trace-viewer/index.html` → 200 with `x-frame-options: SAMEORIGIN`, the relaxed `frame-ancestors 'self'` CSP, and `service-worker-allowed: /trace-viewer/`; global security headers (HSTS, nosniff, referrer-policy, permissions-policy) still merged in. ✓
  - `GET /login` (a normal route) → still `x-frame-options: DENY` + `frame-ancestors 'none'` — relaxation is correctly scoped. ✓
  - `sw.bundle.js`, `snapshot.html`, `index.<hash>.js` all serve 200 with correct content types. ✓
- **Not yet verified headlessly**: the in-browser DOM-snapshot scrub itself (needs a real trace artifact + interactive browser). To confirm: open a failed test with a trace in `pnpm dev`, click **Trace Viewer**, scrub the timeline, and check the **Network**/**Console**/**Source** tabs populate — with no requests to `trace.playwright.dev` and `206` responses from `/api/artifacts/.../download`.

## Follow-up (same day): list-level replay + rail simplification

Second pass, after the embed landed, to match the Cypress "Test Replay per row" UX:

| Area            | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Naming          | Rail trace button relabelled **"Trace Viewer" → "Test Replay"** (`artifacts-rail.tsx`).                                                                                                                                                                                                                                                                                                                                                                                              |
| Rail cleanup    | Dropped the standalone **Video** and **Screenshot** rail buttons (`RailVideoButton`/`RailScreenshotButton` removed). The embedded Test Replay already plays the video and shows every screenshot inline, so they were redundant. The rail now filters `media` to `trace` + `visual` only (visual-diff stays — the viewer doesn't render an expected/actual/diff comparison). Note: a test with _only_ a video/screenshot and no trace no longer surfaces a media button in the rail. |
| List replay     | New per-row **Test Replay** button in the run's test list (`RunProgress`/`TestRow`). The row is a `<Link>`, so the button is a sibling (a small `PlayCircle` accent button), not nested in the anchor.                                                                                                                                                                                                                                                                               |
| Lazy URL        | New session-authed route `GET /api/t/:team/p/:project/runs/:runId/tests/:testResultId/replay` (`routes/.../tests/[testResultId]/replay.ts`) mints a fresh signed viewer URL + download href for the test's **last-attempt** trace, 404 when none. The list button fetches it on click (the realtime list carries no artifact rows), then opens the dialog. Minting on demand keeps the 1h token fresh and avoids embedding a token per row.                                          |
| Button gating   | The run-detail loader (`runs/[runId]/index.server.ts`) computes `tracedTestIds` (one `selectDistinct` over the page's test ids where `type='trace'`) and passes it down, so the button renders only for tests that actually have a trace. Live-streamed rows aren't in that set until reload — acceptable, since artifacts register in a flush _after_ the result posts, so the realtime event genuinely can't know.                                                                 |
| Dialog refactor | `trace-viewer-dialog.tsx` split into a shared `TestReplayContent` (panel + iframe) used by both `TraceViewerDialog` (rail, URL known at SSR) and the new `TestReplayButton` (list, URL fetched lazily).                                                                                                                                                                                                                                                                              |

Additional verification:

- Typecheck clean; `pnpm check:fix` → 0 errors (114 pre-existing warnings only). ✓
- Unit lanes `test-artifact-actions`, `artifact-tokens`, `run-progress-reducer`, `run-results-page`, `artifact-origin-safety` → all pass. ✓
- Live probe: `GET /api/t/demo/p/demo/runs/x/tests/y/replay` → **401** (same as the sibling `summary` route — registered + auth-gated, not 404). ✓
- Still pending headless: clicking the list button while logged in on a run with a trace, and the in-browser scrub.

## Follow-up (same day): e2e coverage + harness fixes

New spec `packages/e2e/tests-dashboard/test-replay.spec.ts` (canonical dashboard
Playwright suite), three tests, all passing:

1. **Serving + headers** — `GET /trace-viewer/index.html` returns 200 with `X-Frame-Options: SAMEORIGIN`, CSP `frame-ancestors 'self'`, and `Service-Worker-Allowed: /trace-viewer/`; a normal route (`/login`) still returns `DENY` + `frame-ancestors 'none'`. Proves the relaxation is scoped and doesn't leak.
2. **List replay** — on the failures-branch run, the per-row **Test Replay** button fires `GET …/tests/:id/replay`, and the response's `traceViewerUrl` is a self-hosted `/trace-viewer/index.html?trace=…` (asserted _not_ `trace.playwright.dev`); the dialog then mounts an iframe at that URL.
3. **Rail replay** — navigating into a traced test, the rail button reads **Test Replay**, the standalone **Video**/**Screenshot** buttons are gone (count 0), and opening it embeds the self-hosted viewer.

Two harness fixes were required to make the dashboard e2e suite boot at all (both in `packages/e2e/src/dashboard-fixture.ts`, used by `bootDashboard`):

- **Trace-viewer vendoring** — the harness spawns `vp dev` directly, which bypasses the `predev` npm hook, and the vendored bundle is gitignored. Added a `node scripts/vendor-trace-viewer.mjs` step (idempotent) before the dev server starts, so the embed isn't a 404 in a fresh clone.
- **`DATABASE_URL` passthrough** — post-Postgres-migration, `void db reset` reads `DATABASE_URL` from `.env.local` (no managed-DB fallback), but `bootDashboard` wrote a `.env.local` without it, so the suite couldn't boot. It now passes `process.env.DATABASE_URL` into the generated `.env.local` (CI's postgres service / a local export provides it). **Note:** the `test-e2e-ui` CI job has no postgres service/`DATABASE_URL` yet — that job needs a `postgres:16` service + `DATABASE_URL` env added to `.github/workflows/ci.yml` (out of scope here; flagged as a follow-up). Locally the suite runs against a throwaway DB: `createdb wrightful_e2e` then `DATABASE_URL=postgresql://…/wrightful_e2e pnpm --filter @wrightful/e2e test:dashboard`.

Verification: `pnpm exec playwright test --config=playwright.dashboard.config.ts test-replay` → **3 passed**. Lint/format clean (0 errors).

## Follow-ups (not in this change)

Run-level quick-replay affordance from the runs list (one level up from the test
list); optional lightweight step/command timeline outside the full viewer;
GitHub status-check annotations. These are the "then polish" phase of the
Cypress-parity push.
