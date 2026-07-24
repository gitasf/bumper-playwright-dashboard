# 2026-04-17 — First-run local setup script + seed-api-key update

## What changed

Two pieces of local-dev + deploy ergonomics work, landed together:

1. **`pnpm setup:local`** — a single command that takes a fresh clone from
   "just ran `pnpm install`" to "ready to `pnpm dev`". New contributors (and
   future agents) no longer have to re-derive the sequence from
   `CLAUDE.md` + `wrangler.jsonc` + `.dev.vars.example` each time.
2. **`scripts/seed-api-key.mjs` updated for multi-tenancy.** The script
   predated the `teams` / `projects` / `memberships` tables and was inserting
   an `api_keys` row with no `project_id` — which now violates a `NOT NULL`
   constraint and errored out on every call. Keys are now scoped to a
   specific project via new `--team` and `--project` flags.

## Details

### Setup script

`packages/dashboard/scripts/setup-local.mjs` does two things, both idempotent:

1. Generates `packages/dashboard/.dev.vars` if absent. Reads the template,
   replaces the `replace-me-…` placeholder with a 32-byte base64 secret from
   `webcrypto.getRandomValues` (same strength as `openssl rand -base64 32`).
   Skips if the file already exists so we never clobber a rotated secret or
   GitHub OAuth vars the user has added.
2. Applies local D1 migrations via `wrangler d1 migrations apply DB --local`.
   Already idempotent — reports "No migrations to apply" on the second run.

Surfaced as `pnpm setup:local` at the root. Named with the colon to dodge
pnpm's built-in `pnpm setup` command (shell integration) that shadows
user-defined scripts at the root.

### `seed-api-key.mjs`

New required flags: `--team <slug>` and `--project <slug>`. The script now:

1. Validates both slugs against `/^[a-z0-9-]+$/` (same rule the admin UI
   enforces).
2. Looks up the project via `SELECT p.id … JOIN teams t … WHERE t.slug = ?
AND p.slug = ?`, parsing `wrangler d1 execute --json` output.
3. Errors clearly if not found, pointing at `/admin/teams/new` and
   `/admin/t/<slug>/projects/new`.
4. Inserts the API key row with the resolved `project_id`.

Explicit-lookup (rather than auto-creating a default team/project) is
deliberate: a team created outside the admin UI has no `memberships` row, so
its runs would be invisible to any dashboard user, and the "first API key" is
the one case where the deployer always has a specific project in mind anyway.

## Files changed

| File                                          | Change                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/dashboard/scripts/setup-local.mjs`  | **New.** Node ESM, mirrors the style of `seed-api-key.mjs`. No new deps.                      |
| `packages/dashboard/scripts/seed-api-key.mjs` | Added arg parser; requires `--team` / `--project`; JSON-parses a lookup query; scopes insert. |
| `packages/dashboard/package.json`             | Added `setup:local` script next to `db:seed-api-key`.                                         |
| `package.json` (root)                         | Added `setup:local` alias that filters into the dashboard script.                             |
| `README.md`                                   | Updated deploy + local-dev steps to reference `pnpm setup:local` and the new seed-key flags.  |

## Verification

Ran from a clean state (no `.dev.vars`, no `.wrangler/` local D1):

- `pnpm setup:local` — first run created `.dev.vars` with a real base64
  secret and applied migration `0000_odd_gamma_corps.sql`.
- `pnpm setup:local` (second run) — "already exists — skipping" / "No
  migrations to apply". Exit 0.
- `db:seed-api-key my-laptop --team acme --project web --local` with a
  hand-inserted `acme`/`web` team+project — inserted successfully, printed
  `wrf_live…` key, confirmed row in `api_keys` with correct `project_id` via
  `SELECT`.
- `db:seed-api-key --team ghost --project missing --local` — clean error
  ("no project found…") with pointer to the admin UI.
- `db:seed-api-key --local` (no `--team` / `--project`) — prints usage, exits 1.
- `db:seed-api-key --team "BAD SLUG" --project web --local` — rejected by the
  slug regex.
- `pnpm typecheck` — clean (both packages).
- `pnpm format` — clean (ignoring the gitignored `.context/` plan file).

## Deliberately out of scope

- **Membership bootstrap.** If you run `seed-api-key` against a team whose
  membership rows don't include your current dashboard user, the API key
  will work for CLI uploads but you won't see the runs in the UI. That's an
  existing admin-flow limitation, not something the seed script should
  paper over.
- **E2E's own seeding** in `packages/e2e/vitest.globalSetup.ts` — it already
  bakes its own team + project + membership + API key inline and doesn't
  invoke `seed-api-key.mjs`. Left alone.
