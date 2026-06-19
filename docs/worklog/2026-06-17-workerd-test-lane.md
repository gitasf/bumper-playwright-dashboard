# 2026-06-17 — workerd test lane (pool-workers) + runtime-split test architecture

## What changed

Adopted `@cloudflare/vitest-pool-workers` as an **additive** test lane that runs
suites inside the real workerd runtime (miniflare), and split the dashboard test
suite by the runtime each test's code-under-test actually targets:

- **Server-side code** (db layer, ingest, query building) → the new **workerd
  lane**. This is the code that runs in workerd in production, so testing it
  there catches runtime incompatibilities the Node-with-stubs lane silently
  hides.
- **Client/component code** (React islands, hooks) → stays on the **Node +
  happy-dom lane**. These run in the _browser_ in production, not workerd, so
  happy-dom is the faithful environment.
- **DB-integration** (pglite) and **disk/native-addon-bound** tests → stay on
  Node (see denylist below — they can't run in workerd).

Routing is by the **`*.workers.test.ts` filename suffix**: tag a suite with it to
move it to the workerd lane. The Node lane excludes that glob so nothing
double-runs.

## Empirical basis

Before splitting, ran the _entire_ `__tests__` suite through pool-workers to see
what actually passes in workerd: **1125 / 1139 passed, with zero logic
failures.** Every failure was a workerd _environment_ incompatibility, not a
broken test:

| File                           | Cause                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `artifacts-pipeline` (2 tests) | `readdirSync(db/migrations)` — workerd fs sandbox                                   |
| `rate-limit-config`            | `readFileSync(wrangler.jsonc)` — workerd fs sandbox                                 |
| `pg-integration`               | pglite can't `readFile` its `pglite.data` WASM payload off disk                     |
| `rate-limit`                   | pulls `@napi-rs/keyring`, a native `.node` addon (unloadable in workerd)            |
| `use-room-reseed`              | `@testing-library`/`aria-query` CJS↔ESM interop fails under workerd's module runner |

This list is the **denylist** that stays on the Node lane. Notably, `vi.mock`
works fine in workerd (used across the 1125 passing tests), and most DOM-ish
tests passed — the one DOM failure was a CJS-interop issue, not "no `document`".

## Details

| Item     | Value                                                                                                                                                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New deps | `@cloudflare/vitest-pool-workers@0.16.16`; `pg@8.21.0` + `@types/pg` (dashboard dev deps — for the real-DB-in-workerd lane below; pg was previously only transitive via Void)                                                             |
| API      | `cloudflareTest(options): Vite.Plugin` from the package main. The old `@cloudflare/vitest-pool-workers/config` subpath + `defineWorkersConfig`/`defineWorkersProject` are **gone** in 0.16.x (a `vitest-v3-to-v4` codemod ships with it). |
| Prereq   | The vite-plus 0.2.0 upgrade (upstream `vitest@4.1.9`) — pool-workers peers `vitest ^4.1.0`, so the old `@voidzero-dev/vite-plus-test` fork could not have hosted it.                                                                      |

**`apps/dashboard/vitest.workers.config.ts`** — `cloudflareTest({ miniflare: {
compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"] } })`.
Inline miniflare (no `wrangler.configPath`), so it's self-contained and CI-safe:
no dependency on the gitignored/generated `wrangler.jsonc`, and it doesn't bundle
the app worker. Aliases mirror the Node test mode (`@`, `@schema`, `void/db` →
stub); `cloudflare:workers` is deliberately NOT aliased so pool-workers provides
the real module. Glob: `src/**/*.workers.test.{ts,tsx}`.

**`apps/dashboard/vite.config.ts`** — added `test.exclude: [...configDefaults.exclude,
"**/*.workers.test.{ts,tsx}"]` so suffix-tagged suites don't double-run in Node.

**`apps/dashboard/package.json`** — `test` now runs both lanes
(`vp test run && vp test run -c vitest.workers.config.ts`); added `test:node`
(Node-only) and `test:workers` (workerd-only).

**Migration was done in two passes.** First an initial 7-suite core
(`db-batch`, `chunk-insert-rows`, `summary-from-batch`, `scope-where`,
`runs-filters-where`, `ingest-pipeline`, `reconcile-and-broadcast`), then a full
sweep of every remaining server-side `.test.ts`. **96 files now run on the
workerd lane**; only 13 stay on Node, by design:

- **Denylist** (genuinely can't run in workerd — the 5 from the empirical run):
  `pg-integration`, `artifacts-pipeline`, `rate-limit`, `rate-limit-config`,
  `use-room-reseed`.
- **Client/browser code** (the browser is their runtime, not workerd):
  `use-room-sharing`, `ws-rooms`, `theme-init-script`, `numeric-sparkline`,
  `live-duration`.
- **All `.tsx`** (React rendering — happy-dom is the natural home):
  `auth-email`, `render-email`, `alerts`.

Routing rule for new tests: a server-side suite is `*.workers.test.ts`; a
client/component or denylist suite is a plain `*.test.ts(x)`.

## Real-DB-in-workerd lane (the production data path)

A third, opt-in lane (`apps/dashboard/vitest.workers.db.config.ts`,
`pnpm test:workers:db`) exercises the **production data path** that nothing else
covered: **node-postgres over a Hyperdrive binding, inside workerd.** The pglite
Node lane can't reproduce node-postgres result shapes, and `pg-integration.test.ts`
(pinned `@vitest-environment node`, direct node-postgres) never goes through
workerd or a Hyperdrive binding.

- The config wires a miniflare **Hyperdrive binding** from `DATABASE_URL` /
  `PG_TEST_URL` (or `.env.local`). With no URL the binding is omitted and the
  test self-skips (`describe.skipIf(!env.HYPERDRIVE)`), so a no-infra run is safe.
- `src/__tests__/db-hyperdrive.workers-db.test.ts` is a deliberate **smoke
  test**: it connects via `env.HYPERDRIVE.connectionString` and asserts the prod
  driver loads + runs a query in workerd, plus one shape check (node-postgres
  returns `int8` count **as a string** — the trap pglite hides). It does NOT
  re-derive the data seam (`runRows`/`cast`/`numericSql`) — those are
  driver-level and already covered against node-postgres in `pg-integration.test.ts`
  (Node). The unique thing this lane guards is "the prod driver loads + connects
  in the prod runtime", which the smoke captures without the `void/db`-mock +
  table-DDL machinery a fuller test would need.
- Routed by the `*.workers-db.test.ts` suffix; the Node lane's exclude is
  `**/*.workers*.test.{ts,tsx}` so it never tries to run it in Node (where
  `cloudflare:test` isn't resolvable).
- **Getting node-postgres to load in pool-workers took two resolution fixes**
  (in the config): (1) pin pg's dual ESM/CJS sub-packages
  (`pg-protocol`/`pg-pool`/`pg-connection-string`) to their `require` (CJS)
  builds — vite resolves the `import` (ESM) condition, which the workerd loader
  evaluates as CJS and dies on; (2) alias `pg-cloudflare` (pg's
  `cloudflare:sockets` adapter) straight to its real `dist/index.js` — its
  exports gate the real impl behind the `workerd` condition, falling back to a
  `default: dist/empty.js` stub (no `CloudflareSocket`) that vite picks instead.

## Verification

- **Workers lane** (`pnpm test:workers`): 96 files / 1038 tests ✓ (in workerd)
- **Node lane** (`pnpm test:node`): 13 files / 129 tests ✓
- **Real-DB lane** (`pnpm test:workers:db`, against the local `wrightful-pg`
  postgres:16 on :5433): 1 file / 2 tests ✓ (node-postgres over Hyperdrive in
  workerd)
- **Combined** (`pnpm test`): both default lanes green ✓ (the DB lane is opt-in,
  kept out of `pnpm test` since it needs a database)
- **Counts reconcile**: 1038 + 129 = 1167 = 1164 original + 3 smoke tests; 96 + 13
  = 109 files = 108 original + 1 smoke. Nothing dropped or double-run.
- **`vp check`**: 0 errors (note: the first run after a file-set change can flake
  on a stale type-aware-lint cache — it reports phantom errors once, then is
  stable at 0 on rerun).

## Notes / follow-ups

- The remaining server-side suites are all migrated; only the denylist + client +
  `.tsx` set above stays on Node (intentional).
- The real-DB-in-workerd lane is **done** (see section above). Natural CI follow-up:
  run `pnpm test:workers:db` as a dedicated step with `DATABASE_URL`/`PG_TEST_URL`
  pointed at the `services:` Postgres (alongside the existing real-pg leg of
  `pg-integration.test.ts`); it self-skips when no DB is configured.
- A single unified vitest report (vs two sequential `vp test run`s) would need a
  `test.projects` root config; deferred — the combined script is simpler and the
  inline-miniflare lane removed the only CI-coupling reason to rush it.
