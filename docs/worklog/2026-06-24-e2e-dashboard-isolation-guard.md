# 2026-06-24 — Dashboard e2e isolation guard + CI Postgres service

## What changed

The dashboard UI e2e suite (`packages/e2e`, `test:dashboard`) boots a **real**
dashboard via `bootDashboard`, which overwrites `apps/dashboard/.env.local` and
runs `void db reset` (destructive) against `DATABASE_URL`. Post-Postgres-migration
that gave the suite two sharp edges that bit during dogfooding:

1. **Data loss.** If `DATABASE_URL` pointed at your dev database, `void db reset`
   wiped it. And with no `DATABASE_URL` set at all, the suite simply failed to
   boot (`DATABASE_URL not found in .env.local`).
2. **Dev-server thrash.** A running `pnpm dev` watches the same `.env.local` the
   suite overwrites, so it got dragged onto the e2e DB mid-run and wedged — and
   its dev data went with it.

Both are now structurally prevented by a guarded wrapper, and the `test-e2e-ui`
CI job — which had **no Postgres service or `DATABASE_URL`** (flagged as a
follow-up in `2026-06-24-embedded-trace-replay.md`) — now provisions one.

## Details

| Area             | Change                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Guarded wrapper  | New `packages/e2e/scripts/run-dashboard-e2e.mjs`. `test:dashboard` now runs it instead of invoking Playwright directly; `test:dashboard:raw` keeps the unguarded `npx playwright test --config=playwright.dashboard.config.ts` as an escape hatch.                                                                                                                 |
| DB isolation     | Resolves an e2e `DATABASE_URL` that is **never** the dev DB: explicit `E2E_DATABASE_URL` wins; otherwise it takes `DATABASE_URL` / `.env.local`'s value and, unless the db name already ends in `_e2e`/`_test`, **suffixes `_e2e`** (e.g. `wrightful_dev` → `wrightful_dev_e2e`). So even a misconfigured `DATABASE_URL=…wrightful_dev` can't be the reset target. |
| DB auto-create   | Connects to the server's `postgres` maintenance DB (via `pg`, already transitive through `drizzle-orm/node-postgres`) and `CREATE DATABASE` the e2e DB if missing. `42P04` (already exists) is a no-op; managed-Postgres failures (Neon forbids it) downgrade to a warning + continue rather than hard-fail.                                                       |
| Dev-server guard | Probes `:5173` on **both** loopback families (`127.0.0.1` + `::1` — `vp dev` binds IPv6 on macOS) and refuses to run if a dev server is up, with a message pointing at `E2E_ALLOW_DEV_SERVER=1` to override. This is the direct fix for the thrash.                                                                                                                |
| CI               | `.github/workflows/ci.yml` `test-e2e-ui` gains a `postgres:16` service (`POSTGRES_DB: wrightful_e2e`, health-checked, mirroring `test-postgres`) and `DATABASE_URL: …/wrightful_e2e`. The wrapper sees a `_e2e` name → uses it as-is; `CREATE DATABASE` no-ops against the service's pre-created DB.                                                               |

CLI args pass straight through, so `pnpm --filter @wrightful/e2e test:dashboard --headed test-replay` works as before — just guarded.

## Why this shape

The fragility is inherent to the fixture sharing `.env.local` with the dev server
(by design — Void's `vp dev` only reads `.env*`). Rather than re-architect the
fixture's env strategy (higher blast radius), the wrapper makes the two failure
modes impossible to hit accidentally while leaving the suite itself untouched.
Both safety nets have explicit, documented overrides for the cases that want them
(a dedicated test DB via `E2E_DATABASE_URL`; an intentional concurrent run via
`E2E_ALLOW_DEV_SERVER`).

## Verification

- **Guard fires:** with `pnpm dev` live on `:5173`, `test:dashboard` aborts before
  touching anything — `.env.local` unchanged, dev server still HTTP 200. ✓
- **IPv6 detection:** confirmed the dev server binds `[::1]:5173`; a 127.0.0.1-only
  probe missed it (caught + fixed to probe both families). ✓
- **Happy path:** with the dev server stopped and **no** `DATABASE_URL` set, the
  wrapper derived `wrightful_dev_e2e`, **auto-created** it, booted the suite, and
  ran `test-replay` → **3 passed**. The dev DB (`wrightful_dev`) was untouched
  afterward (still 3 runs / 27 tests), `.env.local` restored, no backup left. ✓
- **Static checks:** `pnpm check` → exit 0 (0 errors, 114 warnings = pre-existing
  baseline; the new script + CI yaml add none). ✓

## Follow-ups (not in this change)

`SELF-HOSTING.md` / the e2e README could document `E2E_DATABASE_URL` +
`E2E_ALLOW_DEV_SERVER`; the same guard pattern could front the dogfood
`test:e2e` suite if it ever grows a destructive boot.
