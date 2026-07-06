# 2026-07-05 — Fix Settings-page outage: static chunks 500 when the DB blips

## What changed

Client-side navigation to Settings dead-ended with `TypeError: Failed to fetch
dynamically imported module` for `layout-TP75Rth3.js` / `profile-CiyjWGeM.js` —
the code-split chunks for `pages/settings/{layout,profile}.tsx` — because those
`.js` files were returning **HTTP 500**. The Settings pages themselves build and
render fine; the bug was in asset serving.

Mechanism: the deployed worker runs `run_worker_first: ["/**"]`, so every
`/assets/*.js` fetch runs the full middleware stack. `middleware/01.context.ts`
resolved the tenant bundle (`resolveTenantBundleForUser`, a Postgres read) for
those requests too. `session.cookieCache` keeps `getSession()` DB-free for 60s,
so during a brief DB/Hyperdrive blip a user stays logged in but that query
throws — and `middleware/00.errors.ts` guarded asset paths in its post-`next()`
arm but **not** its catch arm, so the throw was rewritten to the HTML `/oops`
page: a 500 HTML body for a `.js` request, which breaks `import()` (no retry).

Two fixes:

- `01.context.ts` (root cause) — short-circuit static assets + error pages to a
  stub bundle before the DB query, like the existing `/api/*` branch.
- `00.errors.ts` (defense in depth) — catch arm now mirrors the post-`next()`
  static-asset guard: pass a thrown `Response` through, else log + `503`.

## Verification

Reproduced against a real production build (`vp preview` on workerd + local
Postgres, authed via Better Auth, Postgres stopped mid-session):

| Request (authed, DB down)              | Before | After |
| -------------------------------------- | ------ | ----- |
| `/assets/profile-CiyjWGeM.js` (exists) | 500    | 200   |
| `/assets/layout-TP75Rth3.js` (exists)  | 500    | 200   |
| `/assets/zzz-missing.js` (missing)     | 500    | 404   |

DB-up baseline is 200 throughout. New test:
`src/__tests__/middleware-static-asset-guard.workers.test.ts` (6 cases pinning
both guards). `vp check` clean; dashboard suite 253 + 1159 pass.

## Why the e2e suite missed it

The dashboard e2e suite boots `vp dev` (`packages/e2e/src/dashboard-fixture.ts`),
not a production build — dev mode has no hashed code-split chunks and no
`run_worker_first`/CF-Assets layer, so this failure can't occur there. Nothing
navigates a browser at the built worker in CI. Also: no spec visits
`/settings/profile`, all settings nav uses `page.goto()` (not a client-side
`<Link>` click), and no spec observes background request failures.

Follow-up (separate change): add a production-build browser leg (a `preview` mode
for `bootDashboard`) plus a "no 5xx / no pageerror" guard in the e2e fixtures.
