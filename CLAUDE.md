# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Wrightful

Wrightful is a Playwright test reporting dashboard. A custom Playwright reporter streams test results live to a [Void](https://void.cloud)-based dashboard on Cloudflare that stores auth/tenancy and test data in a single SQLite-backed D1 database (via Drizzle) and artifacts in R2. Realtime run progress is broadcast over `void/live`.

## Monorepo Structure

pnpm workspace, `apps/*` + `packages/*`:

- **`apps/dashboard`** — the dashboard app (`@wrightful/dashboard`), built on [Void](https://void.cloud) (a fullstack Vite plugin + deploy platform for Cloudflare). Hono file-based API routing (`routes/`) + Inertia-style server-rendered pages (`pages/` + `@void/react`) with co-located `*.server.ts` loaders/actions. **Single D1 database + Drizzle** (`void/db`, schema in `db/schema.ts`) holds everything — users, teams, projects, memberships, API keys, invites, runs, and derived tables; tenant isolation is logical (every run-scoped query filters by `teamId AND projectId`). R2 for artifact bytes. Styled with Tailwind v4 + Base UI primitives wrapped as a local component library in `src/components/ui/`. Dashboard auth is Better Auth via `void/auth` (sessions, email + password, optional GitHub OAuth); API auth is Bearer API keys. Serves the streaming ingest + artifact API (`/api/runs/*`, `/api/artifacts/*`) and the tenant-scoped UI (`/t/:teamSlug/p/:projectSlug/…`).
- **`packages/reporter`** — Playwright reporter (`@wrightful/reporter`). Streams results + artifacts to the dashboard as each test completes. Built with tsdown via `vp pack`. Per-test emission: one row per test at its final outcome, with retries aggregated into `flaky`. Opt-in `postPrComment` upserts a GitHub PR summary comment from CI.
- **`packages/e2e`** — Playwright E2E tests (demo suite used to generate test reports for dogfooding). Uses the reporter when `WRIGHTFUL_URL` / `WRIGHTFUL_TOKEN` env is set. (Note: the dashboard-boot fixtures here still target the pre-Void dashboard and need reworking for Void.)

## Commands

```bash
# Install
pnpm install

# Dev server (dashboard) — runs the Void dashboard
pnpm dev

# Build
pnpm build                                   # dashboard (vp build) + reporter (vp pack)
pnpm --filter @wrightful/reporter build      # reporter only

# Tests
pnpm test                                    # dashboard + reporter unit tests (vitest)
pnpm --filter @wrightful/dashboard test      # dashboard tests only
pnpm --filter @wrightful/reporter test       # reporter tests only
pnpm test:e2e                                # e2e (playwright)

# Single test file
pnpm --filter @wrightful/dashboard exec vitest run src/__tests__/schemas.test.ts
pnpm --filter @wrightful/reporter exec vitest run src/__tests__/aggregation.test.ts

# Static checks (format + lint + type-check, all via vp check)
pnpm check                              # vp check
pnpm check:fix                          # vp check --fix

# Local setup (.env.local + demo team/project/API key over HTTP)
pnpm setup:local

# Database — Drizzle migrations in apps/dashboard/db/migrations/.
#   void db generate   # generate a migration from db/schema.ts (production)
#   void db push       # push schema directly (prototyping)
# Migrations are applied on `void deploy`. There is no separate migrate step
# in the deploy pipeline beyond that.

# Deploy
pnpm deploy                             # void deploy (auto-provisions D1/KV/R2)
```

## Key Architecture Details

**Dashboard routing** (Void file-based): API handlers live in `apps/dashboard/routes/` (Hono `defineHandler`), pages in `apps/dashboard/pages/` as `*.tsx` + co-located `*.server.ts` loader/action modules. Cross-cutting concerns are ordered middleware in `apps/dashboard/middleware/` — `00.errors.ts` (error → page/redirect mapping), `01.context.ts` (per-request tenant bundle), `01.head.ts` (theme/FOUC), `02.api-auth.ts` (Bearer key on ingest routes).

**Streaming ingest flow**: `@wrightful/reporter` loads in the user's `playwright.config.ts`. At `onBegin` it opens a run via `POST /api/runs`; per-test `onTestEnd` events buffer until the test is done (all retries finished) and then flush in batches via `POST /api/runs/:id/results`. Each response returns `clientKey → testResultId`, which the reporter uses to register + PUT artifacts via `POST /api/artifacts/register` (which returns a relative worker upload URL — bytes stream through the worker into R2, there is no presigned R2 endpoint). `onEnd` calls `POST /api/runs/:id/complete` to set the terminal status.

**Ingest is a deep module.** The route handlers under `routes/api/runs/*` are auth + translation only — the verify-ownership → batch → summary → activity-bump → broadcast pipeline lives behind `openRun` / `appendRunResults` / `completeRun` in `src/lib/ingest.ts`. Multi-statement writes go through D1 `db.batch([...])` for atomicity; statements are chunked to ≤99 params each.

**Shared schema contract**: Wire types live in both `packages/reporter/src/types.ts` (TypeScript interfaces) and `apps/dashboard/src/lib/schemas.ts` (Zod). Keep them in sync when changing the API contract — `packages/reporter/src/__tests__/contract.test.ts` is the canary that imports the dashboard's Zod schemas and parses reporter-built payloads through them.

**Data layer**: one D1, one query builder (Drizzle), accessed via `db` from `void/db` with tables from `@schema`.

- **Tenant tables** — `runs`, `testResults`, `testResultAttempts`, `testTags`, `testAnnotations`, `artifacts`. Every one carries denormalized `teamId` (on `runs`) and `projectId` so scope is enforced without joins.
- **Control tables** — `teams`, `projects`, `memberships`, `teamInvites`, `apiKeys`, `userGithubAccounts`.
- **Better Auth tables** (`user`, `session`, `account`, `verification`) are **owned by `void/auth`** — bootstrapped idempotently against the same D1 and intentionally NOT declared in `db/schema.ts`. Cross-table joins to them use raw SQL.
- **Tenant isolation is logical, enforced by the type system.** There is no per-team DO boundary; every query against a run-scoped table **must** filter by `projectId` (and usually `teamId`). The branded `AuthorizedProjectId` / `AuthorizedTeamId` on `TenantScope` (`src/lib/scope.ts`) make the auth-checked ids impossible to bypass.
- **Realtime** — `src/live.ts` defines a single `void/live` stream; ingest handlers call `publishRunUpdate(runId, event)` (topic `run:<runId>`) after each write. Run-detail/list islands subscribe via `useRunProgress(runId)`.

**Auth**: API key auth via `Authorization: Bearer <key>`. Keys are SHA-256 hashed, looked up by 8-char prefix, then hash-compared. Defined in `apps/dashboard/src/lib/api-key.ts` / `src/lib/api-auth.ts`.

**Protocol versioning**: `X-Wrightful-Version` header. Currently only version 3 is supported — older reporters/CLIs get a 409.

## Frontend Stack & UI Conventions

The dashboard uses Tailwind v4 + Base UI, wrapped as a local component library. Prefer reuse over hand-rolled markup.

- **Check `apps/dashboard/src/components/ui/` first.** ~50 components already exist (`button`, `dialog`, `table`, `input`, `select`, `tabs`, `tooltip`, `toast`, etc.) — each is a thin wrapper over a Base UI primitive, styled with Tailwind + `class-variance-authority`. Use an existing wrapper if one fits; extend one if it's close; only hand-roll if nothing matches. Do **not** import `@base-ui-components/react` directly from page code — go through the `ui/` wrappers.
- **Tailwind v4** — no `tailwind.config.*`. Theme tokens (colors, fonts, radii, animations, dark-mode scope) live in `apps/dashboard/src/styles.css` under `@theme { … }`. Extend tokens there; don't inline theme values.
- **`cn()` helper** — `apps/dashboard/src/lib/cn.ts` (`twMerge(clsx(...))`). Use it for every merged/conditional `className`. The existing `ui/` components all use it.
- **COSS registry** — `apps/dashboard/components.json` is wired to the COSS UI registry. Scaffold new components with `npx shadcn@latest add @coss/<name>` (drops into `src/components/ui/`). Prefer this over adding ad-hoc dependencies.
- **URL state** — no nuqs. Use `useSearchParam` (shallow) / `useNavigatingSearchParam` (re-fetch) from `src/lib/use-search-param.ts` for filter/sort/pagination state.
- **Islands** — pages are isomorphic (Void Inertia-style); add `"use client"` only when interactivity or Base UI client hooks require it. All `ui/` components are already client-boundary.
- **Internal navigation** — use `@void/react`'s `<Link>` for internal routes; plain `<a>` only for external links and island pages.

## Auth & Multi-Tenancy

Two auth systems coexist:

- **API auth** (`/api/*` ingest) — Bearer API keys, scoped to a project. `apps/dashboard/src/lib/api-auth.ts`. Applied as middleware (`middleware/02.api-auth.ts`); handlers read `getApiKey(c)`.
- **Dashboard auth** — Better Auth sessions via `void/auth` (email + password, optional GitHub OAuth). Config in `apps/dashboard/auth.ts`. Server helpers `getSession()` / `getUser()` / `requireAuth(c)` come from `void/auth`.

**Tenancy model:** `teams` → `projects` → `runs` (+ derived rows). Users join teams via `memberships` (`owner` | `member`).

**Routes:** dashboard pages live under `/t/:teamSlug/p/:projectSlug/…`; settings under `/settings/…`. `/` is a team/project picker.

**Authorization helpers — always use these instead of raw `teamId` / `projectId` lookups:**

- `resolveTeamBySlug(userId, teamSlug)` / `resolveProjectBySlugs(userId, teamSlug, projectSlug)` / `resolveTenantBundleForUser(...)` — `apps/dashboard/src/lib/authz.ts`
- `requireTenantContext(c)` / `getTenantContext(c)` — `apps/dashboard/src/lib/tenant-context.ts` — returns `{ project, scope }` from the active project resolved once by `middleware/01.context.ts`. **Use this at the top of any `/t/:teamSlug/p/:projectSlug/*` page loader** — it avoids re-running the membership join.
- `tenantScopeForApiKey(apiKey)` — `apps/dashboard/src/lib/scope.ts` — ingest flow. `tenantScopeForUserBySlugs(...)` — same file — for session-authed API routes outside the tenant middleware's reach.

**Query scoping rule:** there is no DO boundary — isolation is logical. Every query against `runs` / `testResults` / `testResultAttempts` / `testTags` / `testAnnotations` / `artifacts` **must** filter by `projectId` (and `teamId` where present). The branded `AuthorizedProjectId` on `TenantScope` exists to make this impossible to forget.

**Env vars** (declared in `apps/dashboard/env.ts`): required `WRIGHTFUL_PUBLIC_URL`, `BETTER_AUTH_SECRET`. Optional `AUTH_GITHUB_CLIENT_ID` + `AUTH_GITHUB_CLIENT_SECRET`, `WRIGHTFUL_MAX_ARTIFACT_BYTES` (default 50 MiB), `WRIGHTFUL_RUN_STALE_MINUTES` (default 30), `ALLOW_OPEN_SIGNUP` (default false). Read values via `import { env } from "void/env"`.

## Worklogs

**Required.** When making significant changes or adding features, you must write a worklog entry in `docs/worklog/`. This is how we track what changed, why, and what was verified — future agents and contributors rely on these to understand project history beyond what git log shows.

**File naming:** `YYYY-MM-DD-short-description.md` (e.g. `2026-04-16-phase1-foundation.md`)

**Structure:** Each entry should include:

- **Title** — date + summary of what changed
- **What changed** — narrative description of the work
- **Details** — new dependencies, config changes, schema changes, scripts added, etc. (tables work well)
- **Code fixes / migrations** — specific files changed and why, if non-obvious
- **Verification** — what checks were run and their results (tests, lint, typecheck, manual testing)

See existing entries in `docs/worklog/` for the expected level of detail. Err on the side of being thorough — these are the project's source of truth for decision context.

Before substantive work, read `docs/worklog/void-migration-consolidated.md` — it records the rwsdk → Void migration and the durable architectural decisions (single D1 over per-team DOs, logical tenancy, void/live realtime) that should not be re-litigated. Worklogs dated before the migration describe the prior rwsdk/Durable-Object/Kysely architecture and are historical.

## Tooling Notes

- **Static checks**: `pnpm check` runs `vp check`, which performs format (oxfmt), lint (oxlint), and type-aware type-checking in one pass. `pnpm check:fix` auto-fixes format + lint. All config lives in the root `vite.config.ts` under `fmt:` and `lint:` blocks. Type-awareness is enabled via `lint.options.typeAware` + `lint.options.typeCheck`. Key lint rules: `no-floating-promises`, `no-misused-promises`, `await-thenable` are errors. The React plugin is activated only for `apps/dashboard/**/*.{tsx,jsx}`. Formatter uses double quotes, semicolons, trailing commas.
- **TypeScript**: `tsgo` (native TS compiler preview) is installed for ad-hoc `tsgo --noEmit` runs; the dashboard's `typecheck` script runs `void prepare && tsgo --noEmit` (codegen first). `vp check` is the canonical entry point.
- **Void codegen**: `void prepare` generates `apps/dashboard/.void/{routes,db,env,queues}.d.ts` + tsconfig. Run it after a fresh install in CI before typechecking; `vp dev` / `vp build` regenerate it during normal workflows.
- **Pre-commit hook**: `vp config` (run via the `prepare` script) installs a hook in `.vite-hooks/` that runs `vp staged` (lint --fix + fmt --write on staged files) per the `staged:` block in the root `vite.config.ts`.
- **Bundling**: reporter is bundled with `vp pack` (wraps tsdown). Config: `packages/reporter/vite.config.ts`.
- **Toolchain pin**: the vite-plus catalog in `pnpm-workspace.yaml` is pinned (not `latest`) — a `latest` bump previously shipped a release that couldn't build the dashboard's Void config.
- **IDs**: ULIDs for all database primary keys (via `ulid` package).

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

<!--injected-by-void-v0.8.11-->

## Void

This project uses [Void](https://void.cloud) — a fullstack Vite plugin + deployment platform for Cloudflare. `voidPlugin()` in `vite.config.ts` gives you file-based API routing on Hono (`routes/`), Inertia-inspired server-rendered pages with co-located loaders/actions (`pages/` + `@void/vue` or `@void/react`), auto-provisioned D1/KV/R2 bindings, first-class Drizzle ORM integration (schema in `db/schema.ts` -> `void/db` Drizzle instance -> typed routes -> typed fetch client), built-in auth, queues, cron jobs, edge caching (ISR), and one-command deploys via `npx void deploy`. For first-time setup, prefer `npx void init`; in an empty directory, install `void` first and let the interactive flow scaffold the starter with Vite+ by default, add the matching framework adapter, configure project files, handle auth, and link or create the deploy project before the first deploy. In an existing app, `void init` configures Void in place by adding missing Vite scripts and creating or patching `vite.config.*` with `voidPlugin()`. Use `void` and `@void/*` package names in source code and package manifests.

Database: define Drizzle tables in `db/schema.ts`, import `db` from `void/db` and tables from `@schema`. Use `void db push` for prototyping, `void db generate` for production migrations. `drizzle-orm` and `drizzle-kit` ship with void (no extra install). Migrations live in `db/migrations/`.

Env: declare every env key in `env.ts` at the project root via `defineEnv({ KEY: string(), ... })` from `void/env`. Read values via `import { env } from "void/env"`. Schema validation runs at dev start (warns) and on `void deploy` (hard error on missing prod secrets). Use `VITE_*` prefix for keys that should be exposed to client code.

CI/editor prep: run `void prepare` to generate `.void/routes.d.ts`, `.void/db.d.ts`, `.void/queues.d.ts`, `.void/env.d.ts`, and `.void/tsconfig.json` without booting Vite. Run it after `npm install` in CI or a fresh clone before typechecking; `vite dev` and `vite build` regenerate these during normal workflows.

Rewrites and redirects: declare static rules in `void.json` under `routing.redirects` / `routing.rewrites` / `routing.fallbacks`, or in a `public/_redirects` file. For dynamic rewrites, call `c.rewrite(path)` in a `defineMiddleware`.

Logs: surface app-level errors that should show up under `void project logs --level error` via `import { logger } from "void/log"` and `logger.error(msg, fields?)` (also `.warn` / `.info`). Anything caught and only persisted to your own DB is invisible to Cloudflare Tail; route it through `logger.*` or `console.*` so the platform can see it.

Full docs are in `node_modules/void/docs/`. If you have the `void` skill available, use it for a complete API reference covering project structure, routing, pages mode, database, auth, typed fetch, KV, storage, queues, cron jobs, CLI, configuration, and deployment.

<!--/injected-by-void-->
