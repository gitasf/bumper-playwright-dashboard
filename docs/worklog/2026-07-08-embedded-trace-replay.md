# 2026-07-08 — Embedded self-hosted Test Replay + e2e dashboard isolation guard

## What changed

Ported the "embedded Test Replay" feature (self-hosted Playwright Trace Viewer)
and the e2e isolation guard from an upstream fork's PR
(`gitasf/bumper-playwright-dashboard#3`) into this tree. The fork is a mirror of
this codebase, so most of the change applied 1:1; one piece — the per-row "Test
Replay" button in the run's Tests tab — was **re-plumbed** against our current
architecture, which had diverged from the fork's base (see "Adaptation" below).

Three things landed together:

1. **Embedded Test Replay.** We vendor Playwright's official Trace Viewer bundle
   into `public/trace-viewer/` and serve + iframe it from our OWN origin, so
   time-travel debugging (command log, DOM-snapshot scrubber, network/console)
   happens on the dashboard instead of bouncing users — and their trace bytes —
   out to the public `trace.playwright.dev`. Surfaced two ways: the test-detail
   **artifacts rail** button (relabelled "Trace Viewer" → "Test Replay"), and a
   **per-row** button in the run's test list.
2. **E2E dashboard isolation guard + CI.** A guarded `test:dashboard` wrapper
   that can never point `void db reset` at your dev DB, plus a dedicated
   `wrightful_e2e` CI database.
3. **Realtime nav-guard** (bundled bug fix). A WS reconnect landing mid-SPA-nav
   no longer bounces the user back to the page they're leaving.

No schema, ingest, or wire-contract changes — Test Replay is purely a serving +
UI change on top of `trace` artifacts the reporter already captures into R2.

## Details

| Area              | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vendoring         | New `apps/dashboard/scripts/vendor-trace-viewer.mjs` copies the trace-viewer bundle out of `playwright-core/lib/vite/traceViewer` into `public/trace-viewer/`, pinned to the installed version (currently **1.61.1**), idempotent (version stamp), fails loudly if the source layout moves. Wired into `predev`/`prebuild`/`predeploy` and into `bootDashboard` (the e2e harness spawns `vp dev` directly, bypassing the npm pre-hook). Output dir gitignored. |
| Serving / CSP     | `void.json` gains a path-scoped `/trace-viewer/*` headers block (`X-Frame-Options: SAMEORIGIN`, `Service-Worker-Allowed`, a relaxed `frame-ancestors 'self'` CSP with `unsafe-eval`/`worker-src blob:`). Void's last-match-wins merge scopes the relaxation to that path only; the strict global `/*` CSP (`frame-ancestors 'none'`, `DENY`) is unchanged for every other route.                                                                               |
| URL builder       | `signedTraceViewerUrl()` now returns `/trace-viewer/index.html?trace=<absolute signed download URL>` (self-hosted) instead of the `trace.playwright.dev` wrap. New `TRACE_VIEWER_PATH` constant. `traceViewerUrlFor()` (the public-viewer wrap) is kept for the direct-R2 path.                                                                                                                                                                                |
| Dialog UI         | New `src/components/trace-viewer-dialog.tsx` — a near-full-viewport `Dialog` whose iframe mounts only while open (defers the ~1.6 MB bundle to first use). `TraceViewerDialog` (rail, URL known) + `TestReplayButton` (list, URL fetched lazily). Color tokens aligned to our app conventions (`border-line-1`/`text-fg-3`/`bg-bg-0`).                                                                                                                         |
| Rail              | `RailTraceButton` swapped from an external `<a target="_blank">` to the embedded dialog and relabelled "Test Replay". The standalone **Video**/**Screenshot** rail buttons are **kept** (handy for grabbing one asset without the whole trace.zip).                                                                                                                                                                                                            |
| Lazy replay route | New session-authed `GET /api/t/:team/p/:project/runs/:runId/tests/:testResultId/replay` — mints a fresh signed viewer URL + download href for the test's last-attempt trace, 404 when none. Applied verbatim from the fork; every dependency (`childByTestResultWhere`, `resolveTenantApiScope`) matched.                                                                                                                                                      |
| Nav-guard         | `use-feed-room.ts` skips the reconnect `router.refresh()` while a navigation is in flight (`useNavigation().state !== "idle"`, read through a ref). Correct standalone fix; applied verbatim.                                                                                                                                                                                                                                                                  |
| E2E guard         | New `packages/e2e/scripts/run-dashboard-e2e.mjs`; `test:dashboard` runs it (raw escape hatch = `test:dashboard:raw`). Resolves an e2e `DATABASE_URL` that can never be the dev DB (suffixes `_e2e`), auto-creates it, and refuses to run if a `pnpm dev` server is up on `:5173` (probes IPv4 + IPv6). Overrides: `E2E_DATABASE_URL`, `E2E_ALLOW_DEV_SERVER`.                                                                                                  |
| CI                | `.github/workflows/ci.yml` `test-e2e-dashboard` job renamed its throwaway DB `wrightful_test` → `wrightful_e2e` (the postgres service already existed).                                                                                                                                                                                                                                                                                                        |

## Adaptation — per-row button against our re-architected Tests tab

The fork gated the per-row button on `tracedTestIds`, **computed in the SSR
run-detail loader** over SSR-seeded test rows. Our tree no longer works that way:
`runs/[runId]/index.server.ts` doesn't load tests at all, and `RunProgress` pages
groups/rows client-side via TanStack `useInfiniteQuery`
(`run-progress.tsx` → `run-progress-group.tsx` → `run-progress-row.tsx`). So the
fork's loader/`index.tsx`/`run-progress.tsx` hunks had no anchors and were
**dropped**. Instead:

- `RunProgressTest` gains an **optional** `hasTrace?: boolean` (wire type; the
  live broadcast path leaves it `undefined`, so a live-streamed row gets the
  button only after its group re-fetches — matching the fork's documented
  "appears after reload" behaviour, since traces upload post-completion anyway).
- The `GET …/results` route attaches `hasTrace` per row via one batched
  `selectDistinct` over the page's ids (`type='trace'`, project-scoped). Confined
  to that route, so the shared `loadRunResultsPage` and the v1 / CSV / MCP
  surfaces that reuse it are untouched.
- `run-progress-row.tsx`'s `TestRow` unwraps its single `<Link>` into a `<div>`
  with the nav link + `TestReplayButton` (gated on `test.hasTrace`) + an
  `aria-hidden` chevron as siblings. On a completed run (the replay use case)
  `byId` is empty (rooms don't replay events), so `mergeGroupRows` keeps the
  server rows and `hasTrace` survives — no change needed to the hot merge path.

## Deliberately not ported

- The fork's three worklogs (internally contradictory — e.g. they claim the
  Video/Screenshot buttons were "dropped" and CI "gained a postgres service",
  neither true in the actual diff) — replaced by this single entry.
- `docs/integrations/wrightful-reporter.md` — tailored to the fork's private
  frontend repo (12-project matrix, `NEXT_PUBLIC_ENV`, its branch names); not
  generic enough for this OSS repo.
- The `DATABASE_URL` fixture passthrough (already present here).

## Self-hosting note

`void.json` `routing.headers` only apply on the managed `void deploy` path, not
own-account `deploy:cf`/wrangler (see `public/_headers`). The embed still works
on own-account (no global `DENY` to fight there), it just lacks the defense-in-
depth headers. Mirroring `/trace-viewer/*` into `public/_headers` for parity is
a possible follow-up, kept generic per the OSS/self-hosting stance.

## Verification

- **Vendoring:** `vendor-trace-viewer.mjs` vendored playwright-core 1.61.1
  (index.html / sw.bundle.js / snapshot.html present), re-run reported "up to
  date", output gitignored. ✓
- **Typecheck:** `void prepare && tsgo --noEmit` → 0 errors (the typed client
  resolves the new `/replay` route; `hasTrace` typing clean). ✓
- **Unit:** dashboard node lane 281 passed / 4 skipped; workers lane 1219 passed;
  `artifact-tokens.workers` (self-hosted URL shape, 9) + `use-feed-room` /
  `use-room-reseed` (nav-guard, 16) all green. ✓
- **Static:** `pnpm check` → **0 errors**, 130 warnings (all pre-existing
  `no-unsafe-type-assertion` baseline in `packages/e2e`; my files add none). ✓
- **Dashboard Playwright e2e (`test-replay.spec.ts`): NOT run locally.** The new
  guard correctly refused (a `pnpm dev` server was live on `::1:5173`); running
  it would have needed `E2E_ALLOW_DEV_SERVER=1`, which risks the dev session it
  exists to protect. CI's `test-e2e-dashboard` job (now on `wrightful_e2e`) will
  exercise it. Logic traced as compatible: terminal runs auto-expand failing
  groups, so traced rows render and the per-row button appears without manual
  expansion.

## Follow-up (same day): deep-linkable modal, Escape fix, "Replay" rename

Post-review polish (four asks):

- **Deep-linkable via query param.** The Replay modal's open state now lives in
  `?replay=<id>` (`useSearchParam`, shallow `replaceState` — no loader re-run),
  so a specific replay is shareable. On the run's Tests tab the id is a
  `testResultId` and the modal is hosted **once** by a new `ReplayModalHost`
  (mounted in `RunProgress`), which mints the viewer URL from the replay
  endpoint on demand — so a link opens even when the target test's group is
  collapsed. On the test-detail rail the id is the `artifactId` (URL known at
  SSR). The per-row button (`ReplayRowButton`) now just sets the param. A bad
  deep-link (no trace → 404) clears the param so the URL never lies.
- **Escape now closes it.** The viewer is self-hosted (same-origin), so a
  keydown inside the iframe never bubbled to the parent Dialog and Escape was
  swallowed. `TestReplayContent` now binds an Escape listener on the iframe's
  own `contentWindow` (on `load`) that clears the param; the Dialog's built-in
  handler still covers focus on the header controls.
- **Rename** "Test Replay" → **"Replay"** (rail label + per-row button + iframe
  title + route docstring).
- **Title font.** The modal's `DialogTitle` dropped `font-mono` → the standard
  body font.
- `useSearchParam`/`useNavigatingSearchParam` now **drop the key** when a value
  returns to its default (via a shared `normalizeNext`), so a closed modal
  leaves no bare `?replay=` behind. The replay route also returns the test
  `title` so a deep-linked modal renders its header without a click.

Verification (this round): typecheck 0 errors; dashboard node 281 / workers 1219
pass; `pnpm check` 0 errors. `test-replay.spec.ts` extended to assert the
`?replay=` URL round-trip (open → URL carries it → Escape closes + clears →
cold-load the link re-opens the modal) — **CI-run** (still blocked locally by
the dev-server guard).

## Follow-up (same day): embed must be self-hosted under direct-R2 (reviewer)

A reviewer noted the iframe embed assumes a same-origin viewer URL, but the
**direct-R2 seam** (ADR 0003) produced a `trace.playwright.dev` URL — which the
page CSP (`default-src 'self'` → `frame-src` fallback) blocks from framing, so
the embed rendered blank whenever `R2_ACCOUNT_ID/…/R2_BUCKET` were set. This was
inherited 1:1 from the fork PR, which never touched `test-artifact-actions.ts`;
it's latent because local dev + the managed platform use the worker-proxy path
(direct-R2 off → `signedTraceViewerUrl`, self-hosted).

Fix: `signArtifactRows` now **always** projects a trace's `traceViewerUrl` to the
self-hosted `signedTraceViewerUrl(origin, id, token)`, dropping the direct-R2
`traceViewerUrlFor(presigned)` branch. `trace.playwright.dev` remains only as the
dialog's "Public viewer" **link** (a new tab, never framed). The Playwright trace
viewer is a standalone SPA + service worker (no mountable component API), so the
iframe is the correct integration — the bug was the URL, not the iframe.

- Bonus: the raw `r2Key` no longer surfaces in SSR HTML (it only did via the
  direct-R2 presigned URL); `SignedArtifact`'s origin-safety note updated.
- Deployment caveat (direct-R2 only): the self-hosted viewer fetches the
  same-origin worker download URL, which 302s to R2 — so the R2 bucket's CORS
  must allow the **dashboard** origin (was `trace.playwright.dev`). The default
  worker-proxy config streams bytes through the worker (no CORS needed).
- `test-artifact-actions-signing.test.ts` rewritten: the ON/OFF direct-R2 fork is
  gone; it now pins the unconditional self-hosted invariant (`not trace.playwright.dev`).

## Follow-up (same day): review nits — layering + magic-string

Two more reviewer findings, both legit:

- **`hasTrace` enrichment layering.** The batched artifacts query lived inline in
  the `…/results` route, contradicting its "auth + query translation only"
  docstring. Extracted to `src/lib/trace-presence.ts#attachHasTrace(scope, rows)`
  — a dedicated helper the route calls, kept OUT of the shared
  `loadRunResultsPage` (so it never leaks into the public v1 / export / MCP
  contracts). Route is thin again.
- **Magic-string parse.** `TestReplayContent` reconstructed the public-viewer
  URL by `viewerUrl.split("?trace=")`, coupling to `signedTraceViewerUrl`'s query
  layout. Now derived from the explicit `downloadHref` prop + `window.location.origin`
  (client-only, `useMemo`), with the split deleted.
- Minor: hardened the iframe Escape listener (remove-before-rebind + unmount
  cleanup, so re-loads can't stack listeners). The overloaded `?replay=` value
  space (testResultId vs artifactId across the two pages) is already documented
  on the `REPLAY_PARAM` constant.

## Follow-up (same day): own-account parity + CORS doc + cross-frame Escape

Cleared three of the deferred items:

- **Own-account header parity.** Mirrored the `/trace-viewer/*` block into
  `apps/dashboard/public/_headers` (X-Frame-Options SAMEORIGIN,
  Service-Worker-Allowed, the relaxed CSP), so the embed's framing/SW/CSP headers
  apply on the `deploy:cf` path too — `void.json` `routing.headers` only take
  effect on the managed `void deploy`. Marked KEEP-IN-SYNC with void.json.
- **Direct-R2 CORS doc.** `SELF-HOSTING.md` now states the embed stays
  self-hosted under direct-R2 (wraps the worker download URL, never
  `trace.playwright.dev`), so the bucket CORS must allow the **dashboard** origin
  (`trace.playwright.dev` in `AllowedOrigins` is now needed only for the optional
  "Public viewer" link). Corrected the stale "trace viewer embeds [a presigned
  URL] directly" line left over from the pre-CSP-fix behaviour.
- **Cross-frame Escape.** `bindEscapeAcrossFrames` now binds Escape on the viewer
  window AND every reachable same-origin descendant frame (re-binding on frame
  `load` + a `MutationObserver` per document), so Escape closes the modal even
  when focus is inside the nested DOM-snapshot frame. Fully guarded/torn down;
  degrades to the Dialog's own handling on any failure.

## Follow-ups (not in this change)

- Run headless verification of the in-browser DOM-snapshot scrub on a real trace
  (and confirm the cross-frame Escape binder fires from inside the snapshot frame
  — added but not yet driven in a real browser).
- **Lightweight step/command timeline** outside the full viewer — a real feature,
  not a quick follow-up: needs a step-data source (parse the `trace.zip`
  server/client-side, or emit `TestResult.steps` from the reporter → new wire
  field + ingest + schema). Scope separately before building.
