# 2026-07-23 — pnpm 11, Vite+/void toolchain bump, patch reconciliation, and full dependency sweep

## What changed

Updated the package manager and the core toolchain/framework dependencies,
reconciled the local patch set against upstream fixes that shipped in void
0.10.10, and then swept every remaining outdated direct dependency in the
workspace (including majors) up to latest.

### Package manager

- `pnpm` **10.33.0 → 11.16.0** (`packageManager` in `package.json`, pinned with
  integrity hash).
- pnpm 11 no longer reads the `pnpm` field in `package.json`. Moved
  `onlyBuiltDependencies` and `patchedDependencies` into `pnpm-workspace.yaml`
  (the `allowBuilds` map there is `vp`-managed and left in place).
- pnpm 11 ships a default **minimum-release-age** supply-chain gate. `vite-plus`
  0.2.6 was published the same day, so pnpm recorded a
  `minimumReleaseAgeExclude` block in `pnpm-workspace.yaml` to allow it. Removing
  that block will re-block a frozen install until 0.2.6 ages past the window.

### Toolchain / framework

- Vite+ catalog: `vite-plus` **0.2.2 → 0.2.6**, `@voidzero-dev/vite-plus-core`
  (the `vite` catalog alias) **0.2.2 → 0.2.6**, `vitest` **4.1.9 → 4.1.10** (all
  pinned together by `vite-plus@0.2.6`).
- `void` + `@void/react` **0.10.4 → 0.10.10**.
- `better-auth` (dashboard) **^1.6.11 → ^1.6.24**. void 0.10.10 depends on
  `better-auth ^1.6.23`; the old `^1.6.11` pin resolved a second copy (1.6.11)
  alongside void's 1.6.24, and mixing the two type surfaces broke the
  `VoidAuthConfig` shape and the Polar client-plugin inference (4 `tsc` errors in
  `auth.ts`, `src/lib/auth-client.ts`, and `billing-actions.tsx`). Aligning the
  range dedupes to a single `better-auth@1.6.24` and clears all four.

### Patch reconciliation

Two of the local patches were fixed upstream in void 0.10.10
(void-sdk/void#76, #77, both closed 2026-07-06; 0.10.10 released 2026-07-09):

- **Dropped `patches/@void__react@0.10.4.patch`** entirely — #76 (deferred-page
  `useId` hydration mismatch). 0.10.10 implements the same fix cleanly:
  `pages-server.mjs` keeps the shell-end marker and wraps the deferred page in
  `Fragment + <template>`, and `pages-client.mjs` reproduces that root shape on
  hydrate keyed on `initialPageData.deferredKeys`.
- **Trimmed `patches/void@0.10.10.patch`** to only the Postgres-Pool hunk. The
  `dist/pages/protocol.mjs` `X-VoidPages` hunk — #77 (deferred pages hard-reload
  on SPA nav) — is fixed upstream in `handlePageGet`, so it was removed. The
  workerd fresh-`pg.Pool`-per-request fix in `dist/index.mjs` is **not**
  upstreamed and is retained.
- **Re-keyed `patches/@cloudflare__vite-plugin` 1.38.0 → 1.46.0** (void 0.10.10
  requires `@cloudflare/vite-plugin ^1.43.0`). The `compatibility_flags` dedup is
  unchanged and still needed. Regenerated with `pnpm patch` rather than
  hand-carried — pnpm's applier rejected the old hunk's large line-number drift.

### Full dependency sweep

Every remaining outdated direct dependency was bumped to latest, in verified
batches (`check` + tests + `build` after each) so breakage stayed isolated. No
code changes were required by any of them; type-check and tests stayed green
throughout.

- **Safe patch/minor:** react + react-dom `19.2.7→19.2.8`, hono `→4.12.31`,
  `@tanstack/react-query` `→5.101.4`, tailwindcss + `@tailwindcss/vite` `→4.3.3`,
  `@uiw/react-codemirror` `→4.25.11`, `@fontsource-variable/*` `→5.3.0`,
  `@hono/mcp` `→0.3.1`, better-all `→0.0.8`, `@electric-sql/pglite` `→0.5.4`,
  happy-dom `→20.11.0`, `@vitejs/plugin-react` `→6.0.4`, `@changesets/cli`
  `→2.31.1`, `@vitest/coverage-v8` `→4.1.10` (re-aligned to the vitest bump).
- **Same-major medium:** wrangler `4.101.0→4.113.0`,
  `@cloudflare/vitest-pool-workers` `0.16.16→0.18.7`, `@polar-sh/sdk`
  `0.47.1→0.49.0`, react-email + `@react-email/ui` `6.6.4→6.9.0`,
  `@typescript/native-preview` `→7.0.0-dev.20260707.2`. Verified the workers test
  lane and build.
- **Majors (no code changes needed):** `@types/node` `25→26`, typescript
  `6→7`, `@visx/*` `3→4`, react-day-picker `9→10`, `@testing-library/jest-dom`
  `6→7`, `@redwoodjs/agent-ci` `0.10.7→0.17.1`. react-day-picker v10 keeps all
  the v9 `classNames` keys and the `Chevron` component the `ui/calendar.tsx`
  wrapper relies on; visx v4's group/scale/shape surface is unchanged.
- **lucide-react `0.469.0→1.25.0`:** v1 removed brand icons, so the former
  `Github` icon no longer exists. Added a shared `src/components/github-icon.tsx`
  (the same inline GitHub mark already used in `login.tsx`) and swapped it into
  `settings/profile.tsx` and `settings/teams/[teamSlug]/general.tsx`.
- **Deprecated packages:** removed `@base-ui-components/react@1.0.0-rc.0` — it was
  renamed to `@base-ui/react` (already a dependency, 43 import sites) and had zero
  remaining imports.
- **react-email v6 consolidation:** per the react.email v5→v6 upgrade guide,
  `@react-email/components` is deprecated because every component and the `render`
  helper moved into the top-level `react-email` package (already on `6.9.0`).
  Migrated all imports from `@react-email/components` to `react-email` across the
  five email files (`emails/components.tsx`, `emails/layout.tsx`,
  `emails/monitor-alert.tsx`, `lib/render-email.tsx`,
  `__tests__/render-email.test.tsx`), verified `react-email` exports every symbol
  used, and removed the `@react-email/components` dependency — which pruned 22
  now-unused deprecated `@react-email/*` transitive packages. The email render
  test still passes. After this, `pnpm -r outdated` is empty.
- **GitHub Actions:** `actions/checkout` `v4→v7`, `actions/setup-node` `v4→v7`,
  `actions/upload-artifact` `v4→v7`, `pnpm/action-setup` `v4→v6` across
  `ci.yml`/`release.yml`. action-setup still reads `packageManager` (no `version`
  input); step ordering (action-setup before setup-node's `cache: pnpm`) is
  preserved. These can only be fully validated by CI actually running.

## Verification

- `pnpm install --frozen-lockfile` — clean (CI parity).
- `pnpm check` — 0 errors (150 pre-existing warnings).
- `pnpm test` — dashboard + reporter + workers suites all pass.
- `pnpm --filter @wrightful/dashboard build` — succeeds; the cloudflare
  `compatibility_flags` patch and void post-build scripts run.
- Confirmed the linked packages carry the intended patch state: `void@0.10.10`
  patched (Postgres, `_prodInstance` removed), `@void/react@0.10.10` unpatched
  (upstream fix), `@cloudflare/vite-plugin@1.46.0` patched (dedup).

## Notes

- `vite-plus@0.2.6` was ~7 hours old at bump time; kept via the pnpm 11
  release-age exclude. Hold it at 0.2.2 if the recency is a concern.
- The new oxfmt (in vite-plus 0.2.6) surfaced malformed CommonMark in two
  historical worklogs; the `2026-06-17` file's escaped-backtick code span was
  corrected to a balanced double-backtick span so it renders as intended and is
  formatter-stable.
