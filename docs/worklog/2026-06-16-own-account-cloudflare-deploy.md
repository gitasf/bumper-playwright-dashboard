# 2026-06-16 — Own-account Cloudflare deploy (env-driven wrangler config)

## What changed

Added a first-class path to deploy the dashboard to a **self-hosted Cloudflare
account** via `wrangler deploy` (alongside the existing `void deploy` to the Void
managed platform), with all deployment-specific resource IDs sourced from env
vars so the OSS repo commits none of them. This is the "[Deploy to your own
Cloudflare account](https://void.cloud/integrations/cloudflare)" flow from Void's
integration guide, wired for Postgres-over-Hyperdrive.

Motivation: we're hosting on our own Cloudflare. In that model you supply a
`wrangler.jsonc` with real binding IDs (Void's plugin merges it by name); for the
managed platform Void provisions resources itself. The two models needed to
coexist without baking account IDs into the shared repo.

## Approach: generated `wrangler.jsonc` from a committed template

Mirrors the repo's existing "committed source → materialized artifact" convention
(`apply-dialect.mjs` → `void.json` + `db/migrations/`):

- **`wrangler.template.jsonc`** (committed) — the static, shared worker config
  Void's own schema can't express (rate-limiters, the `send_email` binding,
  `dev.enable_containers`). Carries a `__CF_WORKER_NAME__` marker and a
  `// __CF_OWN_ACCOUNT_BINDINGS__` marker. **No account-specific IDs.**
- **`scripts/gen-wrangler.mjs`** — string-substitutes the template into
  `wrangler.jsonc`, injecting bindings from env (read from `process.env` then
  `.env.local`/`.env`, like `apply-dialect`):
  - `CF_WORKER_NAME` → worker name (default `wrightful-dashboard-void`).
  - `CF_R2_BUCKET` → `r2_buckets[STORAGE].bucket_name` (block omitted if unset).
  - `CF_HYPERDRIVE_ID` → `hyperdrive[HYPERDRIVE].id` — **only** when set AND
    `WRIGHTFUL_DB_DIALECT=pg` (so D1 builds never get a stray Hyperdrive binding).
  - With **no `CF_*` set**, output is the generic fallback — functionally
    identical to the historical committed `wrangler.jsonc`, so dev and
    `void deploy` are unchanged.
- **`wrangler.jsonc` is now gitignored** (generated). One-time adoption step:
  `git rm --cached apps/dashboard/wrangler.jsonc`.

Queues, the `void/ws` Durable Objects, and the sandbox Container stay
Void-inferred/managed — not declared in the template.

## Details

| File                              | Change                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrangler.template.jsonc`         | New committed source (was `wrangler.jsonc`'s content + markers + updated header).                                                                                                                                                                                                                                                                              |
| `scripts/gen-wrangler.mjs`        | New generator (env → `wrangler.jsonc`).                                                                                                                                                                                                                                                                                                                        |
| `wrangler.jsonc`                  | Now generated + gitignored.                                                                                                                                                                                                                                                                                                                                    |
| `.gitignore`                      | + `wrangler.jsonc`.                                                                                                                                                                                                                                                                                                                                            |
| `package.json`                    | New `wrangler:gen`, `cf:prepare` (= apply-dialect + gen-wrangler); `predev`/`prebuild`/`predeploy`/`prepare:void` route through `cf:prepare`; new `deploy:cf` (`vp build && wrangler deploy`) + `predeploy:cf`; new `predb:migrate` (materialize migrations before `db:migrate`). `pretypecheck` stays apply-dialect-only (tsgo doesn't read wrangler config). |
| `.env.example`                    | Documented `WRIGHTFUL_DB_DIALECT`, `DATABASE_URL`, and the deploy-time `CF_*` knobs (explicitly NOT worker runtime vars, so NOT in `env.ts`).                                                                                                                                                                                                                  |
| `docs/self-hosting-cloudflare.md` | New end-to-end guide (resources → env → migrations → `deploy:cf`), incl. the Postgres-migration caveat.                                                                                                                                                                                                                                                        |

`deploy:cf` calls `vp build` directly (not `pnpm run build`), which does NOT fire
the `prebuild` hook — so `predeploy:cf` runs `cf:prepare` to materialize
`wrangler.jsonc` first. (Load-bearing, not redundant.)

## Caveats captured in the docs

- **Postgres migrations don't auto-apply on `wrangler deploy`** (that lifecycle
  is D1-only / `void deploy`-only). Apply with `pnpm db:migrate` against the prod
  `DATABASE_URL`.
- **Sandbox container** `platformImage` must point at a registry your account can
  pull (or run monitors with `WRIGHTFUL_MONITOR_EXECUTOR=stub`).
- Local pg dev connects **directly** via `DATABASE_URL` (Hyperdrive is prod-only),
  so `CF_HYPERDRIVE_ID` is a deploy-time-only knob.

## Follow-up: Cloudflare Workers Builds CD + remote migration runner

For self-hosters, deployment is driven by **Cloudflare Workers Builds**
(Git-connected CD) rather than GitHub Actions: connect the repo, push to `main`,
CF builds + migrates + deploys. CF Builds runs a **build command** then a
**deploy command** (prod default `wrangler deploy`; non-prod
`wrangler versions upload`), with dashboard-set build variables/secrets and a
monorepo **root directory**.

- **`scripts/migrate-remote.mjs`** (new, `pnpm db:migrate:remote`) — the keystone.
  `void db migrate` (pg) reads `DATABASE_URL` from `.env.local` **only** (no
  `process.env` fallback), so it can't run in a build env where the connection is
  a build secret. The runner materializes the active dialect's migrations and:
  - pg → `$DATABASE_URL` wins; written to a **temp `.env.local`** so `void db
migrate` can read it, then the original `.env.local` is **restored** (never
    disturbs local dev). d1 → `wrangler d1 migrations apply $CF_D1_NAME --remote`.
- **Migrations run in the _production_ deploy command** (`pnpm db:migrate:remote &&
wrangler deploy`), NOT the build command — the build command runs for every
  branch incl. previews, and prod must never be migrated from a feature-branch
  build. Non-prod deploy command stays `versions upload` (no migration).
- The generated-`wrangler.jsonc`-from-build-vars design fits CF Builds perfectly:
  IDs come from build variables, injected at build time, never committed.
- **`docs/self-hosting-cloudflare.md`** rewritten with the CF Builds dashboard
  config (root dir, build/deploy commands, build vars `WRIGHTFUL_DB_DIALECT`/`CF_*`,
  build secret `DATABASE_URL`, runtime secrets), the prod-only-migration gating,
  the egress caveat (DB must be reachable from CF's build env), and an
  expand/contract migration-safety section (migrate-before-deploy is safe only for
  additive changes; recover via re-run or code-rollback; migrations are
  forward-only + tracked via `_void_migrations`).

## Verification

- `scripts/gen-wrangler.mjs` validated three ways: no env → generic fallback
  (name `wrightful-dashboard-void`, 5 rate-limiters, `send_email`, no
  hyperdrive/r2); `pg` + `CF_HYPERDRIVE_ID` + `CF_R2_BUCKET` → both bindings
  injected with the right values; `d1` + `CF_HYPERDRIVE_ID` → Hyperdrive
  correctly suppressed (dialect guard). Output parses as valid jsonc.
- **`db:migrate:remote` validated end-to-end against a real `postgres:16`**
  (Docker): `DATABASE_URL` via `process.env` (the CF Builds path) → applied the
  pg migration, created all 23 tables + `_void_migrations`; `.env.local` confirmed
  absent before AND after (temp-write/restore works — no working-tree pollution).
- `pnpm check` → 0 errors. Working tree left with the default (fallback)
  `wrangler.jsonc` and d1 dialect.

## Follow-up: docs consolidation + D1 deploy-binding fix

A docs audit ("are all docs up to date?") caught two things:

- **`gen-wrangler` didn't inject the D1 binding** — it only emitted `hyperdrive`
  (pg) + `r2`, so the **default D1** own-account deploy path had no real `DB`
  binding (Void inference would placeholder it). Fixed: `gen-wrangler` now injects
  `d1_databases[DB]` (with `migrations_dir`) from `CF_D1_ID`/`CF_D1_NAME` when the
  active dialect is d1 — the dialect-correct twin of the pg `hyperdrive` block.
  Validated all three paths (default → no bindings; d1 → `d1_databases`; pg →
  `hyperdrive`; dialect guard suppresses the wrong one). `.env.example` +
  `wrangler.template.jsonc` comment updated for `CF_D1_ID`/`CF_D1_NAME`.
- **The standalone `docs/self-hosting-cloudflare.md` duplicated the existing
  canonical `SELF-HOSTING.md`** (which already documented own-account deploy, but
  via the old hand-edited-`wrangler.jsonc` approach that the generated-config
  change broke). Consolidated: deleted the standalone doc and reconciled
  `SELF-HOSTING.md` to the env-driven generated-`wrangler.jsonc` (Option B)
  approach — env-var IDs, Postgres/Hyperdrive, Cloudflare Workers Builds CD,
  `db:migrate:remote`, expand/contract safety. Same pass fixed the dual-DB +
  `void/live`→`void/ws` staleness across README / both CLAUDE.md / ARCHITECTURE /
  PRD (additive 2026-06 note, history preserved) / the synthetic-monitoring design
  doc; dated `docs/reviews/*` and worklogs left as historical record.
