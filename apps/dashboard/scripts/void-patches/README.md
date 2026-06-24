# Void deploy patches (temporary)

These scripts patch the built worker config (`dist/ssr/wrangler.json`) so an
**own-account `wrangler deploy`** (the `pnpm deploy:cf` path) succeeds. They are
**temporary workarounds for confirmed Void build-vs-deploy bugs**: `vite build`
emits a config tuned for the managed `void deploy` (which patches/ignores these at
deploy time), so a raw `wrangler deploy` of the same artifact fails validation.

They run as the dashboard's `postbuild` hook (`apps/dashboard/package.json`), so
they cover both `pnpm deploy:cf` and the Cloudflare Workers Builds path. `void
deploy` runs `vite build` directly (not the `pnpm build` npm script), so these
**never touch the managed path**.

Each script is idempotent and exits 0 if there's nothing to do (or no build output
yet), so it never fails a build.

Clean-room repro of both bugs: `/Users/joefairburn/void-pg-d1-repro` (its README is
written to be filed as an upstream issue).

## Patches

### `strip-d1-binding.mjs` — vestigial D1 binding on Postgres projects

- **Error:** `binding DB of type d1 must have a valid database_id [code: 10021]`
- **Cause:** Void infers a `DB`/`D1Database` binding from the `void/db` import
  regardless of dialect (`index.mjs` ~L5161), emitting it with the dev sentinel
  `database_id: "local"`. A Postgres app's real binding is `HYPERDRIVE`; nothing
  reads `env.DB`.
- **Fix:** drop `d1_databases` entries whose `database_id` is `"local"`.
- **Teardown:** delete when a pg build's `dist/ssr/wrangler.json` no longer carries
  a `d1_databases` entry. (Reproduced on `void@0.9.3`.)

### `add-ws-do-migration.mjs` — missing `void/ws` Durable Object migration

- **Error:** `Cannot create binding for class 'Ws…' … not currently configured to
implement Durable Objects [code: 10061]`
- **Cause:** a one-line guard bug in the build's migration emission (`index.mjs`
  ~L5199): the websocket block adds its migration only
  `if (!Array.isArray(resolved.migrations))`, but `migrations` is always
  pre-initialized to `[]`, so it never fires. The sandbox (~L5221) and live
  (~L5234) DO blocks instead check membership with `.some()` and append, and work
  — the ws block is the only one using `!Array.isArray()`. Independent of the
  sandbox (verified via a negative control in the repro).
- **Fix:** add a `{ tag: "void-ws-v1", new_classes: [...] }` migration for any DO
  binding class missing from `migrations`, mirroring Void's own shape and tag.
- **Teardown:** delete when the build emits the ws DO migration itself.

## Removing all of this

When both bugs are fixed upstream: delete this folder, drop the `postbuild` hook
from `apps/dashboard/package.json`, and point `deploy:cf` back at `vp build`.
Reusing Void's exact migration tag (`void-ws-v1`) means the teardown is clean — no
duplicate/conflicting migration once Void emits its own.

## Upstream issues

- D1 binding leak: `<add link once filed>`
- `void/ws` DO migration: `<add link once filed>`
