# Wrightful — Open Source Playwright Dashboard on Cloudflare

> An open-source Playwright test reporter and analytics dashboard that anyone can self-host on Cloudflare for free.

This document is the strategy + decisions doc — what Wrightful is, what it isn't, and why we made the architectural calls we did. For the request flow, storage layout, and route surface as they stand today, see [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md). For self-hosting steps, see [`SELF-HOSTING.md`](../SELF-HOSTING.md). For the dated narrative behind specific changes, see [`docs/worklog/`](./worklog/).

> **Architecture note (2026-05):** the dashboard was migrated from RedwoodSDK + per-team Durable Objects + Kysely onto [Void](https://void.cloud) with a single D1 database + Drizzle. Several decisions below were reversed by that migration; they're kept and annotated rather than deleted, because the reasoning is part of the project's history. The consolidated record is [`docs/worklog/void-migration-consolidated.md`](./worklog/void-migration-consolidated.md).

## Problem

Playwright's built-in HTML reporter is excellent for debugging a single run, but has no persistence, no cross-run analytics, no flaky test detection, and no team sharing beyond downloading zip artifacts from CI. The only solutions are commercial dashboards starting at $49/month (Currents.dev, TestDino). There is no credible open-source alternative that provides historical test analytics with a simple self-hosting story.

Microsoft shutting down Playwright Testing's reporting dashboard (March 2026) widens this gap further.

## Vision

A lightweight, self-hostable Playwright dashboard that solves three specific problems:

1. **Sharded run fragmentation** — merge results from N CI shards into a single unified view
2. **No historical memory** — track test results over time to answer "is this test getting flakier?" and "is our suite getting slower?"
3. **Flaky test blindness** — automatically detect and surface flaky tests based on pass/fail patterns across runs

Non-goals (explicitly out of scope):

- Smart test orchestration (dynamic test distribution across CI machines)
- AI-powered failure classification
- Replacing the Playwright HTML report for single-run debugging
- Support for non-Playwright test runners (Vitest, Jest) — Playwright-specific features like traces, annotations, and projects are core differentiators

## Tech Stack

| Layer          | Technology                                          | Why                                                                                                                                                                                                     |
| -------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework      | **Void**                                            | Fullstack Vite plugin + deploy platform for Cloudflare. File-based Hono routing + Inertia-style server-rendered pages with co-located loaders.                                                          |
| Data store     | **Single Cloudflare D1**                            | One SQLite database holds auth, tenancy, runs, and derived rows. Tenant isolation is logical (filter by `teamId`/`projectId`), not physical.                                                            |
| Query builder  | **Drizzle ORM**                                     | Ships with Void (`void/db`); schema in `db/schema.ts`; typed routes + typed fetch client. Multi-statement writes via D1 `db.batch`.                                                                     |
| Auth/tenancy   | **Better Auth via `void/auth`**                     | Sessions (email + password, optional GitHub OAuth). Better Auth's own tables are void-managed; our tenancy tables live in the same D1.                                                                  |
| Realtime       | **`void/live`**                                     | DO-backed pub-bus; ingest publishes on topic `run:<runId>`, run detail/list islands subscribe via `useRunProgress`.                                                                                     |
| Object storage | **Cloudflare R2**                                   | S3-compatible storage for traces, screenshots, videos. 10GB free, zero egress charges. Artifacts are uploaded and downloaded through worker routes (worker-proxied PUT/GET; no presigned R2 URL today). |
| Reporter       | **`@wrightful/reporter`**                           | Custom Playwright reporter that streams per-test results live as the suite runs (open run → append batches → complete). Not a JSON-file uploader.                                                       |
| CI integration | **Reporter PR comment**                             | Opt-in `postPrComment` upserts a PR comment with run summary, tallies, and a dashboard link, posted from CI with the runner's `GITHUB_TOKEN`.                                                           |
| API auth       | **Bearer API keys**                                 | Per-project keys, SHA-256 hashed at rest, looked up by 8-char prefix. Multiple keys per project with individual revocation.                                                                             |
| Dashboard auth | **Better Auth** (sessions; email + optional GitHub) | Email/password sign-in by default, optional GitHub OAuth. Session cookie gates the UI.                                                                                                                  |

### Why Void

- Server-rendered Inertia-style pages: a page's `*.server.ts` loader queries the data layer and returns props directly — no separate REST API to maintain for the UI.
- Auto-provisioned D1/KV/R2 bindings inferred from source; `void deploy` builds, runs Drizzle migrations, and ships in one command — no manual resource creation, no migrate orchestration.
- First-class Drizzle integration with typed routes and a typed fetch client.
- Vite-based dev experience; built-in auth, cron jobs, and realtime (`void/live`).

### Storage: single D1 (and the earlier Durable Object detour)

The project's original Cloudflare design used a singleton `ControlDO` for auth/tenancy plus one `TenantDO` per team for test data, queried with Kysely. The reasoning at the time:

1. **Per-tenant write isolation** — sharding runs by team into per-team DOs avoided a single-writer noisy-neighbour problem and made tenant isolation physical.
2. **Auto-provisioning friction** — Cloudflare's binding behaviour for newly-created D1 made the first deploy need a multi-step migrate orchestration; a singleton `ControlDO` sidestepped it.

**The 2026-05 Void migration reversed this** and moved everything to a single D1 with Drizzle. What changed the calculus:

- **Void removed the provisioning friction.** `void deploy` infers and provisions D1/R2/KV and runs migrations as part of deploy — the orchestration that motivated the DO approach no longer exists.
- **The write-rate concern was overstated.** Wrightful's write rate is single-digit per team per second; a single D1 writer handles it comfortably.
- **One store is simpler and more capable.** Cross-team joins, one source of truth, one migration history, and far less operational surface than N Durable Objects.

The trade-off accepted: isolation is now logical, not physical. Every run-scoped query must filter by `teamId`/`projectId`; the branded `AuthorizedProjectId` on `TenantScope` enforces this through the type system so it can't be forgotten.

## Architecture

For the canonical view, see [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md). One-paragraph summary:

A single Cloudflare Worker (a Void app) hosts both the streaming ingest API (`/api/runs/*`, `/api/artifacts/*`) and the server-rendered dashboard UI (`/t/:teamSlug/p/:projectSlug/…`). API requests authenticate with a project-scoped Bearer key; dashboard requests carry a Better Auth session cookie. All reads/writes go to a single D1 database via Drizzle — auth/tenancy tables and run/derived tables live together, isolated logically by `teamId`/`projectId`. Artifact bytes go to R2 via worker-proxied PUT/GET (the worker is on the byte path; not presigned R2 URLs). Realtime progress is published on `void/live` topic `run:<runId>`, which the run-detail and run-list islands subscribe to via `useRunProgress`.

### Streaming ingest flow

The reporter doesn't dump a JSON file at the end of the suite — it streams. Three phases:

- `onBegin` → `POST /api/runs` opens the run. The reporter declares the planned test list and gets back a `runId`.
- `onTestEnd` → buffer per test until all retries are settled, then `POST /api/runs/:runId/results` in batches. Each response returns `clientKey → testResultId`, which the reporter uses to register and PUT artifacts via `POST /api/artifacts/register` (which returns a relative worker upload URL; bytes stream through the worker into R2, not via presigned R2 URLs).
- `onEnd` → `POST /api/runs/:runId/complete` sets the terminal status.

The route handlers are auth + translation only; the batch pipeline lives behind `openRun` / `appendRunResults` / `completeRun` in `apps/dashboard/src/lib/ingest.ts`. Per-test emission means one row per test at its final outcome, with retries aggregated into `flaky`. Wire types live in both `packages/reporter/src/types.ts` (TypeScript) and `apps/dashboard/src/lib/schemas.ts` (Zod) — keep them in sync; `packages/reporter/src/__tests__/contract.test.ts` is the canary.

### Multi-tenancy

Teams → projects → runs (+ derived rows). Users join teams via `memberships` (`owner` | `member`). Tenant isolation is **logical** — there is no per-team DO; every query against `runs` / `testResults` / `testResultAttempts` / `testTags` / `testAnnotations` / `artifacts` must filter by `projectId` (and `teamId` where present). The branded `AuthorizedProjectId` on `TenantScope` makes that hard to forget at the type level. Auth helpers (`requireTenantContext`, `tenantScopeForApiKey`, `resolveProjectBySlugs`) gate every read/write — no route handler should reach raw bindings.

### Stable test ID

`testId` is a hash of `file + titlePath + projectName` — this is how we track the same test across runs. Playwright's internal `test.id` changes between runs, so we need our own stable identifier.

**Known limitations** (document prominently in user-facing docs):

- Renaming a `describe` block breaks every test ID inside it
- Fixing a typo in a test title creates a "new" test and orphans the old history
- Moving a test between files breaks tracking
- Changing the Playwright project name breaks tracking

This is the same approach used by Currents.dev and TestDino. The tradeoff is acceptable — these are infrequent operations, and the alternative (fuzzy matching) introduces its own class of bugs.

### Idempotency

The reporter generates an idempotency key per run (e.g. derived from `GITHUB_RUN_ID` so shards converge on the same run). The open-run endpoint checks the key:

- If the key doesn't exist: insert normally, return `201 Created`
- If the key already exists: return `200 OK` with the existing run ID, skip insertion
- This makes retries safe — a flaky network in CI won't create duplicate runs

### Protocol versioning

Reporter requests carry `X-Wrightful-Version`. Currently only version 3 is supported — older reporters/CLIs get a 409 with a clear upgrade message. The version increments when the request/response schema changes in a backwards-incompatible way; additive changes (new optional fields) do not.

## Dashboard pages

### Core views

1. **Team / project picker** (`/`)
   - Lists teams the signed-in user is a member of; landing page.

2. **Runs list** (`/t/:teamSlug/p/:projectSlug`)
   - Table: branch, commit, status (pass/fail), test counts, duration, timestamp
   - Filter by branch, status, date range, tags
   - Shard-aware: groups shards by `ciBuildId` (extracted from CI env), shows merged totals

3. **Run detail** (`/t/:teamSlug/p/:projectSlug/runs/:runId`)
   - Summary: pass/fail/flaky/skipped counts, total duration, commit info
   - Test list: sortable by status, duration, name; filterable by tag
   - In-flight runs: realtime progress via `useRunProgress(runId)` over `void/live`
   - Sharded runs: per-shard breakdown alongside merged totals

4. **Test detail** (`/t/:teamSlug/p/:projectSlug/runs/:runId/tests/:testResultId`)
   - Error message + stack trace (syntax highlighted)
   - Artifacts: trace viewer link via `trace.playwright.dev`, screenshots inline, video player
   - Retry history within this run (one row per attempt)
   - Tags and annotations
   - Link to historical view of this test

5. **Test history** (per-test cross-run view)
   - Sparkline: pass/fail/flaky over last N runs
   - Duration trend chart
   - Flakiness percentage over configurable windows (7d, 30d, 90d)

6. **Flaky tests**
   - Ranked list of tests by flakiness rate
   - Filters: time window, branch (default: main/master), minimum run count, tags

7. **Settings**
   - Profile, team management (general / members / projects), member invites, API keys
   - Per-project key reveal: the minted plaintext key is returned once in the mint-key API response and surfaced in a modal client-side.

### Nice-to-have views (post-MVP)

- **Insights** — suite duration trend, top 10 slowest tests, pass rate trend, duration regression detection (shipped)
- **Branch comparison** — compare test results between two branches
- **PR view** — all runs associated with a PR, with status timeline
- **Notifications** — webhook on flaky test threshold breach

## CI integration

The reporter has an opt-in `postPrComment` option: when a run finishes inside a GitHub Actions PR workflow, it posts (or upserts) a PR comment with a summary table and a link back to the dashboard. The comment is posted from CI using the runner's `GITHUB_TOKEN` — no GitHub App, no per-tenant install state. Fork PRs without secret access degrade gracefully (skip + warn rather than fail the workflow). A GitHub App is the longer-term answer if check runs / status checks / non-Actions runners are wanted.

## Self-hosting

See [`SELF-HOSTING.md`](../SELF-HOSTING.md) for the canonical step-by-step guide. In one paragraph: clone the repo, authenticate with `void auth login`, set `BETTER_AUTH_SECRET` + `WRIGHTFUL_PUBLIC_URL` (via `void secret put`), and run `pnpm deploy` — `void deploy` builds the app, applies the Drizzle migrations in `apps/dashboard/db/migrations/`, and provisions the D1 database + R2 bucket + KV bindings, then you sign up via the dashboard, create a team + project, and mint an API key. No resource creation, no separate migrate step. `void deploy` ships to Void's managed Cloudflare platform by default; you can also deploy to your own Cloudflare account.

## Key Design Decisions

### Streaming reporter, not a JSON-file uploader

The original plan was a CLI that reads Playwright's built-in JSON report after the suite ends. We switched to a streaming Reporter implementation because (1) streaming matches the dashboard's realtime progress model — users see results live as tests complete, not after the suite ends, and (2) the per-test emission cadence integrates more cleanly with sharded CI than a single end-of-suite POST.

### Per-shard streaming, dashboard merges

Each CI shard's reporter streams independently. The dashboard groups shards by idempotency key (derived from CI env vars like `GITHUB_RUN_ID`) and presents merged views. No merge step required in CI; works naturally with any CI system that exposes a build/run ID.

### Stable test IDs via hashing

Playwright's internal `test.id` is not stable across runs. We generate our own by hashing `file + titlePath + projectName`. This enables cross-run tracking but means renamed/moved tests appear as new tests. See "Known limitations" above.

### Artifacts only for failures (default)

To keep R2 storage manageable, the default reporter config uploads traces/screenshots/videos only for failed and flaky tests. Users can override with `artifacts: 'all'`. This matches Playwright's recommended `trace: 'on-first-retry'` and `screenshot: 'only-on-failure'` config.

### Worker-proxied artifact upload + signed-token download

Artifacts are uploaded by the reporter to a worker route (`PUT /api/artifacts/:id/upload`, returned by `register`) and served to the browser from a worker route (`GET /api/artifacts/:id/download`) gated by a short-lived HMAC token that carries the R2 key (so GETs skip the DB). Both directions are **worker-proxied** — the worker `storage.put`s the upload body and `storage.get`s + streams the download bytes, so it is on the byte path for every artifact transfer. This means Worker CPU time, egress, and request/response-size limits apply to artifact traffic; capacity and failure-mode planning must account for the worker on the data path. (A real presigned-R2 model that takes the worker off the byte path would be a separate, deliberate architectural change.) Served content types are normalized against an allowlist with `Content-Disposition: attachment` to prevent stored-XSS via artifact downloads.

### Server-rendered pages over a React SPA

Every dashboard page is server-rendered (Void Inertia-style): a `*.server.ts` loader queries the data layer and returns props. No client-side data fetching for the initial render, no REST API to maintain for the UI. Client islands only for interactive bits: charts, sortable tables, filter dropdowns, realtime progress subscriptions.

### Multiple API keys from day one

Instead of a single shared secret, each project supports multiple labelled API keys. Keys are SHA-256 hashed at rest and individually revocable. This avoids the painful migration from "one key" to "many keys" that would otherwise be needed when a key leaks or a pipeline is decommissioned.

### Tags and annotations as first-class tables

Tags and annotations are stored in dedicated tables (`testTags`, `testAnnotations`) rather than JSON strings, so they can be filtered and joined efficiently. Adds insertion complexity but is essential for the "filter by tag" feature on run detail and flaky test pages.

### Migration policy

Schema lives in `apps/dashboard/db/schema.ts`; migrations are generated with `void db generate` into `apps/dashboard/db/migrations/` and applied by `void deploy`. Changes are forward-only / additive (new tables, new nullable columns); never edit a migration already applied to a live database. (Pre-migration, the project used a single in-place `0000_init` Kysely-DSL migration per DO — superseded by the Drizzle migration history under Void.)

## Decisions (Resolved)

| Question                                | Decision           | Rationale                                                                                                                                                       |
| --------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Support non-Playwright runners?         | No                 | Playwright-specific features (traces, annotations, projects) are core differentiators. Generalization would dilute the product.                                 |
| Framework?                              | Void               | Server-rendered pages + auto-provisioned bindings + one-command deploy on Cloudflare. (Migrated from RedwoodSDK in 2026-05.)                                    |
| Single D1 vs per-tenant DO + ControlDO? | Single D1          | Void removes the provisioning friction that motivated DOs; write rate is trivial; one store = cross-team joins + simpler ops. Reversed the earlier DO decision. |
| Drizzle vs Kysely?                      | Drizzle            | Ships with Void; typed routes + typed fetch; D1 `batch` atomicity. Reversed the earlier Kysely decision.                                                        |
| CLI uploader vs streaming reporter?     | Streaming reporter | Matches the dashboard's realtime model; per-test emission integrates cleanly with sharded CI.                                                                   |
| Bring-your-own-Postgres alternative?    | No                 | Split maintenance focus kills OSS projects. Community contribution if demand exists.                                                                            |
| License                                 | MIT                | Lower friction for adoption, matches Playwright itself.                                                                                                         |
| Monorepo tooling                        | pnpm workspaces    | Skip Turborepo unless pain is felt — overhead for a few packages.                                                                                               |
| Naming                                  | Wrightful          | Rebranded from "Greenroom" on 2026-04-16. Short, memorable, pairs with the `wrightful.dev` domain.                                                              |
