# Architecture

A one-page orientation. For the narrative behind each decision, read the dated entries in [`docs/worklog/`](./worklog/) — they are the project's source of truth for _why_. The rwsdk → Void migration that produced today's shape is summarized in [`docs/worklog/void-migration-consolidated.md`](./worklog/void-migration-consolidated.md).

## Shape

```
Playwright CI ──@wrightful/reporter──▶ Worker (/api/runs/*)
                                        │
                                        ├─ D1 (Drizzle) ── auth + tenancy lookup, runs + derived rows
                                        │
                                        ├─ R2 (worker-proxied PUT/GET) ── artifact bytes
                                        │
                                        └─ void/live ── publishRunUpdate(run:<id>)

Browser ────────SSR pages (Inertia)────▶ Worker (/t/:team/p/:project/…)
                                        │
                                        ├─ Better Auth session (void/auth) ── dashboard auth
                                        ├─ D1 (Drizzle) ───────────────────── teams, projects, memberships, runs
                                        └─ void/live ── useRunProgress(runId) realtime stream
```

The dashboard is the `@wrightful/dashboard` app in `apps/dashboard`, built on [Void](https://void.cloud) (a fullstack Vite plugin + deploy platform for Cloudflare). `void deploy` is the entire deploy pipeline; it auto-provisions the D1 database, R2 bucket, and any KV bindings.

## Storage

One **D1 database**, accessed through Drizzle (`db` from `void/db`, tables from `@schema`, schema source in `apps/dashboard/db/schema.ts`).

- **Control tables.** `teams`, `projects`, `memberships`, `teamInvites`, `apiKeys`, `userGithubAccounts`.
- **Tenant tables.** `runs`, `testResults`, `testResultAttempts`, `testTags`, `testAnnotations`, `artifacts`. Every run-scoped child carries denormalized `teamId` (on `runs`) and `projectId` so scope is enforced without joining through `runs`. Reached only through the auth-checked `TenantScope` from `src/lib/scope.ts` / `src/lib/tenant-context.ts`.
- **Better Auth tables** (`user`, `session`, `account`, `verification`) are owned by `void/auth` — bootstrapped idempotently against the same D1 and intentionally not declared in `db/schema.ts`. Cross-table joins use raw SQL.
- **R2.** Artifact bytes only. Both directions are **worker-proxied** — the worker is on the byte path. Upload: the reporter PUTs to a relative worker route (`/api/artifacts/:id/upload`) returned by `register`, which streams the body into R2 via `storage.put`. Download: a worker route (`/api/artifacts/:id/download`) authorized by a signed HMAC token that carries the R2 key (so GETs don't touch the DB), which then `storage.get`s and streams the bytes back. There is no S3-style presigned R2 URL today; offloading bytes off the worker would be a separate, deliberate change.
- **Realtime.** `void/live` (`src/live.ts`) broadcasts progress on topic `run:<runId>`. Ingest handlers call `publishRunUpdate` after each DO write; run detail/list islands subscribe via `useRunProgress(runId)`.

**Tenant isolation is logical, not physical.** There is no per-team Durable Object boundary — every query against a run-scoped table must filter by `projectId` (and `teamId` where present). The branded `AuthorizedProjectId` / `AuthorizedTeamId` on `TenantScope` force the auth-checked ids through the type system so a query can't silently cross tenants.

Schema changes are Drizzle migrations in `apps/dashboard/db/migrations/` (`void db generate`), applied on `void deploy`. There is no CLI migrate step beyond the deploy.

## Auth

Two systems coexist on the same worker:

- **Dashboard sessions** — Better Auth via `void/auth`. Email + password, optional GitHub OAuth. Config in `apps/dashboard/auth.ts`; providers declared in `void.json#auth`. Server helpers `getSession()` / `getUser()` / `requireAuth(c)` come from `void/auth`.
- **Ingest API keys** — Bearer tokens, SHA-256 hashed at rest, looked up by 8-char prefix and hash-compared (`src/lib/api-key.ts`). Each key is scoped to a single project. Applied via `middleware/02.api-auth.ts`; handlers read `getApiKey(c)`. Reporter requests also carry `X-Wrightful-Version: 3`; older protocols return 409.

## Routing

Void file-based routing. API handlers in `apps/dashboard/routes/`, pages in `apps/dashboard/pages/` (`*.tsx` + co-located `*.server.ts` loaders/actions). Cross-cutting concerns are ordered middleware in `apps/dashboard/middleware/`.

- `/` — team / project picker.
- `/t/:teamSlug/p/:projectSlug/…` — tenant-scoped UI. Every loader starts with `requireTenantContext(c)` (reads the active project resolved once by `middleware/01.context.ts`).
- `/settings/…` — profile, team management (general / members / projects), project keys, invites.
- `/api/runs/*`, `/api/artifacts/*` — ingest + artifact API. Guarded by `middleware/02.api-auth.ts` (Bearer key) + protocol version negotiation.

**Ingest pipeline.** `routes/api/runs/*` handlers are auth + translation only; the verify-ownership → `db.batch` → summary → activity-bump → broadcast pipeline lives behind `openRun` / `appendRunResults` / `completeRun` in `src/lib/ingest.ts`.

## Frontend

- Server-rendered Inertia-style pages (`@void/react`); add `"use client"` only at interactive leaves.
- Base UI primitives wrapped as a local component library in `apps/dashboard/src/components/ui/` (~50 components). Don't import `@base-ui-components/react` directly from page code — go through the wrappers.
- Tailwind v4 with theme tokens in `apps/dashboard/src/styles.css` under `@theme { … }`. No `tailwind.config.*`.
- New components come from the COSS registry (`components.json`): `npx shadcn@latest add @coss/<name>`.
- URL-backed UI state uses `useSearchParam` / `useNavigatingSearchParam` (`src/lib/use-search-param.ts`) — no nuqs.

## Tooling

- Typecheck: `tsgo` (native TS preview); the dashboard's `typecheck` runs `void prepare && tsgo --noEmit`.
- Lint: `oxlint`. Format: `oxfmt`. Both via `vp check`. Pre-commit hook runs `vp staged` on staged files.
- Reporter releases: Changesets. `pnpm release` runs from the root; the dashboard deploys separately via `void deploy`, not published.
- IDs: ULIDs for every primary key.
