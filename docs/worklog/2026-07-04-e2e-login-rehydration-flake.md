# 2026-07-04 — Fix flaky dashboard e2e login test (Void client re-navigation race)

## What changed

De-flaked the dashboard UI e2e suite's login/signup specs by making the
`LoginPage` page object wait for Void's client runtime to settle before a spec
touches the form. One-method change in
`packages/e2e/tests-dashboard/pages/login.page.ts` (a `waitForClientSettled()`
helper called at the end of `gotoSignIn` / `gotoSignUp`). No app code changed.

## Why (root cause)

The "E2E UI Tests (Playwright)" CI job intermittently failed
`auth.spec.ts:23 › shows an inline error for invalid sign-in credentials` with
`getByRole('alert')` never appearing and the call log showing
`3 × waiting for /login navigation to finish`. It was flaky on `main` itself
(same commit both passed and failed), so it predates the schema-rework branch —
but a flaky test that can red a PR is still broken, so it got fixed rather than
re-run.

Investigation (real Postgres + `vp dev` + headless Chromium in the sandbox)
pinned the mechanism precisely:

- Every load of `/login` (and `/signup`) produces **two** main-frame
  navigations to the same URL. The second is **not** a Vite HMR reload (no
  `[vite] page reload` in console) and issues **no** new document request — it is
  a client-side History navigation Void's client performs on hydration
  (`void/pages/client` → `prefetch`), re-navigating to the current route.
- That re-nav **remounts the login island and resets its local React state**
  (`email` / `password` / `error`). The sign-in is fully client-side
  (`auth.signIn.email` → `setError` → `<p role="alert">`), so if a spec fills or
  submits **before** the re-nav lands, the credentials and the pending error
  alert are silently wiped and the assertion times out.
- The existing page object gated on the submit button being enabled (a hydration
  proxy), which usually — but not reliably — dodged the re-nav. Under CI's
  3-worker shared-dev-server load the timing slips and it flakes.

Measured directly with a Chromium probe against the booted dashboard:
interacting immediately after `goto` (before the re-nav settles) failed **0/8**;
waiting for `networkidle` first passed **8/8**.

## The fix

`gotoSignIn` / `gotoSignUp` now `await page.waitForLoadState("networkidle")`
after `goto`, so Void's initial re-navigation (and its page fetch) completes
before any spec fills or submits the form. `networkidle` is bounded by the
config's 15s `navigationTimeout`; on the anon login/signup routes (no realtime
polling) it settles in ~1.5s.

## Verification

Booted the full dashboard e2e harness against a real local Postgres
(`postgres:16`-equivalent, `pg_trgm` enabled) — which also re-validated the
rebased schema-rework migration chain applying cleanly via `void db reset`.

| Scenario                                 | Settings                                            | Result                                                                                                                                                                               |
| ---------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Probe: interact before settle            | single browser, ×8                                  | **0/8** (repro)                                                                                                                                                                      |
| Probe: `networkidle` settle first        | single browser, ×8                                  | **8/8** (fix)                                                                                                                                                                        |
| Full suite baseline (pre-fix branch)     | `workers:1`                                         | 46 passed, 0 flaky                                                                                                                                                                   |
| Stress, **no retries** (harsher than CI) | `workers:3 --repeat-each=6`                         | invalid-creds now passes; 2 valid-login/signup `waitForLandedOff` timeouts — the pre-existing "server slow under parallel load" class the config's `retries:2` is designed to absorb |
| **CI-faithful**                          | `CI=1` (`workers:3`, `retries:2`) `--repeat-each=3` | **24 passed, 0 failed, 0 flaky** (no retry consumed)                                                                                                                                 |

`pnpm check`: 0 errors.

## Notes

- The valid-login / signup "lands authed" tests wait up to 30s in
  `waitForLandedOff`, which equals the default 30s test timeout, so under extreme
  load the test budget can expire before that generous wait completes. This did
  not fire under CI-faithful settings (retries absorbed it), so it was left as-is
  rather than bumping timeouts speculatively — flagged here for future reference.
- Shipped on the `schema-rework` branch so PR #39's CI goes green on a real fix,
  not a re-run.
