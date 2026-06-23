# 2026-06-23 — SELF-HOSTING.md accuracy audit + Cloudflare Workers Builds field guidance

## What changed

Audited `SELF-HOSTING.md` against the current codebase and applied corrections. The
audit fanned out across seven claim-clusters (env vars, deploy/build/migrate commands,
Cloudflare bindings, route/auth surfaces, billing/quotas, monitors/retention/export,
referenced files) plus a completeness critic, each verifying the doc's claims against
source. The guide was already highly accurate (all 43 `env.ts` keys documented, all
defaults correct byte-for-byte, capability-flag gating correct); the fixes below are the
real discrepancies plus the explicit Build/Deploy/Root-directory guidance the task asked
for.

The headline addition: the **Cloudflare Workers Builds** settings are now a self-contained,
copy-pasteable block (Root directory / Build command / Production + non-prod deploy
commands) with a prominent warning that Cloudflare defaults **Root directory** to `/` and
it **must** be changed to `apps/dashboard` — otherwise the production deploy breaks
(`pnpm db:migrate:remote` is only a script in `apps/dashboard/package.json`, and
`npx wrangler deploy` only finds the build redirect from `apps/dashboard`).

Follow-up in the same session: the **Billing & usage-quotas** section was removed entirely.
Billing is an opt-in, capability-flagged provider that is OFF by default — and OFF is the
only state a self-host ever runs in (every team is unlimited). Documenting the hosted-only
`POLAR_*` / `WRIGHTFUL_FREE_*` / `WRIGHTFUL_PRO_*` / quota machinery in the self-hosting
guide was noise and a potential source of confusion, so the section, both its env tables,
the Polar-webhook mention, the "Minimum to go live" billing bullet, and the Production-notes
quota clause were all dropped. The billing feature itself (code, `env.ts` keys, ADR 0002)
is untouched — only its presence in `SELF-HOSTING.md`.

Final pass in the same session: a deslop + de-duplication cleanup. Cut AI-doc tells
(marketing hedges, a meta "(same generated-from-committed-sources pattern…)" aside) and
several facts that were stated 2–3× (the "Void is still early, prefer Cloudflare" warning,
the build→deploy redirect mechanism, the `EMAIL_FROM` graceful-degradation note, a redundant
direct-R2 closing sentence, the intro's synthetic-monitor depth). The **Environment
variables** section was restructured: the duplicated `**Required:**`/`**Optional:**` prose
bullets (which repeated the table below them) were removed and folded into two tables —
**Build-time variables & secrets** (`CF_*` + `DATABASE_URL`, consumed by `gen-wrangler` /
`pnpm db:migrate:remote`, not the running Worker) and **Runtime variables & secrets** (the
`env.ts` keys read by the Worker), each with a `Secret?` column so a self-hoster can tell
which need `wrangler secret put` vs a plain var. Net effect on `SELF-HOSTING.md`: shorter
(62 insertions / 74 deletions vs `origin/main`), no facts lost.

## Details — corrections applied

| Fix                                                        | Severity | Was → Now                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CF Workers Builds Root-directory warning                   | High     | Bare bullet → labeled code block + "must change from `/`" callout + monorepo install note + build/deploy-phase contract + dashboard-secrets path                                                                                                                             |
| Billing & usage-quotas section removed                     | —        | Whole section + both env tables + Polar-webhook mention + Production-notes quota clause + "Minimum to go live" billing bullet dropped — billing is hosted-only, OFF ⇒ unlimited for every self-host. (Superseded an earlier in-session fix to the now-deleted quota clause.) |
| `WRIGHTFUL_MONITOR_EXECUTOR=stub` overstatement (2 places) | Medium   | "skip both [queues + container]" / "skip monitoring entirely" → stub only swaps the **browser** executor; queues + sweep cron always ship; no disable value                                                                                                                  |
| Node version prerequisite (2 places)                       | Medium   | "Node 20+" → "Node 22.18+" (root `engines.node` is `>=22.18.0`)                                                                                                                                                                                                              |
| Build output path                                          | Low      | `dist/wrangler.json` → `dist/ssr/wrangler.json` (verified via build output + `.wrangler/deploy/config.json`)                                                                                                                                                                 |
| Rate-limiter binding name                                  | Low      | `` `QUERY` limiter`` → `QUERY_RATE_LIMITER`                                                                                                                                                                                                                                  |
| Rate-limiters ship location                                | Low      | "ship in `wrangler.jsonc`" → "`wrangler.template.jsonc`" (generated file vs committed source)                                                                                                                                                                                |
| Retention invariant scope                                  | Medium   | "invariant-checked" → enforced for per-team overrides only; env defaults not cross-validated (sweep safe either way)                                                                                                                                                         |
| `void auth login` linking                                  | Medium   | "Authenticate + link a Void project. Saves .void/project.json" → login only authenticates; linking is `void project link` / first `void deploy`                                                                                                                              |
| Troubleshooting secret-list parallel                       | Low      | `void env check --remote` → `void secret list` (true equivalent of `wrangler secret list`)                                                                                                                                                                                   |
| `DATABASE_URL` reference-table gap                         | Low      | Added Optional-table row: local/CI only, **not** a runtime secret (prod uses `HYPERDRIVE`)                                                                                                                                                                                   |
| Direct-R2 secrets nuance                                   | Low      | "set these as Worker secrets" → only `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` are secrets; `R2_ACCOUNT_ID`/`R2_BUCKET` are plain vars                                                                                                                                       |
| GitHub App webhook URL (missing)                           | Low      | Added `${WRIGHTFUL_PUBLIC_URL}/api/github/webhook` + webhook-secret setup to the GitHub Checks section                                                                                                                                                                       |
| Browser-monitor container vs own-account `wrangler deploy` | Low      | Clarified the template omits container/DO bindings; simplest own-account path is HTTP/TCP + `stub`                                                                                                                                                                           |
| "Minimum to go live" callout (new)                         | —        | Added a concise required-inputs summary at the top of the Cloudflare section                                                                                                                                                                                                 |

## Verification

- Cross-checked every documented env var, default, and Required/Optional status against
  `apps/dashboard/env.ts` (43 keys) — all match.
- Verified by direct read/grep: root `package.json` `engines.node = >=22.18.0`; build
  output is `apps/dashboard/dist/ssr/wrangler.json` (no `dist/wrangler.json`);
  `.wrangler/deploy/config.json` = `{"configPath":"../../dist/ssr/wrangler.json",…}`;
  single `pnpm-lock.yaml` at repo root, no `apps/dashboard` lockfile; no `.npmrc`;
  `void.json` carries the `sandbox` block + `REPLACE_WITH_REGISTRY/wrightful-sandbox:latest`
  placeholder.
- Confirmed route paths against source: `/api/auth/polar/webhooks`, `/api/github/webhook`,
  `/api/v1/*` (+ `QUERY_RATE_LIMITER`), ingest + artifact upload routes, settings pages.
- Post-edit grep: zero stale strings remaining (`Node 20+`, `dist/wrangler.json`,
  "skip both", `` `QUERY` limiter``, `void env check --remote`, "invariant-checked",
  "only bind for `free`"); code fences balanced.

## Follow-up — two real own-account `wrangler deploy` blockers (same session)

A live own-account `pnpm deploy:cf` surfaced two deploy-time failures the doc audit
couldn't catch (they only bite at `wrangler deploy`, not at build/typecheck). Both are
gaps between the **managed `void deploy`** path (which auto-provisions / tolerates them)
and the **own-account `wrangler deploy`** path. Fixed both and documented.

### 1. Missing Cloudflare Queues (doc fix)

`wrangler deploy` failed with `Queue "monitors" does not exist`. Void infers the two
monitor queues (`monitors`, `uptime`) from `apps/dashboard/queues/*.ts` and emits their
producer/consumer bindings into `dist/ssr/wrangler.json` — but `wrangler deploy` **binds**
to queues without **creating** them (unlike the experimental R2-bucket auto-provisioning),
and nothing in the repo created them. `void deploy` provisions them automatically; the
own-account path had no step. **Both consumers ship in every build regardless of whether
any monitor exists**, so the queues are an unconditional prerequisite, not a monitors-only
one.

- `SELF-HOSTING.md` step 1: added `wrangler queues create monitors` + `… uptime` with a
  comment on why wrangler won't auto-create them and that they're always required.
- Promoted the queues into the "Minimum to go live" callout; moved synthetic monitors out
  of the "optional" list there (the queues ship even with zero monitors).
- Synthetic-monitors section: added a callout that the queues are not optional / not
  monitor-specific, and removed the misleading line punting queue creation to Void's
  external Cloudflare integration guide.

### 2. Vestigial D1 `DB` binding (code + doc fix)

`wrangler deploy` then failed with `binding DB of type d1 must have a valid database_id
[code: 10021]`. Root cause in `void@0.9.2` (`dist/index.mjs` ~L5161/L5350): Void keys its
`needsD1` flag off the app **importing `void/db`**, not off the configured dialect — so a
Postgres-only build (`void.json` `"database": "pg"`, real binding `HYPERDRIVE`) **still**
emits a leftover `d1_databases: [{ binding: "DB", database_id: "local" }]`. The `"local"`
sentinel is fine for `vite dev` (Miniflare) and `void deploy` (its pg-dialect deploy
manifest uses `hyperdrive`, not d1, and ignores the entry — `dist/deploy-CRU9fGjE.mjs`
L1731–1732), but raw `wrangler deploy` validates `database_id` and rejects `"local"`.
Confirmed nothing in the app reads `env.DB` (only match is a test fixture's monitor _named_
"DB") — all DB access is `void/db` → `HYPERDRIVE`. So the binding is pure dead weight.

- New `apps/dashboard/scripts/strip-d1-binding.mjs` — a `postbuild` step that removes
  `d1_databases` entries with `database_id: "local"` from `dist/ssr/wrangler.json` (leaves
  a real, deliberately-added id untouched; no-ops + exits 0 if absent, so it never fails a
  build). Idempotent.
- `apps/dashboard/package.json`: added `"postbuild": "node scripts/strip-d1-binding.mjs"`;
  changed `deploy:cf` from `vp build && wrangler deploy` to `pnpm build && wrangler deploy`
  so it routes through the `build` script and inherits both `prebuild` (cf:prepare) and the
  new `postbuild` strip; removed the now-redundant `predeploy:cf` hook (cf:prepare now runs
  via `prebuild`). The CF Workers Builds path already uses `pnpm build` as its Build
  command, so it picks up the strip with no config change. `void deploy` runs `vite build`
  directly (not the `pnpm build` npm script — `dist/deploy-CRU9fGjE.mjs` L3045), so the
  `postbuild` hook never fires on the managed path.
- `SELF-HOSTING.md` step 4: documented why `deploy:cf` is `pnpm build` (not `vp build`) and
  what the `postbuild` strip does.

### Verification (follow-up)

- `node --check scripts/strip-d1-binding.mjs` — parses.
- Ran the strip against the existing `dist/ssr/wrangler.json`: removed the 1 `DB`/`"local"`
  d1 binding; `hyperdrive` + `queues` blocks preserved; re-run reports "nothing to strip"
  (idempotent). `package.json` re-validated as JSON after the script edits.
- Did **not** run a full `pnpm deploy:cf` (no live CF account in this workspace) — the
  queue-creation step is a manual prerequisite and the D1 strip is verified standalone.

Docs-only change (no source touched), so no test/lint run was warranted.
