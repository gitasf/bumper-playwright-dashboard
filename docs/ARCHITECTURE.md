# Architecture

A one-page orientation. For the narrative behind each decision, read the dated entries in [`docs/worklog/`](./worklog/) — they are the project's source of truth for _why_. The rwsdk → Void migration that produced today's shape is summarized in [`docs/worklog/void-migration-consolidated.md`](./worklog/void-migration-consolidated.md).

## Shape

```
Playwright CI ──@wrightful/reporter──▶ Worker (/api/runs/*)
                                        │
                                        ├─ Postgres (Drizzle/Hyperdrive) ── auth + tenancy lookup, runs + derived rows
                                        │
                                        ├─ R2 (worker-proxied PUT/GET) ── artifact bytes
                                        │
                                        └─ void/ws ── broadcastRunRoom / broadcastProjectRoom

Browser ────────SSR pages (Inertia)────▶ Worker (/t/:team/p/:project/…)
                                        │
                                        ├─ Better Auth session (void/auth) ── dashboard auth
                                        ├─ Postgres (Drizzle/Hyperdrive) ──── teams, projects, memberships, runs
                                        └─ void/ws ── useRunRoom / useProjectRoom realtime

Cron (every 1m / 5m / 6h / daily) ─────▶ Worker (scheduled)
                                        ├─ sweep due monitors → Queues (monitors / uptime) → executor → run ingest
                                        └─ sweep stale runs · retention · synthetic-key + execution reapers · usage rollup
```

The dashboard is the `@wrightful/dashboard` app in `apps/dashboard`, built on [Void](https://void.cloud) (a fullstack Vite plugin + deploy platform for Cloudflare). `void deploy` is the entire deploy pipeline; it provisions the Postgres database (over Hyperdrive), R2 bucket, the `monitors` / `uptime` Queue consumers, the Sandbox container (browser monitors), and any KV bindings.

## Storage

One **Postgres database** — over Cloudflare Hyperdrive in production, a direct `DATABASE_URL` in local dev — accessed through Drizzle (`db` from `void/db`, tables from `@schema`, schema source `apps/dashboard/db/schema.ts` in pg-core). Postgres result-shape coercions (node-postgres returns `int8`/`numeric` as strings, where pglite returns numbers) live in `numericSql` (`src/lib/db/sql-ops.ts`) and the raw-read `cast(… as integer)` idiom; multi-statement atomicity goes through `runBatch` (a `db.transaction`) in `src/lib/db-batch.ts`. See [`SELF-HOSTING.md`](../SELF-HOSTING.md) for deploy specifics and the Postgres-only worklog (`docs/worklog/2026-06-16-postgres-only.md`) for the D1-removal rationale.

- **Control tables.** `teams` (incl. `tier` + per-team retention windows), `projects`, `memberships`, `teamInvites`, `apiKeys`, `userGithubAccounts`, `userState`, `usageCounters` (per-team-month run/test-result/artifact-byte meters), `githubInstallations` (GitHub App install → team).
- **Tenant tables.** `runs` (carries `origin`, `monitorId`, `githubCheckRunId`, `lastActivityAt`, `expectedTotalTests`), `testResults`, `testResultAttempts`, `testTags`, `testAnnotations`, `artifacts`, plus the test-management tables `quarantinedTests`, `testOwners`, and the synthetic-monitoring tables `monitors` + `monitorExecutions`. Every run-scoped child carries denormalized `teamId` (on `runs`) and `projectId` so scope is enforced without joining through `runs`. Reached only through the auth-checked `TenantScope` from `src/lib/scope.ts` / `src/lib/tenant-context.ts`.
- **`auditLog`.** Team-scoped audit trail (member/key/config/project mutations); `actorUserId` is a logical FK (no DB constraint), like `memberships.userId`. `projectId` is `set null` so a row survives a project delete.
- **Better Auth tables** (`user`, `session`, `account`, `verification`) are owned by `void/auth` — bootstrapped idempotently against the same database and intentionally not declared in the schema. Cross-table joins use raw SQL.
- **R2.** Artifact bytes only. Both directions are **worker-proxied** — the worker is on the byte path. Upload: the reporter PUTs to a relative worker route (`/api/artifacts/:id/upload`) returned by `register`, which streams the body into R2 via `storage.put`. Download: a worker route (`/api/artifacts/:id/download`) authorized by a signed HMAC token that carries the R2 key (so GETs don't touch the DB), which then `storage.get`s and streams the bytes back. There is no S3-style presigned R2 URL today; offloading bytes off the worker would be a separate, deliberate change.
- **Realtime.** `void/ws` rooms are the only realtime transport (SSE / `void/live` was deleted — see [ADR-0001](./adr/0001-realtime-websocket-rooms.md)). Two hibernatable rooms — `routes/ws/run/[runId].ws.ts` (per-test deltas) and `routes/ws/project/[projectId].ws.ts` (run-list lifecycle). Ingest publishes via `broadcastRunRoom` / `broadcastProjectRoom` (`src/realtime/publish.ts`) after each batch write (a non-fatal, internal DO-to-DO POST gated by a build-baked secret); clients subscribe with `useRunRoom` / `useProjectRoom`. No event replay (connect-before-broadcast; SSR seed + id-dedupe cover the gap), 256-connection cap per room.

**Tenant isolation is logical, not physical.** There is no per-team Durable Object boundary — every query against a run-scoped table must filter by `projectId` (and `teamId` where present). The branded `AuthorizedProjectId` / `AuthorizedTeamId` on `TenantScope` force the auth-checked ids through the type system so a query can't silently cross tenants.

Schema changes are Drizzle migrations, committed under `apps/dashboard/db/migrations/`; `pnpm db:generate` (= `void db generate`) regenerates them from `db/schema.ts`. On `void deploy` they're applied automatically; for an own-account remote DB, `pnpm db:migrate:remote` applies them explicitly (`wrangler deploy` does **not** auto-apply migrations).

## Auth

Two systems coexist on the same worker:

- **Dashboard sessions** — Better Auth via `void/auth`. Email + password, optional GitHub OAuth. Config in `apps/dashboard/auth.ts`; providers declared in `void.json#auth`. Server helpers `getSession()` / `getUser()` / `requireAuth(c)` come from `void/auth`.
- **Ingest API keys** — Bearer tokens, SHA-256 hashed at rest, looked up by 8-char prefix and hash-compared (`src/lib/api-key.ts`). Each key is scoped to a single project. Applied via `middleware/02.api-auth.ts`; handlers read `getApiKey(c)`. Reporter requests also carry `X-Wrightful-Version: 3`; older protocols return 409.

## Routing

Void file-based routing. API handlers in `apps/dashboard/routes/`, pages in `apps/dashboard/pages/` (`*.tsx` + co-located `*.server.ts` loaders/actions). Cross-cutting concerns are ordered middleware in `apps/dashboard/middleware/`.

- `/` — team / project picker.
- `/t/:teamSlug/p/:projectSlug/…` — tenant-scoped UI. Every loader starts with `requireTenantContext(c)` (reads the active project resolved once by `middleware/01.context.ts`). Pages: runs list + run detail, **test catalog** (tags + file/suite grouping), **flaky** (quarantine + ownership), **run diff**, **insights**, and **monitors** (browser / HTTP / TCP·ping).
- `/settings/…` — profile, team management (general / members / projects), project keys, invites, **usage** (quota meters), **audit log**.
- `/api/runs/*`, `/api/artifacts/*` — ingest + artifact API. Guarded by `middleware/02.api-auth.ts` (Bearer key) + protocol version negotiation (`X-Wrightful-Version: 3`).
- `/api/v1/*` — **public query/export API** (Bearer key, no version handshake): `runs`, `runs/:id`, `runs/:id/tests`, with `?format=csv` + the `WRIGHTFUL_EXPORT_MAX_ROWS` cap. See [`docs/api/query-export.md`](./api/query-export.md).
- `/api/t/:teamSlug/p/:projectSlug/*` — session-authed tenant API (quarantine, test-ownership, search, run-diff, summary, CSV export).
- `/api/github/*` — GitHub App install callback (`setup`) + webhook (installation / check-run), gated by `githubAppEnabled`.

Cross-cutting middleware: `00.errors` (error → page/redirect), `01.context` (tenant bundle) / `01.head` (theme), `02.api-auth` (Bearer key on ingest), `03.rate-limit` (per-surface Cloudflare rate-limiter bindings — `AUTH` / `API` / `QUERY` / `ARTIFACT` / `INGEST_IP`; runs after auth so it can key by resolved `apiKey.id`).

**Ingest pipeline.** `routes/api/runs/*` handlers are auth + translation only; the verify-ownership → batch (`db.transaction`) → summary → activity-bump → broadcast pipeline lives behind `openRun` / `appendRunResults` / `completeRun` in `src/lib/ingest.ts`.

## Background work (crons + queues)

Six Void crons (each a unique cron expression, dispatched via `switch(controller.cron)`):

- `sweep-monitors` (every 1m) — arms due monitors' `nextRunAt`, enqueues them to the `monitors` (browser) / `uptime` (http·tcp) Queues.
- `sweep-stuck-runs` (every 5m) — finalizes runs stuck at `running` past `WRIGHTFUL_RUN_STALE_MINUTES`.
- `sweep-stuck-executions` / `sweep-synthetic-keys` (every 5m, offset) — reap non-terminal monitor executions + orphaned per-run ingest keys.
- `sweep-retention` (every 6h) — two-axis sweep (R2 artifact bytes, then `testResults` rows) per the team/instance retention windows.
- `rollup-usage` (daily) — rolls per-team-month meters into `usageCounters`.

**Monitor execution** is the schedule→queue→execute pipeline: the `monitors` / `uptime` Queue consumers (`createMonitorConsumer`, `src/lib/monitors/queue-consumer.ts`) run the pure `runMonitorJob` against the resolved `MonitorExecutor` — `sandbox` (Void Sandbox container running the user's Playwright) or `stub` (in-process, for dev/CI), selected by `WRIGHTFUL_MONITOR_EXECUTOR` — and stream the outcome through the normal run ingest path.

## Frontend

- Server-rendered Inertia-style pages (`@void/react`); add `"use client"` only at interactive leaves.
- Base UI primitives wrapped as a local component library in `apps/dashboard/src/components/ui/` (~50 components). Don't import `@base-ui-components/react` directly from page code — go through the wrappers.
- Tailwind v4 with theme tokens in `apps/dashboard/src/styles.css` under `@theme { … }`. No `tailwind.config.*`.
- New components come from the COSS registry (`components.json`): `npx shadcn@latest add @coss/<name>`.
- URL-backed UI state uses `useSearchParam` / `useNavigatingSearchParam` (`src/lib/use-search-param.ts`) — no nuqs.

## Configuration

Every env key is declared (with docs + defaults) in `apps/dashboard/env.ts` — the authoritative source. Only `WRIGHTFUL_PUBLIC_URL` + `BETTER_AUTH_SECRET` are required; the rest are optional/defaulted, grouped as: GitHub OAuth (`AUTH_GITHUB_*`), GitHub App / Checks (`GITHUB_APP_*`), usage quotas (`WRIGHTFUL_FREE_*`, `WRIGHTFUL_QUOTA_SOFT_WARN_PCT`), retention (`WRIGHTFUL_RETENTION_*`), export (`WRIGHTFUL_EXPORT_MAX_ROWS`), synthetic monitors (`WRIGHTFUL_MONITOR_*`, `WRIGHTFUL_HTTP_MONITOR_*`, `WRIGHTFUL_TCP_MONITOR_*`, `WRIGHTFUL_HTTP_CHECK_MAX_BODY_BYTES`), artifacts/watchdog, and the realtime internal secret. The self-host env table is in [`SELF-HOSTING.md`](../SELF-HOSTING.md).

## Tooling

- Typecheck: `tsgo` (native TS preview); the dashboard's `typecheck` runs `void prepare && tsgo --noEmit`.
- Lint: `oxlint`. Format: `oxfmt`. Both via `vp check`. Pre-commit hook runs `vp staged` on staged files.
- Reporter releases: Changesets. `pnpm release` runs from the root; the dashboard deploys separately via `void deploy`, not published.
- IDs: ULIDs for every primary key.
