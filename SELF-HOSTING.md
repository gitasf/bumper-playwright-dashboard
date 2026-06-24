# Self-hosting Wrightful

Wrightful's dashboard is a [Void](https://void.cloud) app that runs on Cloudflare Workers: one Worker for the dashboard + ingest API, one **Postgres** database (auth, tenancy, runs, and test data) reached over **Cloudflare Hyperdrive**, and one R2 bucket for artifact bytes. You bring your own Postgres — [Neon](https://neon.tech) has a free tier that's ample for self-hosting, and [PlanetScale Postgres](https://planetscale.com) is a good scale-up. The R2 binding `STORAGE` and the `HYPERDRIVE` (Postgres) binding are the only data bindings — no KV. Synthetic monitoring (optional) adds two Cloudflare **Queues** (`monitors`, `uptime`) and, for **browser** monitors, a **Sandbox container**; five rate-limiter bindings ship in `wrangler.template.jsonc`. See [Synthetic monitors](#synthetic-monitors-optional) for what to provision — the two queues are always needed; the Sandbox container only for browser monitors (or set `WRIGHTFUL_MONITOR_EXECUTOR=stub` to skip it).

There are two ways to deploy:

- **[Deploy to your own Cloudflare account](#recommended-deploy-to-your-own-cloudflare-account) (recommended)** — `wrangler deploy` against a Postgres database (reached over Hyperdrive) + an R2 bucket you create. The build output is a standard Cloudflare Worker, so this is the most predictable, production-ready path.
- **[One-command deploy with Void](#alternative-one-command-deploy-with-void-still-early) (simpler, still early)** — `void deploy` ships to Void's managed Cloudflare platform and auto-provisions everything with no Cloudflare account. The platform is young, so prefer the Cloudflare path above for anything you depend on.

Both produce the same Worker from the same checked-in migrations.

---

## Recommended: deploy to your own Cloudflare account

Prerequisites: Node 22.18+ (the repo's `engines.node`), `pnpm`, a Cloudflare account, and `wrangler` (`npm i -g wrangler`, then `wrangler login`).

```bash
git clone https://github.com/<your-username>/wrightful.git
cd wrightful
pnpm install
cd apps/dashboard          # the wrangler/build steps below run from here
```

> **Minimum to go live:** a Postgres database + a Hyperdrive config + an R2 bucket + the two Queues (step 1); the build inputs `CF_WORKER_NAME`, `CF_R2_BUCKET`, `CF_HYPERDRIVE_ID` and a `DATABASE_URL` for migrations (steps 2–3); and exactly two runtime secrets, `WRIGHTFUL_PUBLIC_URL` and `BETTER_AUTH_SECRET` (step 5). Everything else — GitHub OAuth, email, browser (Sandbox) monitors, direct-R2 — is optional and defaults off.

### 1. Provision Postgres + create the Cloudflare resources

You need a Postgres database, a Hyperdrive config that points at it, an R2 bucket, and two Queues. Provision the Postgres database first — [Neon](https://neon.tech) (free tier) is the easy default; [PlanetScale Postgres](https://planetscale.com) or any other Postgres works too — and copy its connection string. Then create the Hyperdrive config (the runtime path to that Postgres), the bucket, and the queues:

```bash
# A Hyperdrive config over your Postgres — prints a config id; keep it for step 2.
wrangler hyperdrive create wrightful-pg --connection-string="postgres://USER:PASS@HOST/DB?sslmode=require"
wrangler r2 bucket create wrightful-artifacts
# The two monitor queues. ALWAYS required, even if you never create a monitor:
# the build always emits both queue producer/consumer bindings (inferred from
# apps/dashboard/queues/), so `wrangler deploy` fails with "Queue … does not
# exist" until they're created. wrangler does NOT auto-create queues the way it
# can auto-provision the R2 bucket. (Queues require a Workers Paid plan.)
wrangler queues create monitors
wrangler queues create uptime
```

### 2. Point Wrangler at your resources (via `CF_*` env vars)

**You do not hand-edit `wrangler.jsonc`.** It's gitignored and generated from the committed `apps/dashboard/wrangler.template.jsonc` by `scripts/gen-wrangler.mjs`, which injects your deployment IDs from `CF_*` env vars and materializes `wrangler.jsonc` in the dev/build/deploy pre-hooks. So no account-specific IDs are ever committed.

One time only, drop any locally-tracked copy so the generator owns it:

```bash
git rm --cached apps/dashboard/wrangler.jsonc   # if it's still tracked in your clone
```

Then set these as env vars (in `apps/dashboard/.env.local` for local dev, or as build vars in CI — see [Auto-deploy on push](#auto-deploy-on-push-recommended)):

```bash
# The Worker name (any name you like).
CF_WORKER_NAME=wrightful-dashboard-void
# The R2 bucket from step 1 (→ STORAGE binding).
CF_R2_BUCKET=wrightful-artifacts
# From `wrangler hyperdrive create` in step 1 (→ HYPERDRIVE binding).
CF_HYPERDRIVE_ID=<config id from step 1>
```

`gen-wrangler` injects a `hyperdrive[HYPERDRIVE]` block from `CF_HYPERDRIVE_ID` plus an `r2_buckets[STORAGE]` block from `CF_R2_BUCKET`. The rate-limiter bindings and Void's `main`/`assets`/`migrations` are handled by the template + plugin — you don't touch those.

At runtime the Worker reaches Postgres through Hyperdrive (the `HYPERDRIVE` binding). **Local dev and migrations connect directly** via a `DATABASE_URL` instead (Hyperdrive is runtime-only) — set that in `apps/dashboard/.env.local`:

```bash
DATABASE_URL=postgresql://USER:PASS@HOST:5432/DB?sslmode=require
```

### 3. Apply migrations to the remote database

`pnpm db:migrate:remote` applies the committed `db/migrations/` to your remote/prod Postgres over `$DATABASE_URL` — the **direct** connection, since Hyperdrive is runtime-only and can't be used for migrations:

```bash
DATABASE_URL=postgresql://USER:PASS@HOST:5432/DB?sslmode=require   pnpm db:migrate:remote
```

### 4. Build and deploy

```bash
pnpm deploy:cf      # = pnpm build && wrangler deploy; prints your https://<worker>.<subdomain>.workers.dev URL
```

`pnpm build` runs the Cloudflare Vite plugin, which writes `dist/ssr/wrangler.json` (your real IDs + Void's `main`/`assets`/triggers) plus a `.wrangler/deploy/config.json` redirect; `wrangler deploy` reads that redirect so it ships the built output rather than re-reading the source `wrangler.jsonc`.

> **Why `pnpm build`, not `vp build` directly (temporary — pending upstream Void fixes):** the `build` script's `postbuild` hook runs two small scripts that patch `dist/ssr/wrangler.json` so a raw `wrangler deploy` accepts it. Both are workarounds for confirmed Void build-vs-deploy gaps — Void's build emits a config tuned for `void deploy` (which patches these at deploy time), so own-account `wrangler deploy` needs the fixups. `void deploy` runs `vite build` directly (not `pnpm build`), so neither touches the managed path.
>
> 1. **`scripts/void-patches/strip-d1-binding.mjs`** removes a vestigial D1 `DB` binding. Void keys its "needs D1" flag off the app importing `void/db`, **not** off the dialect — so a Postgres-only build (real binding `HYPERDRIVE`) still emits `d1_databases: [{ binding: "DB", database_id: "local" }]`. The `"local"` sentinel is fine for `vite dev` / `void deploy`, but `wrangler deploy` rejects it: `binding DB of type d1 must have a valid database_id [code: 10021]`. Nothing reads `env.DB`, so the strip is safe. (Reproduced on `void@0.9.3`.)
> 2. **`scripts/void-patches/add-ws-do-migration.mjs`** registers the realtime `void/ws` Durable Object classes in the `migrations` block. The build emits the ws-room DO bindings but never their migrations — a one-line guard bug: the build's websocket migration block fires only `if (!Array.isArray(resolved.migrations))`, but `migrations` is always pre-initialized to `[]`, so it never runs (the sandbox/live DO blocks instead append via `.some()` and work). So `wrangler deploy` refuses the bindings: `Cannot create binding for class 'WsProjectProjectIdWs' … [code: 10061]`. The script adds a `new_classes` migration (Void's `void-ws-v1` shape) for any DO class missing from `migrations`.
>
> **Teardown:** each is independent. Once Void gates the D1 binding on the dialect, delete script 1; once Void emits the ws DO migration into the build output, delete script 2. When both are gone, delete `scripts/void-patches/`, drop the `postbuild` hook, and point `deploy:cf` back at `vp build`. Full background + teardown live in [`apps/dashboard/scripts/void-patches/README.md`](./apps/dashboard/scripts/void-patches/README.md).

### 5. Set secrets

`wrangler secret put` applies to the live Worker immediately (no redeploy needed). Until they're set the dashboard 500s on sign-in pages — that's expected on first deploy.

```bash
openssl rand -base64 32 | wrangler secret put BETTER_AUTH_SECRET
wrangler secret put WRIGHTFUL_PUBLIC_URL     # paste the URL wrangler printed in step 4
```

Use the `workers.dev` URL from step 4, or a [custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) you map to the Worker. See [Environment variables](#environment-variables) for the optional keys (GitHub OAuth, open signup, etc.), then jump to [Sign up + wire up the reporter](#sign-up--wire-up-the-reporter).

### Updating

```bash
git pull origin main
pnpm install
cd apps/dashboard
pnpm db:migrate:remote   # apply any new migrations first (see step 3)
pnpm deploy:cf
```

### Auto-deploy on push (recommended)

The recommended CD path is **[Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)** — connect the repo once and Cloudflare builds + deploys on push, with previews for non-production branches. Connect your repo under the Worker's **Settings → Builds**, then fill the build settings exactly as below:

```
Root directory:                apps/dashboard
Build command:                 pnpm build
Deploy command (production):   pnpm db:migrate:remote && npx wrangler deploy
Deploy command (non-prod):     npx wrangler versions upload
```

> **Root directory is mandatory — change it from the default.** Cloudflare defaults the **Root directory** field to `/`; you **must** set it to `apps/dashboard`. Left at `/`, the production deploy breaks two ways: `pnpm db:migrate:remote` and `pnpm build` are scripts in `apps/dashboard/package.json` (not the root manifest), so a bare `pnpm db:migrate:remote` from the repo root is "command not found"; and `npx wrangler deploy` discovers the built output via `apps/dashboard/.wrangler/deploy/config.json`, which it only sees when run from `apps/dashboard`.

This is a pnpm workspace with a single lockfile at the repo root. pnpm resolves the workspace by walking up from `apps/dashboard`, so install + build work fine with the Root directory set there. (If a build ever fails to resolve the `@wrightful/reporter` `workspace:*` dependency, override the install command to run from the monorepo root, e.g. `pnpm -w install`.)

**Build and deploy run as two phases that share the workspace.** The build (`pnpm build`) writes the worker bundle plus the deploy redirect described in step 4; the separate `npx wrangler deploy` reads that redirect to ship it — not a standalone rebuild. (The manual step 4 and the GitHub Actions sample fold both into `pnpm deploy:cf`; Workers Builds splits them only because it has separate Build- and Deploy-command fields.)

The migration runs in the **production** deploy command only — the build runs for every branch (including preview branches), so you don't want every preview mutating your prod schema. Non-prod branches upload a version without migrating.

Set the deployment IDs as build **variables** (`CF_WORKER_NAME`, `CF_R2_BUCKET`, `CF_HYPERDRIVE_ID`), and `DATABASE_URL` (your prod Postgres **direct** connection) as a build **secret**. The build environment runs `gen-wrangler` (via the `prebuild` hook) and the migration, so **your prod database must be reachable from Cloudflare's build environment** for `db:migrate:remote` to apply.

Runtime app secrets (`BETTER_AUTH_SECRET`, `WRIGHTFUL_PUBLIC_URL`, …) are **not** build inputs. Set them once on the Worker — CF dashboard → your Worker → **Settings → Variables and Secrets** → add as an encrypted Secret, or `wrangler secret put` if you have wrangler logged in locally. They persist across Builds deploys.

> **Migration safety (expand/contract).** Migrate-before-deploy is safe for **additive** ("expand") migrations: if the deploy fails after the migration, the old code keeps serving on the new schema — just re-run. **Destructive ("contract") changes** — dropping a column the live code still reads — must ship in a **later** deploy, once no running version depends on the old shape. Migrations are forward-only and tracked, so each runs once.

<details>
<summary>GitHub Actions alternative</summary>

If you'd rather run CD from Actions, add `CLOUDFLARE_API_TOKEN` (Workers Scripts + R2 edit scopes) and `CLOUDFLARE_ACCOUNT_ID`, plus `DATABASE_URL` (your prod Postgres direct connection), as repo secrets:

```yaml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      # CF_WORKER_NAME / CF_R2_BUCKET / CF_HYPERDRIVE_ID / DATABASE_URL as needed
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22", cache: "pnpm" }
      - run: pnpm install
      - working-directory: apps/dashboard
        run: |
          pnpm db:migrate:remote
          pnpm deploy:cf
```

</details>

---

## Alternative: one-command deploy with Void (still early)

> Void's managed deploy provisions Postgres (over Hyperdrive) + R2 and applies migrations in one command with no Cloudflare account — handy for a quick throwaway or preview instance.

Prerequisites: Node 22.18+ (the repo's `engines.node`), `pnpm`, a Void account.

```bash
pnpm install

# 1. Authenticate (interactive). The first `void deploy` (step 3) prompts to
#    create or link a project; or run `void project link` explicitly first.
pnpm --filter @wrightful/dashboard exec void auth login

# 2. Set secrets (remote secrets persist across deploys).
openssl rand -base64 32 | pnpm --filter @wrightful/dashboard exec void secret put BETTER_AUTH_SECRET
pnpm --filter @wrightful/dashboard exec void secret put WRIGHTFUL_PUBLIC_URL

# 3. Deploy — builds, applies db/migrations/, provisions Postgres + R2, goes live.
pnpm deploy
```

`pnpm deploy` runs `void deploy`, which reads the checked-in `apps/dashboard/db/migrations/`, fails if the schema source (`db/schema.ts`) has drifted ahead of them (run `pnpm db:generate`, commit, retry), applies any pending migrations, and goes live — no separate migrate step, no hand-edited binding config. For auto-deploy on push, `void init --github` writes a `.github/workflows/deploy.yml` that runs `void deploy` with a `VOID_TOKEN` secret (from `void auth token`).

---

## Environment variables

Wrightful reads two kinds of configuration. **Build-time** inputs configure the build and the migration step (set as Cloudflare Workers Builds variables/secrets, or CI repo secrets) and are _not_ read by the running Worker. **Runtime** inputs are declared and validated in `apps/dashboard/env.ts` and read by the Worker — set them with `wrangler secret put NAME` or a plain Worker variable (Cloudflare path), or `void secret put NAME` (Void path). For local dev, copy `apps/dashboard/.env.example` to `apps/dashboard/.env.local` and fill it in. A missing required runtime key 500s the dashboard; `void deploy` additionally hard-errors before upload.

### Build-time variables & secrets

Consumed by `gen-wrangler` and `pnpm db:migrate:remote` during the build/deploy, not by the running Worker. On Workers Builds set the `CF_*` as **variables** and `DATABASE_URL` as a **secret**; the GitHub Actions path additionally needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (or `VOID_TOKEN` for Void) — see [Auto-deploy on push](#auto-deploy-on-push-recommended).

| Name               | Secret? | Default                    | Purpose                                                                                                                                                   |
| ------------------ | ------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CF_WORKER_NAME`   | No      | `wrightful-dashboard-void` | Worker name; injected into `wrangler.jsonc` by `gen-wrangler`.                                                                                            |
| `CF_R2_BUCKET`     | No      | —                          | R2 bucket name → `STORAGE` binding.                                                                                                                       |
| `CF_HYPERDRIVE_ID` | No      | —                          | Hyperdrive config id → `HYPERDRIVE` (Postgres) binding.                                                                                                   |
| `CF_OBSERVABILITY` | No      | `false`                    | Truthy (`true`/`1`/`yes`/`on`) injects an `observability` block (Workers Logs) into `wrangler.jsonc`. View logs with `wrangler tail` or the CF dashboard. |
| `DATABASE_URL`     | **Yes** | —                          | Prod Postgres **direct** connection for `pnpm db:migrate:remote` (and `vp dev`). **Not** a runtime secret — prod reaches Postgres via `HYPERDRIVE`.       |

### Runtime variables & secrets

Read by the Worker. Only `WRIGHTFUL_PUBLIC_URL` + `BETTER_AUTH_SECRET` are required; everything else is optional and defaulted, so an instance runs without setting any of it. The `Secret?` column marks **confidentiality** — `Yes` means the value is sensitive and must never be a plain-text variable. It is _not_ the same axis as durability across deploys (see the warning below).

> **On the own-account Cloudflare path, set _every_ runtime key as an encrypted Secret — even the non-secret ones.** `wrangler deploy` treats the `vars` in your Wrangler config as the authoritative set of plain-text variables: on each deploy it overwrites the Worker's plain-text vars with exactly what's in the config, deleting any you added through the dashboard that the config doesn't list. The committed `wrangler.template.jsonc` deliberately lists **none** of these runtime keys (no per-deployment values are ever committed — see [step 2](#2-point-wrangler-at-your-resources-via-cf_-env-vars)), so anything you set as a plain Worker **Variable** vanishes on the next `pnpm deploy:cf` / Workers Builds push. Setting it as a **Secret** (`wrangler secret put NAME`, or CF dashboard → **Settings → Variables and Secrets** → type **Secret**) is the fix: secrets live outside the Wrangler config lifecycle and persist across deploys. This applies even to non-sensitive keys like `AUTH_GITHUB_CLIENT_ID`, `ALLOW_OPEN_SIGNUP`, and `EMAIL_FROM` — on this path "Secret" is just the mechanism that makes a value stick.
>
> **Don't try to fix it with a placeholder `vars` entry.** Adding e.g. `AUTH_GITHUB_CLIENT_ID: ""` to the template doesn't help — it makes every deploy actively reset the value to the placeholder (clobbering your real value), and a binding name can't be both a `var` and a secret, so defining it in `vars` forecloses the secret approach.
>
> The Void path (`void secret put`) and Workers Builds dashboard secrets persist the same way. Local dev reads `apps/dashboard/.env.local`, which is unaffected.

| Name                           | Required? | Secret? | Default              | Purpose                                                                                                                                                                    |
| ------------------------------ | --------- | ------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WRIGHTFUL_PUBLIC_URL`         | Yes       | No      | —                    | Public origin users hit (`https://<worker>.<you>.workers.dev` or a custom domain). OAuth callbacks + artifact-download token audience.                                     |
| `BETTER_AUTH_SECRET`           | Yes       | Yes     | —                    | Signs session cookies + artifact download tokens. 32+ random bytes (`openssl rand -base64 32`). Auto-created on Void.                                                      |
| `ARTIFACT_TOKEN_SECRET`        | No        | Yes     | `BETTER_AUTH_SECRET` | Dedicated signer for artifact download tokens — rotate to revoke leaked links without logging everyone out. 32+ bytes.                                                     |
| `AUTH_GITHUB_CLIENT_ID`        | No        | No      | —                    | Enables "Continue with GitHub" (with the secret below). [OAuth app](https://github.com/settings/developers) callback `${WRIGHTFUL_PUBLIC_URL}/api/auth/callback/github`.   |
| `AUTH_GITHUB_CLIENT_SECRET`    | No        | Yes     | —                    | Pair with `AUTH_GITHUB_CLIENT_ID` — both must be set or the button stays hidden.                                                                                           |
| `ALLOW_OPEN_SIGNUP`            | No        | No      | `false`              | Allow public email/password sign-up. On a public instance pair with `EMAIL_FROM` (verification); otherwise add users via invites.                                          |
| `EMAIL_FROM`                   | No        | No      | —                    | From address for verification / password-reset / monitor-alert email (Cloudflare Email Service). Unset = email off (graceful) — see [Production notes](#production-notes). |
| `WRIGHTFUL_MAX_ARTIFACT_BYTES` | No        | No      | 50 MiB               | Per-artifact upload size cap.                                                                                                                                              |
| `WRIGHTFUL_RUN_STALE_MINUTES`  | No        | No      | 30                   | How long a run can sit `running` before the cron watchdog interrupts it.                                                                                                   |
| `WRIGHTFUL_SWEEP_BATCH_SIZE`   | No        | No      | 200                  | Max stale runs the watchdog finalizes per cron invocation.                                                                                                                 |
| `REALTIME_INTERNAL_SECRET`     | No        | Yes     | per-build random     | Pins the internal realtime-broadcast secret across deploys (see [Production notes](#production-notes)). 32+ bytes.                                                         |

The feature areas below add their own optional runtime keys — all defaulted.

### GitHub Checks (PR commit status)

Posts a check run on a PR's head commit reflecting the run outcome. **All-or-nothing**: enabled only when `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` + `GITHUB_APP_WEBHOOK_SECRET` are all set. This is a GitHub **App** (mints an installation token that works on fork PRs) — distinct from the `AUTH_GITHUB_*` OAuth creds used for sign-in. In the App's settings, set the **Webhook URL** to `${WRIGHTFUL_PUBLIC_URL}/api/github/webhook` and the **Webhook secret** to your `GITHUB_APP_WEBHOOK_SECRET`; the route 404s until all three `GITHUB_APP_*` secrets are set.

| Name                        | Required?  | Default | Purpose                                                                                                                                                  |
| --------------------------- | ---------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_APP_ID`             | For Checks | —       | GitHub App id.                                                                                                                                           |
| `GITHUB_APP_PRIVATE_KEY`    | For Checks | —       | App private key, **PKCS#8** PEM (`BEGIN PRIVATE KEY`). Convert GitHub's PKCS#1: `openssl pkcs8 -topk8 -nocrypt -in key.pem`.                             |
| `GITHUB_APP_WEBHOOK_SECRET` | For Checks | —       | Verifies inbound App webhooks (installation / check-run).                                                                                                |
| `GITHUB_APP_SLUG`           | No         | —       | The App's public slug (`github.com/apps/<slug>`). Drives the one-click "Install" button on team settings; without it the page shows manual instructions. |

### Data retention

Two independent axes (artifact bytes vs. test-result rows) swept by the `sweep-retention` cron. These are instance-wide defaults; a team can override its own windows in team settings. **Invariant:** `WRIGHTFUL_RETENTION_ARTIFACT_DAYS` ≤ `WRIGHTFUL_RETENTION_TEST_RESULTS_DAYS`.

| Name                                    | Default | Purpose                                                                                  |
| --------------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `WRIGHTFUL_RETENTION_ARTIFACT_DAYS`     | 30      | Age after which artifact R2 objects + rows are swept.                                    |
| `WRIGHTFUL_RETENTION_TEST_RESULTS_DAYS` | 90      | Age after which `testResults` rows (+ cascaded children) are swept (run summaries kept). |
| `WRIGHTFUL_RETENTION_SWEEP_BATCH_SIZE`  | 200     | Max rows per axis per project per cron pass (drains across passes).                      |

### Data export / query API

| Name                        | Default | Purpose                                                                                                                                                                                        |
| --------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WRIGHTFUL_EXPORT_MAX_ROWS` | 50000   | Hard cap on rows a single CSV export streams (`/api/v1/*?format=csv`, `/api/t/.../export/*`). Past it, the response sets `X-Wrightful-Export-Truncated: true` rather than silently truncating. |

The Bearer-authed read/query API lives under `/api/v1/*` (rate-limited via the `QUERY_RATE_LIMITER`). See [`docs/api/query-export.md`](./docs/api/query-export.md).

### Synthetic monitors (optional)

Scheduled browser / HTTP / TCP·ping checks. The `sweep-monitors` cron enqueues due monitors to the `monitors` (browser) / `uptime` (http·tcp) Queues; the consumers run them via the configured executor. **HTTP/TCP monitors** need only the two Queues (plain `fetch()` / `connect()` — no container). **Browser monitors** additionally need a Sandbox container running the user's Playwright. There is no global off-switch — the `sweep-monitors` cron and the two queue consumers always ship — but with zero monitors created the sweep is a harmless no-op. `WRIGHTFUL_MONITOR_EXECUTOR` only selects how **browser** monitors execute (`sandbox` container vs in-process `stub`); it has no value that disables monitoring.

> The two Queues (`monitors`, `uptime`) are **not** optional and **not** monitor-specific — both consumers ship in every build, so `wrangler deploy` fails until the queues exist regardless of whether you use monitors. Create them in [step 1](#1-provision-postgres--create-the-cloudflare-resources) (`wrangler queues create monitors` + `… uptime`). On the Void managed path they're provisioned automatically.

Container provisioning on the Cloudflare path (browser monitors only): build `apps/dashboard/Dockerfile.sandbox`, push it to a registry, and replace the `REPLACE_WITH_REGISTRY/wrightful-sandbox:latest` placeholder in `apps/dashboard/void.json`'s `sandbox` block. Container wiring follows Void's [Cloudflare integration guide](https://void.cloud/integrations/cloudflare); on the Void managed path it's provisioned automatically. Since `wrangler.template.jsonc` deliberately omits container / Durable-Object bindings (Void manages those), the simplest own-account setup uses HTTP/TCP monitors plus `WRIGHTFUL_MONITOR_EXECUTOR=stub` for browser monitors, and follows the integration guide only when you want real browser containers.

| Name                                        | Default   | Purpose                                                                                     |
| ------------------------------------------- | --------- | ------------------------------------------------------------------------------------------- |
| `WRIGHTFUL_MONITOR_EXECUTOR`                | `sandbox` | `sandbox` (Void Sandbox container) or `stub` (in-process synthetic run; dev/CI, no Docker). |
| `WRIGHTFUL_MONITOR_MAX_PER_PROJECT`         | 25        | Per-project cap on **browser** monitors (each multiplies container runs).                   |
| `WRIGHTFUL_HTTP_MONITOR_MAX_PER_PROJECT`    | 50        | Per-project cap on HTTP (uptime) monitors.                                                  |
| `WRIGHTFUL_TCP_MONITOR_MAX_PER_PROJECT`     | 50        | Per-project cap on TCP/ping monitors.                                                       |
| `WRIGHTFUL_HTTP_CHECK_MAX_BODY_BYTES`       | 256 KiB   | Max response-body bytes buffered for an HTTP body/JSON assertion.                           |
| `WRIGHTFUL_MONITOR_MAX_DURATION_SECONDS`    | 300       | Hard per-execution wall-clock cap for a browser run.                                        |
| `WRIGHTFUL_MONITOR_EXECUTION_STALE_MINUTES` | 30        | Minutes a `queued`/`running` execution can sit before the reaper marks it `error`.          |
| `WRIGHTFUL_MONITOR_SWEEP_BATCH_SIZE`        | 200       | Max due monitors the sweep cron enqueues per invocation.                                    |

### Direct-R2 artifact serving (optional)

By default the Worker is on the artifact byte path in both directions — uploads stream through the Worker into R2, and downloads stream back out. For a high-traffic instance you can take the Worker off the byte path: set the four R2 S3-API credentials below and artifact bytes go **direct to R2** via SigV4 presigned URLs (downloads `302` to a presigned GET / the trace viewer embeds one directly; uploads `PUT` to a presigned URL). Unset (the default), bytes stream through the Worker as before — no behaviour change until all four are present. Design rationale: [`docs/adr/0003-direct-r2-artifact-byte-path.md`](./docs/adr/0003-direct-r2-artifact-byte-path.md).

This is an **own-account `deploy:cf`** capability (you need control of the R2 bucket and an S3 API token). Mint a token in the Cloudflare dashboard under **R2 → Manage R2 API Tokens** (Object Read & Write), then set them on the Worker — the two credentials (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) as secrets via `wrangler secret put`; `R2_ACCOUNT_ID` and `R2_BUCKET` aren't sensitive and can be plain vars (running them through `secret put` works too):

| Name                   | Purpose                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `R2_ACCOUNT_ID`        | Cloudflare account id.                                           |
| `R2_ACCESS_KEY_ID`     | R2 S3 API token access key id.                                   |
| `R2_SECRET_ACCESS_KEY` | R2 S3 API token secret.                                          |
| `R2_BUCKET`            | The artifact bucket name (same bucket as the `STORAGE` binding). |

Two pieces of out-of-band setup:

1. **Bucket CORS** — presigned downloads are fetched cross-origin by the browser and the Playwright trace viewer, so the bucket needs a CORS policy. Save the following as `cors.json` and apply with `wrangler r2 bucket cors set <BUCKET> --file cors.json` (replace `<your-dashboard-origin>`):

   ```json
   [
     {
       "AllowedOrigins": [
         "https://<your-dashboard-origin>",
         "https://trace.playwright.dev"
       ],
       "AllowedMethods": ["GET", "HEAD", "PUT"],
       "AllowedHeaders": [
         "Range",
         "If-None-Match",
         "If-Match",
         "Content-Type",
         "Content-Length"
       ],
       "ExposeHeaders": [
         "ETag",
         "Content-Range",
         "Accept-Ranges",
         "Content-Length"
       ],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

2. **No custom domain.** Presigned URLs only work on the `<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` S3 endpoint — Cloudflare does **not** honour SigV4 on a custom domain. Serving artifacts from a branded `artifacts.example.com` would require Cloudflare WAF HMAC tokens (Pro plan or above) and is not yet implemented (deferred in ADR 0003). Leave the bucket's public `r2.dev` access disabled; presigned URLs do not need it.

---

## Production notes

**Pin `REALTIME_INTERNAL_SECRET`** — the worker authenticates its internal realtime broadcasts (run/project live updates) with a secret that, by default, is a fresh random value baked into each build. During a rolling deploy, the old and new versions briefly hold different secrets, so cross-version broadcasts are rejected (a logged 403). This is non-fatal — the data is already in the database and live views catch up on reload — but if you deploy often and care about uninterrupted live updates, set a stable value once: `openssl rand -base64 32 | wrangler secret put REALTIME_INTERNAL_SECRET` (or `void secret put` on the Void path).

**Rate limiting needs a trusted client-IP header** — the auth/API rate limiters key unauthenticated requests by `CF-Connecting-IP`, falling back to the first hop of `X-Forwarded-For`. When the Worker runs on Cloudflare (both deploy paths above), `CF-Connecting-IP` is always set by the edge and cannot be spoofed. If you front the instance with anything else — or proxy to it through your own infrastructure — note that `X-Forwarded-For` is client-controlled: a sender can rotate it freely to dodge per-IP limits. Make sure your edge sets `CF-Connecting-IP` (or strips and rewrites `X-Forwarded-For`) from the real client address before the request reaches the Worker.

**What "closed signup" actually closes** — with `ALLOW_OPEN_SIGNUP=false`, email/password registration is disabled, but GitHub OAuth sign-in (when configured) can still create accounts. That is deliberate: invites don't create accounts, so OAuth signup is how an invited teammate gets one on a closed instance. The resource boundary is enforced one step later — a self-registered account with no team membership cannot **create a team** (and therefore can't reach projects, API keys, or synthetic monitors). The only exception is a fresh instance with zero teams, so the first user — you — can bootstrap. Existing members can always create additional teams.

**Features fail closed when unconfigured** — these shipped surfaces silently no-op (rather than erroring) until configured, so an unconfigured instance is fine: GitHub Checks are skipped unless the three `GITHUB_APP_*` secrets are set (the `/api/github/webhook` 404s otherwise); browser monitors error at execution if `WRIGHTFUL_MONITOR_EXECUTOR=sandbox` but no container is wired (HTTP/TCP monitors still work).

**Email is optional (`EMAIL_FROM`)** — account verification, password reset, and monitor down/recovery alerts only send when `EMAIL_FROM` is set and its domain is onboarded to Cloudflare Email Service. Without it the dashboard runs normally: signup skips verification (so a public instance with open signup but no email lets anyone in unverified — set `EMAIL_FROM` for public instances), the password-reset page reports that email isn't configured, and monitor alerts are silently skipped. In local `vp dev` the send is **simulated** — logged to the console with the rendered HTML/text written to a temp file — so you never send real mail while developing.

**Retention is destructive** — the `sweep-retention` cron permanently deletes aged artifact bytes and test-result rows. Keep `WRIGHTFUL_RETENTION_ARTIFACT_DAYS` ≤ `WRIGHTFUL_RETENTION_TEST_RESULTS_DAYS` (artifacts are the costly axis, swept sooner). The settings form enforces this invariant for a team's **own** override windows; the instance-wide env defaults are **not** cross-validated, so set them correctly yourself (the sweep stays safe either way — an expiring test-result always has its artifact bytes cleaned regardless of window config). Both are instance defaults; teams can widen/narrow their own windows in settings.

---

## Sign up + wire up the reporter

Open your `WRIGHTFUL_PUBLIC_URL` in a browser.

1. **Sign up** with email/password (or GitHub if configured). Set `ALLOW_OPEN_SIGNUP=true` first if you're the first user, then turn it off.
2. Create a team via `/settings/teams/new`.
3. Create a project via `/settings/teams/<team-slug>/projects/new`.
4. Generate an API key from the project's keys page (`/settings/teams/<team-slug>/p/<project-slug>/keys`). Save the printed key — only its SHA-256 hash is stored server-side.

In your Playwright project's CI, set:

```bash
WRIGHTFUL_URL=https://<your-dashboard-origin>
WRIGHTFUL_TOKEN=<the key from step 4>
```

Then install the reporter:

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

Results stream to your dashboard as tests run.

---

## Troubleshooting

**First load 500s on sign-in pages** — `WRIGHTFUL_PUBLIC_URL` or `BETTER_AUTH_SECRET` isn't set. List what's set with `wrangler secret list` (or `void secret list` on the Void path); tail runtime logs with `wrangler tail` (or `void project logs --level error`).

**Schema drift on build/deploy** — the schema source (`db/schema.ts`) is ahead of the committed migrations. Run `pnpm db:generate` (= `void db generate`), review the new files under `db/migrations/`, and commit them. On the Cloudflare path, re-apply with `pnpm db:migrate:remote` then redeploy; `void deploy` applies pending migrations itself.

**Migration discipline** — schema changes are forward-only / additive (new tables, new nullable columns). Generate a new numbered migration with `pnpm db:generate` (from `db/schema.ts`); never edit a migration that has already been applied to a live database.

**"Continue with GitHub" doesn't appear** — both `AUTH_GITHUB_CLIENT_ID` and `AUTH_GITHUB_CLIENT_SECRET` must be set; the button is gated on both being present. The provider is enabled in `apps/dashboard/auth.ts` at startup when those creds exist — it is deliberately **not** declared in `apps/dashboard/void.json`'s `auth.providers` (which lists only `email`), because declaring it there would make Void hard-require the GitHub creds on every deploy.

**A runtime variable I set keeps disappearing after a deploy** (e.g. `AUTH_GITHUB_CLIENT_ID` vanishes, so the GitHub button stops showing) — you set it as a plain-text Worker **Variable**, and `wrangler deploy` wiped it. On the own-account path the Wrangler config is authoritative for plain-text `vars`, and the template lists no runtime keys, so each deploy deletes any plain Variable you added via the dashboard. Re-add it as an encrypted **Secret** (`wrangler secret put AUTH_GITHUB_CLIENT_ID`) — secrets persist across deploys. Full explanation in [Runtime variables & secrets](#runtime-variables--secrets).

**Artifacts fail to upload** — confirm the `STORAGE` (R2) binding resolved. On the Cloudflare path that means `CF_R2_BUCKET` was set so `gen-wrangler` injected the `r2_buckets` block into the generated `wrangler.jsonc` with a real `bucket_name`; tail logs with `wrangler tail`. Per-artifact size is capped by `WRIGHTFUL_MAX_ARTIFACT_BYTES` (default 50 MiB).

---

## What's under the hood

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full architecture overview (Postgres over Hyperdrive + Drizzle, logical tenancy, R2 artifact storage, `void/ws` realtime rooms, the streaming ingest protocol, and the cron/queue background work). For the exact binding-merge semantics on the Cloudflare path, see the Void [Cloudflare integration guide](https://void.cloud/integrations/cloudflare#deploy-to-your-own-cloudflare-account).
