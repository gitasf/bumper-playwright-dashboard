# Wrightful

A Playwright test reporting dashboard. Ships as two pieces:

- **`@wrightful/reporter`** — Playwright reporter that streams results and artifacts to the dashboard live as each test completes.
- **`@wrightful/dashboard`** — a Cloudflare app built on [Void](https://void.cloud) (Vite + React, server-rendered pages; a Postgres database (over Cloudflare Hyperdrive) via Drizzle for auth/tenancy and test data; R2 for artifacts) that ingests results, serves the UI, runs synthetic monitors, and exposes a query/export API.

## Features

- **Live test reporting** — streaming ingest with realtime run progress (`void/ws`); one row per test at its final outcome, retries aggregated into `flaky`; artifacts (traces, screenshots, video) streamed through the worker into R2.
- **Triage & analytics** — test catalog with tag filtering + file/suite grouping, flaky detection with a **quarantine** workflow, **test ownership** (auto-derived from CODEOWNERS), **run-to-run diff**, and duration/uptime insights.
- **Synthetic monitoring** — scheduled **browser / HTTP / TCP·ping** uptime checks, run on a cron→queue→executor pipeline.
- **Integrations** — **GitHub Checks** (PR commit status, fork-PR safe via a GitHub App) and a Bearer-authed **query + CSV export API** under `/api/v1/*` (see [`docs/api/query-export.md`](./docs/api/query-export.md)).
- **Team & admin** — teams/projects/members with **granular RBAC** (owner/member/viewer), an **audit log**, **usage metering + quotas**, and **two-axis data retention**. Everything is behind auth (no anonymous/public views).

## Deploy your own dashboard

The dashboard runs on Cloudflare Workers (one Worker + a Postgres database reached over Hyperdrive + an R2 bucket). The recommended path is to deploy to **your own Cloudflare account** with `wrangler` — the build output is a standard Worker. You bring your own Postgres; [Neon](https://neon.tech) has a free tier that's plenty for self-hosting, and [PlanetScale Postgres](https://planetscale.com) is a good scale-up. A one-command `void deploy` to Void's managed platform also works but is still early. See **[`SELF-HOSTING.md`](./SELF-HOSTING.md)** for both, step by step.

In short, once deployed:

1. **Sign up** in the deployed dashboard and **create a team + project** via `/settings/teams/new` and `/settings/teams/<team-slug>/projects/new`.
2. **Mint an API key** from the project's keys page (`/settings/teams/<team-slug>/p/<project-slug>/keys`). The plaintext key is shown once on creation; the server only stores its SHA-256 hash.

## Wire up the reporter

In your Playwright project:

```bash
pnpm add -D @wrightful/reporter
```

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  reporter: [["list"], ["@wrightful/reporter"]],
});
```

Set credentials in CI (`WRIGHTFUL_TOKEN` is a project-scoped API key — generate one from your project's settings page in the dashboard):

```yaml
env:
  WRIGHTFUL_URL: https://your-dashboard-url.com
  WRIGHTFUL_TOKEN: ${{ secrets.WRIGHTFUL_TOKEN }}
```

Results appear in the dashboard live as tests complete. Shards converge on a single run via a deterministic idempotency key derived from `GITHUB_RUN_ID` (or the equivalent on GitLab/CircleCI). See [`examples/github-actions-workflow.yml`](./examples/github-actions-workflow.yml) for a full workflow.

## Local development

The dashboard is Postgres-only. `pnpm setup:local` boots a local Postgres via Docker (`apps/dashboard/docker-compose.pg.yml`) and writes a matching `DATABASE_URL` — or set `DATABASE_URL` yourself (e.g. a free [Neon](https://neon.tech) branch) to skip Docker.

```bash
pnpm install
pnpm setup:local                                # local Postgres + .env.local + demo team/project/API key + monitors
pnpm dev                                        # dashboard on localhost:5173

# Need additional API keys for local testing? Mint them from the dashboard
# at http://localhost:5173/settings/teams/<team-slug>/p/<project-slug>/keys.

# Populate months of synthetic run history instead of the small Playwright
# fixture set (exercises the history chart, flaky tests page, run-list
# pagination). Implies --no-fixtures.
pnpm setup:local --history                              # 3 months, seed=wrightful-seed-1
pnpm setup:local --history --history-months 6           # 6 months
```

See [`CLAUDE.md`](./CLAUDE.md) for the full command reference (tests, lint, typecheck) and [`docs/worklog/`](./docs/worklog/) for decision history.
