# Playwright flake hardening

## Why

Wrightful's 30-day history for the `wrightful/wrightful` main branch reported
10 flaky dashboard tests. The failures clustered around unrelated navigation,
auth, monitor, API-key, and group flows rather than one product area.

Trace and error-context inspection showed three recurring causes:

- two Playwright workers saturated the single shared Void server and database;
- actions raced React/Void hydration, so clicks could be discarded or native
  form behavior could run instead of the client mutation;
- retry blocks repeated side effects or accepted stale UI as success.

## What changed

- The canonical dashboard suite briefly moved to one worker while the races
  below were fixed; parallel workers were then re-enabled — see
  "Parallel workers" below. CI retries remain enabled so Wrightful can still
  identify a genuine first-attempt failure.
- The app shell exposes a single `data-app-hydrated` marker. Because
  `useHydrated` is a global signal and `AppLayout` wraps every project/settings
  route, that one attribute proves the whole page (shell and content) is
  interactive — so page objects wait on it (via `waitForHydration`) rather than
  sprinkling per-form/per-list hydration attributes through product code. They
  then perform each mutation or navigation click once.
- Shared navigation waits for the exact URL, a page-specific landmark, and app
  hydration without waiting for every subresource's `load` event.
- API-key minting, duplicate-group creation, run/test navigation, and monitor
  creation/editing now wait for explicit user-visible outcomes instead of
  retrying clicks.
- Slow password hashing, internal trigger requests, monitor scheduling, and trace
  parsing have bounded operation-appropriate timeout budgets.
- The API-key reveal dialog now has semantic title/description elements. The
  run-history chart's labelled, non-clickable current point now has an image
  role, fixing the serious axe violation exposed by the full serial suite.
- Axe failures now include the offending selector and HTML in their error.

## Parallel workers (follow-up, 2026-07-16)

With the hydration and retry races fixed, the suite was re-parallelised
(`workers: 2` in CI, `4` locally; `fullyParallel` stays `false` so tests
within a file keep their order). Three things had to change first:

- **The real blocker was a dev-server module race, not test isolation.**
  With 4 workers on a cold `vp dev`, the first concurrent burst of authed-page
  SSR renders raced the workerd module runner on the shared
  `void/client` → `src/lib/auth-client.ts` import chain. One render observed a
  half-initialized namespace (`TypeError: createAuthClient is not a
function`), the runner cached the poisoned module, and every later page
  render 500'd for the life of the process (~29/52 tests failed; only routes
  not importing that chain kept passing). Serial runs never trigger it, which
  is why one worker looked like the only safe configuration. At that stage,
  `global-setup.ts` warmed the SSR module graph serially — one authenticated GET per
  page family, failing fast on 500 — before any worker starts. Add new page
  families to that list. Postgres was ruled out empirically (< 20 connections
  throughout).
- **"Newest run" readers are pinned to the seeded failures branch.**
  `realtime.spec` and `monitors.spec` legitimately create runs in the shared
  project mid-suite, and the runs list live-inserts rows via the project WS
  room. `openSeededRun` now defaults to `FAILURES_BRANCH` (monitor stub runs
  carry `branch: null` and realtime branches are unique-per-test, so nothing
  else can match), and navigation's row-click test filters the same way. All
  other specs already isolated their writes (timestamped names, per-pid
  tenants, throwaway sessions).
- **The Replay workbench test recovers from its own load watchdog.** Under a
  busy dev server the workbench's 30s no-progress watchdog
  (`BRIDGE_TIMEOUT_MS`) can fire before queued SW/trace fetches complete — a
  terminal "Couldn't load this trace" state. The test closes and reopens the
  dialog (a pure read) up to twice instead of failing on contention.

Suite wall-clock dropped from ~4 minutes to ~2 at 4 workers.

## Production-build E2E (follow-up, 2026-07-16)

Both E2E lanes now exercise the deployable dashboard output: the shared fixture
runs `pnpm build` and serves it with `vp preview` instead of booting `vp dev`.
That catches production bundling, generated Worker config, and runtime behavior
that an on-demand development module graph cannot.

- The fixture injects an ephemeral local Hyperdrive binding backed by the same
  throwaway `DATABASE_URL`, then calls the built Worker's authenticated
  `/__void/migrate` endpoint. This mirrors production migration behavior and
  includes Better Auth's tables, which local dev used to bootstrap implicitly.
- Cron and queue tests use Void's production `/__void/scheduled` and
  `/__void/queue` dispatchers with an ephemeral `__VOID_PROXY_TOKEN`; they no
  longer depend on the dev-only trigger-token file/header.
- `loggedScheduled` now forwards the Cloudflare `ScheduledController`, and the
  monitor sweep uses `controller.scheduledTime`. Tests can therefore drive the
  next legitimate scheduler tick deterministically instead of sleeping through
  a real 60-second monitor interval. The two monitor specs dropped from about
  1.2 minutes each to 6–7 seconds.
- Scheduler-driven monitors are created paused and resumed only while their
  spec owns a cross-worker filesystem lease; they are paused again before the
  lease is released. Alert-only monitors stay paused. This preserves the real
  scheduler's intentionally global sweep while preventing one parallel file's
  future tick from executing another file's fresh monitor.
- Production preview exposed that `void.json#routing.headers` is applied by the
  managed dispatch worker, not by own-account Workers or `vp preview`. Early
  in-worker middleware now applies the same defensive headers everywhere and
  preserves the trace viewer's `SAMEORIGIN`/relaxed-CSP exception; edge rules
  remain as a redundant outer layer. Both policies allow the account-specific
  `*.r2.cloudflarestorage.com` S3 endpoint in the minimum directives needed by
  presigned direct-R2 artifact redirects: image, media, and fetch destinations
  on dashboard pages, and range fetches in the trace viewer.
- The prior cold-`vp dev` module race documented above is no longer part of the
  E2E runtime. Global setup retains a serial production-route preflight as a
  fast fail for broken SSR page families, not as a module-graph warm-up.

Diagnostics: `WRIGHTFUL_E2E_SERVER_LOG=<path>` now tees the production preview's
output to disk. Relative paths resolve from the repository root.

## Verification

- `pnpm check`
- Production-preview monitor specs: 2 passed (6–7 seconds/spec).
- Production-preview trace/replay specs: 3 passed.
- Full canonical production-preview suite at 4 workers: 51 passed, 1 visual
  baseline check intentionally skipped, in 1.4 minutes.
- Vitest full-stack E2E against the production preview: 29 passed.
- 54 interaction/auth/group/navigation/test-detail checks passed across three
  repetitions.
- 8 monitor alert/synthetic/uptime checks passed across two repetitions.
- 12 accessibility/trace-replay checks passed across two repetitions.
- Full canonical dashboard suite serially: 51 passed, 1 skipped, 0 failed.
- Full canonical dashboard suite at 4 workers: three consecutive runs
  (51+50+51 passed) with the only failure being the pre-recovery Replay
  workbench watchdog, plus two more green runs after adding the recovery.
