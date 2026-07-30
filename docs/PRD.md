# Wrightful — Open Source Playwright Dashboard on Cloudflare

> An open-source Playwright test reporter and analytics dashboard that anyone can self-host on Cloudflare for free.

This document is the strategy + decisions doc — what Wrightful is, what it isn't, and why we made the architectural calls we did. For the request flow, storage layout, and route surface as they stand today, see [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md). For self-hosting steps, see [`SELF-HOSTING.md`](../SELF-HOSTING.md). For the dated narrative behind specific changes, see [`docs/worklog/`](./worklog/).

> **Current architecture:** the dashboard is a Void application backed only by
> Postgres — through Cloudflare Hyperdrive in production and `DATABASE_URL`
> locally — with Drizzle as its data layer. The earlier
> RedwoodSDK/Durable-Object, D1, and short-lived dual-dialect designs are
> historical; see the
> [Void migration record](./worklog/void-migration-consolidated.md) and
> [Postgres-only decision](./worklog/2026-06-16-postgres-only.md).

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

| Layer          | Technology                                          | Why                                                                                                                                                                                                                                      |
| -------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework      | **Void**                                            | Fullstack Vite plugin + deploy platform for Cloudflare. File-based Hono routing + Inertia-style server-rendered pages with co-located loaders.                                                                                           |
| Data store     | **Postgres**                                        | One database holds auth, tenancy, runs, and derived rows. Production connects through Hyperdrive; local development uses `DATABASE_URL`. Tenant isolation is logical (filter by `teamId`/`projectId`), not physical.                     |
| Query builder  | **Drizzle ORM**                                     | Accessed through `void/db`; application schema lives in `db/schema.ts`. Multi-statement writes use the shared `runBatch` transaction seam.                                                                                               |
| Auth/tenancy   | **Better Auth via `void/auth`**                     | Sessions (email + password, optional GitHub OAuth). Better Auth owns its tables in the same Postgres database; the application schema owns tenancy.                                                                                      |
| Realtime       | **`void/ws`**                                       | Managed WebSocket rooms for run and project audiences; ingest broadcasts to those rooms and client islands subscribe with `useRunRoom` / `useProjectRoom`.                                                                               |
| Object storage | **Cloudflare R2**                                   | Stores traces, screenshots, and videos. Bytes are worker-proxied by default; self-hosters who configure all four R2 S3 credentials use SigV4-presigned direct uploads/downloads while retaining the same authorization and expiry rules. |
| Reporter       | **`@wrightful/reporter`**                           | Custom Playwright reporter that streams per-test results live as the suite runs (open run → append batches → complete). Not a JSON-file uploader.                                                                                        |
| CI integration | **GitHub App + reporter fallback**                  | The GitHub App posts aggregate check runs and sticky PR comments. Unsharded GitHub Actions runs can instead opt into the reporter's `GITHUB_TOKEN` comment fallback.                                                                     |
| API auth       | **Bearer API keys**                                 | Per-project keys, SHA-256 hashed at rest, looked up by 8-char prefix. Multiple keys per project with individual revocation.                                                                                                              |
| Dashboard auth | **Better Auth** (sessions; email + optional GitHub) | Email/password sign-in by default, optional GitHub OAuth. Session cookie gates the UI.                                                                                                                                                   |

### Why Void

- Server-rendered Inertia-style pages: a page's `*.server.ts` loader queries the data layer and returns props directly — no separate REST API to maintain for the UI.
- Managed deployment provisions Postgres/Hyperdrive, R2, queues, and runtime
  resources; `pnpm deploy:void` builds, applies committed migrations, and
  deploys them together.
- First-class Drizzle integration with typed routes and a typed fetch client.
- Vite-based dev experience; built-in auth, cron jobs, and realtime (`void/ws`).

### Storage: one Postgres database

Postgres is the sole application database. One store gives Wrightful
cross-team joins, one source of truth, and one migration history without
maintaining parallel dialects. The trade-off is logical rather than physical
tenant isolation: every run-scoped query must filter by `projectId` and by
`teamId` where present. The branded authorization ids on `TenantScope` carry
that checked scope through the type system.

## Architecture

For the canonical view, see [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md). One-paragraph summary:

A single Cloudflare Worker (a Void app) hosts both the streaming ingest API
(`/api/runs/*`, `/api/artifacts/*`) and the server-rendered dashboard UI
(`/t/:teamSlug/p/:projectSlug/…`). API requests authenticate with a
project-scoped Bearer key; dashboard requests carry a Better Auth session
cookie. All application reads/writes go through Drizzle to Postgres, isolated
logically by `teamId`/`projectId`. Artifact metadata lives in Postgres and
bytes live in R2. The Worker proxies artifact bytes by default; optional R2
S3 credentials switch to presigned direct-R2 transfers. Realtime progress is
broadcast to `void/ws` run and project rooms.

### Streaming ingest flow

The reporter doesn't dump a JSON file at the end of the suite — it streams. Three phases:

- `onBegin` → `POST /api/runs` opens the run. The reporter declares the planned test list and gets back a `runId`.
- `onTestEnd` → buffer per test until all retries are settled, then `POST /api/runs/:runId/results` in batches. Each response returns `clientKey → testResultId`, which the reporter uses to register artifacts via `POST /api/artifacts/register`. That returns either a relative worker upload URL (the default) or, when direct R2 is configured, a SigV4-presigned R2 PUT URL.
- `onEnd` → `POST /api/runs/:runId/complete` sets the terminal status.

The route handlers are auth + translation only; the batch pipeline lives behind `openRun` / `appendRunResults` / `completeRun` in `apps/dashboard/src/lib/ingest.ts`. Per-test emission means one row per test at its final outcome, with retries aggregated into `flaky`. Wire types live in both `packages/reporter/src/types.ts` (TypeScript) and `apps/dashboard/src/lib/schemas.ts` (Zod) — keep them in sync; the `packages/reporter/src/__tests__/contract*.test.ts` suites are the canary.

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

The reporter generates an idempotency key per logical execution. It derives
the key from the CI build and job, GitHub run attempt, selected Playwright
project set (excluding shard coordinates), and an optional
`WRIGHTFUL_MATRIX_KEY`. Native Playwright shards deliberately share one key so
they converge on the same dashboard run. An
explicit `WRIGHTFUL_IDEMPOTENCY_KEY` overrides the derivation and must be new
for every new logical execution.

- If the key doesn't exist: insert normally, return `201 Created`
- If it identifies the same in-progress execution: return `200 OK` with the
  existing run ID, skip insertion
- If it identifies a terminal run: reject the stale reuse with `409 Conflict`
- This makes retries safe — a flaky network in CI won't create duplicate runs
  — without letting a rerun overwrite stored terminal results

### Protocol versioning

Reporter requests carry `X-Wrightful-Version`. Currently only version 3 is supported — older reporters/CLIs get a 409 with a clear upgrade message. The version increments when the request/response schema changes in a backwards-incompatible way; additive changes (new optional fields) do not.

## Dashboard pages

### Core views

1. **Team / project picker** (`/`)
   - Lists teams the signed-in user is a member of; landing page.

2. **Runs list** (`/t/:teamSlug/p/:projectSlug`)
   - Table: branch, commit, status (pass/fail), test counts, duration, timestamp
   - Filter by branch, status, date range, tags
   - Shard-aware: every shard contributes to the run sharing its idempotency key; the list shows the merged totals

3. **Run detail** (`/t/:teamSlug/p/:projectSlug/runs/:runId`)
   - Summary: pass/fail/flaky/skipped counts, total duration, commit info
   - Test list: sortable by status, duration, name; filterable by tag
   - In-flight runs: realtime progress via `useRunRoom(runId)` over `void/ws`
   - Sharded runs: per-shard breakdown alongside merged totals

4. **Test detail** (`/t/:teamSlug/p/:projectSlug/runs/:runId/tests/:testResultId`)
   - Error message + stack trace (syntax highlighted)
   - Artifacts: self-hosted trace viewer, screenshots inline, video player
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

The preferred integration is the Wrightful GitHub App. After an aggregate run
reaches a terminal state, the dashboard posts or updates its check run and
sticky PR comment with a summary and deep links. The App's installation token
also works for fork PRs. For an unsharded GitHub Actions run,
`postPrComment: true` remains a no-App fallback using the runner's
`GITHUB_TOKEN`; native shards skip that fallback because each process sees
only a partial summary.

## Self-hosting

See [`SELF-HOSTING.md`](../SELF-HOSTING.md) for the canonical step-by-step guide. In one paragraph: clone the repo, authenticate with `void auth login`, set `BETTER_AUTH_SECRET` + `WRIGHTFUL_PUBLIC_URL` (via `void secret put`), and run `pnpm deploy:void` (the workspace wrapper around `void deploy`) — the Void-managed path builds the app, applies the committed Drizzle migrations, and provisions Postgres through Hyperdrive plus the required R2, queue, and runtime resources. Then temporarily keep `ALLOW_OPEN_SIGNUP=true` through first-team creation, or enable `WRIGHTFUL_BOOTSTRAP_FIRST_TEAM` for that step; disable the temporary bootstrap setting afterward, create a project, and mint an API key. Own-account Cloudflare deployments bring Postgres/R2 resources and run the explicit remote migration command as documented in the guide.

## Key Design Decisions

### Streaming reporter, not a JSON-file uploader

The original plan was a CLI that reads Playwright's built-in JSON report after the suite ends. We switched to a streaming Reporter implementation because (1) streaming matches the dashboard's realtime progress model — users see results live as tests complete, not after the suite ends, and (2) the per-test emission cadence integrates more cleanly with sharded CI than a single end-of-suite POST.

### Per-shard streaming, dashboard merges

Each CI shard's reporter streams independently. Native Playwright shards share
an idempotency key derived from the CI execution identity, so the dashboard
presents one merged run without a CI merge step. Rerun attempts and unrelated
job/project/matrix legs receive distinct keys.

### Stable test IDs via hashing

Playwright's internal `test.id` is not stable across runs. We generate our own by hashing `file + titlePath + projectName`. This enables cross-run tracking but means renamed/moved tests appear as new tests. See "Known limitations" above.

### Artifacts only for failures (default)

To keep R2 storage manageable, the default reporter config uploads traces/screenshots/videos only for failed and flaky tests. Users can override with `artifacts: 'all'`. This matches Playwright's recommended `trace: 'on-first-retry'` and `screenshot: 'only-on-failure'` config.

### Capability-flagged artifact byte path

By default, uploads and downloads are worker-proxied: the reporter PUTs to a
worker route and signed download URLs authorize a worker GET from R2. When all
four optional R2 S3 credentials are configured, registration returns
SigV4-presigned PUT URLs and authorized downloads redirect to presigned GETs,
taking the Worker off the byte path. Both modes share authorization, expiry,
content-type normalization, size checks, and forced download-disposition
rules. See [ADR-0003](./adr/0003-direct-r2-artifact-byte-path.md).

### Server-rendered pages over a React SPA

Every dashboard page is server-rendered (Void Inertia-style): a `*.server.ts` loader queries the data layer and returns props. No client-side data fetching for the initial render, no REST API to maintain for the UI. Client islands only for interactive bits: charts, sortable tables, filter dropdowns, realtime progress subscriptions.

### Multiple API keys from day one

Instead of a single shared secret, each project supports multiple labelled API keys. Keys are SHA-256 hashed at rest and individually revocable. This avoids the painful migration from "one key" to "many keys" that would otherwise be needed when a key leaks or a pipeline is decommissioned.

### Tags and annotations as first-class tables

Tags and annotations are stored in dedicated tables (`testTags`, `testAnnotations`) rather than JSON strings, so they can be filtered and joined efficiently. Adds insertion complexity but is essential for the "filter by tag" feature on run detail and flaky test pages.

### Migration policy

Schema lives in `apps/dashboard/db/schema.ts`; migrations are generated with
`pnpm --filter @wrightful/dashboard db:generate` into
`apps/dashboard/db/migrations/`. Void-managed deploys apply committed
migrations; own-account Cloudflare deployments run the explicit remote
migration command documented in `SELF-HOSTING.md`. Changes are forward-only;
never edit a migration already applied to a live database.

## Decisions (Resolved)

| Question                            | Decision           | Rationale                                                                                                                                                |
| ----------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Support non-Playwright runners?     | No                 | Playwright-specific features (traces, annotations, projects) are core differentiators. Generalization would dilute the product.                          |
| Framework?                          | Void               | Server-rendered pages + auto-provisioned bindings + one-command deploy on Cloudflare. (Migrated from RedwoodSDK in 2026-05.)                             |
| Data store?                         | Postgres only      | One well-supported store and migration history; Hyperdrive in production and a direct URL locally. D1 and the dual-dialect seam were removed in 2026-06. |
| Drizzle vs Kysely?                  | Drizzle            | Ships with Void; schema-owned typed queries, with multi-statement atomicity concentrated behind `runBatch`.                                              |
| CLI uploader vs streaming reporter? | Streaming reporter | Matches the dashboard's realtime model; per-test emission integrates cleanly with sharded CI.                                                            |
| Self-hosted database?               | Bring Postgres     | Postgres is the only backend. Self-hosters provide the database rather than selecting among application dialects.                                        |
| License                             | MIT                | Lower friction for adoption, matches Playwright itself.                                                                                                  |
| Monorepo tooling                    | pnpm workspaces    | Skip Turborepo unless pain is felt — overhead for a few packages.                                                                                        |
| Naming                              | Wrightful          | Finalized on 2026-04-16. Short, memorable, and paired with the `wrightful.dev` domain.                                                                   |
