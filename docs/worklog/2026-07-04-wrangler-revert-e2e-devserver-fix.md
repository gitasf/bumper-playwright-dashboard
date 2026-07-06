# 2026-07-04 — Revert wrangler 4.107.0 → 4.94.0 (fixes E2E dev-server boot after Void 0.10.4)

## What changed

Reverted the dashboard's `wrangler` pin from `4.107.0` back to `4.94.0`. This
undoes the one incidental part of the Void 0.10.4 upgrade
(`2026-07-03-void-0.10.4-upgrade.md`) that broke the E2E dev server — caught by
CI on PR #38, not by any local check the upgrade ran.

## Root cause

The Void 0.10.4 upgrade bumped `wrangler` 4.94.0 → 4.107.0 ("satisfies void's
`^4.90.0`") while **holding `@cloudflare/vite-plugin` at 1.38.0** — a transitive
dep of `void` — on the reasoning that bumping the plugin was "no functional
gain." That reasoning was wrong: the two are coupled.

`@cloudflare/vite-plugin@1.38.0` calls `wrangler.unstable_getWorkerNameFromProject`
in its Vite `config` hook (`resolveWorkerConfig` → `resolvePluginConfig`). That
`unstable_*` export **exists in wrangler 4.94.0 but was removed by 4.107.0**.
So on the branch the dev server died at config resolution:

```
TypeError: wrangler.unstable_getWorkerNameFromProject is not a function
    at resolveWorkerConfig (@cloudflare/vite-plugin@1.38.0/dist/index.mjs)
→ Server at http://localhost:5188 did not start within 90s
```

Confirmed empirically: `require("wrangler").unstable_getWorkerNameFromProject`
is `undefined` under 4.107.0 and a `function` under 4.94.0.

### Why it slipped through

The upgrade's verification ran `void prepare`, `tsgo`, `pnpm check`, unit tests
(node + workers pools), and `vp build` — all of which pass, because none of them
boot `vp dev`. The `@cloudflare/vite-plugin` config hook only runs on the dev
server, which **only the E2E suites exercise** (`bootDashboard` in
`packages/e2e/src/dashboard-fixture.ts` starts `vp dev` on :5188 / :5189). The
upgrade worklog even flagged this gap ("Not verified here (needs a running dev
server)"). Both `E2E Tests` and `E2E UI Tests (Playwright)` failed identically
at fixture boot; every other check (incl. Postgres Integration) was green.

## The fix

Revert `wrangler` to `4.94.0` — the exact combination running green on `main`
today (`@cloudflare/vite-plugin@1.38.0` + `wrangler@4.94.0`, including E2E).

- Satisfies Void 0.10.4's `wrangler ^4.90.0` peer.
- The `@cloudflare/vite-plugin@1.38.0` dedup patch is **version-keyed**
  (`pnpm.patchedDependencies` in root `package.json`), so it re-applies verbatim
  — only the composed `patch_hash=…(wrangler@…)` variant key changed.
- **Also clears** the peer warning the upgrade worklog noted: 4.107.0 wanted
  `@cloudflare/workers-types@^4.20260701.1` (resolved 4.20260522.1); 4.94.0 is
  happy with 4.20260522.1.

Rejected the alternative (override `@cloudflare/vite-plugin` → 1.43.0 + re-author
its patch): more invasive, the un-deduped code the patch targets is still present
in 1.43.0, and 4.107.0 buys nothing here — the whole point is to match main's
known-good pairing with minimal surface.

## Files changed

- `apps/dashboard/package.json` — `"wrangler": "4.107.0"` → `"4.94.0"`.
- `pnpm-lock.yaml` — regenerated (`pnpm install`); `@cloudflare/vite-plugin@1.38.0`
  now composes with `wrangler@4.94.0`.
- `docs/worklog/2026-07-03-void-0.10.4-upgrade.md` — corrected the wrangler row +
  the "no functional gain" note to point here.

## Verification

- Resolution: dashboard `wrangler@4.94.0`; `unstable_getWorkerNameFromProject`
  now a `function`; plugin composes with `wrangler@4.94.0`; dedup patch applied.
- `pnpm check` — **0 errors** (121 pre-existing warnings).
- `pnpm --filter @wrightful/dashboard build` — clean (SSR + client + postbuild).
- Unit tests unchanged and green: dashboard 233 (+4 skipped) + 1140 (workers),
  reporter 281.
- E2E dev-server boot itself is verified by **CI** on the re-pushed PR (not run
  locally — no local dev server per project convention, and the E2E fixture
  needs a local Postgres that CI provides).
  </content>
  </invoke>
