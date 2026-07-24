import { boolean, defineEnv, number, oneOf, string, url } from "void/env";
import { z } from "zod";

export default defineEnv({
  /**
   * Public origin for the dashboard. Used by void auth for OAuth callback
   * URLs and for building artifact download links sent back to the reporter.
   * Local dev: http://localhost:5173. Production: set via `void secret put`.
   */
  WRIGHTFUL_PUBLIC_URL: url(),

  /**
   * Auth signing secret. ≥32 chars (generate with `openssl rand -base64 32`).
   * Drives Better Auth's session cookie HMAC and our short-lived artifact
   * download tokens. On Void Cloud this is auto-created if unset.
   */
  BETTER_AUTH_SECRET: string().secret(),

  // ---------- Database (Postgres over Hyperdrive) ----------

  /**
   * Postgres connection string for LOCAL dev and for `pnpm db:migrate:remote`
   * (e.g. `postgresql://user:pass@localhost:5432/wrightful`). Void's `void/db`
   * resolves it for the local Drizzle node-postgres instance; in production the
   * connection comes from the managed Hyperdrive binding instead, so this stays
   * unset there. Optional + secret.
   */
  DATABASE_URL: string().secret().optional(),

  /**
   * Optional dedicated secret for signing short-lived artifact download tokens.
   * Decouples those (low-value, broadly-minted, HTML-embeddable) capabilities
   * from the session-signing BETTER_AUTH_SECRET: with it set, a leaked artifact
   * token is revoked by rotating THIS secret without logging out every user.
   * Falls back to BETTER_AUTH_SECRET when unset (backward compatible). ≥32 chars.
   * The fallback precedence is owned by `resolveArtifactTokenSecret` in
   * src/lib/config.ts — see it before changing this rule.
   */
  ARTIFACT_TOKEN_SECRET: string().secret().optional(),

  // ---------- Direct-R2 artifact byte path (optional; unset = Worker proxy) ----------
  /**
   * R2 S3-API credentials that, when ALL FOUR are present, switch the artifact
   * byte path from streaming-through-the-Worker to **direct-to-R2** via SigV4
   * presigned URLs (downloads 302 to / trace viewer embeds a presigned GET;
   * uploads PUT to a presigned URL). The single signal is `r2DirectEnabled()`
   * in `src/lib/config.ts`; unset (the default — local dev, e2e, and any
   * un-migrated deploy) falls through to today's `storage.get`/`storage.put`
   * proxy path, unchanged. Own-account `deploy:cf` only — mint an R2 S3 API
   * token in the Cloudflare dashboard (see SELF-HOSTING.md). `void deploy` never
   * hard-fails on their absence.
   *
   * Presigned URLs MUST target the account S3 endpoint
   * (`<R2_ACCOUNT_ID>.r2.cloudflarestorage.com/<R2_BUCKET>/<key>`) — Cloudflare
   * does NOT honor SigV4 on custom domains (a branded custom domain would need
   * WAF HMAC + Pro plan; deferred, see ADR 0003). All four are required together.
   */
  R2_ACCOUNT_ID: string().optional(),
  R2_ACCESS_KEY_ID: string().secret().optional(),
  R2_SECRET_ACCESS_KEY: string().secret().optional(),
  R2_BUCKET: string().optional(),

  // ---------- Trace viewer ----------
  /**
   * Optional cookieless origin for `/trace-viewer/*`. Set before building;
   * unset keeps snapshots same-origin with scripts disabled. See SELF-HOSTING.md.
   */
  VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN: url().optional(),

  /**
   * GitHub OAuth credentials, in Void's `AUTH_<PROVIDER>_CLIENT_{ID,SECRET}`
   * naming convention. The github social provider is enabled in `auth.ts` at
   * startup only when BOTH are set — deliberately NOT declared in
   * `void.json#auth.providers` (which lists only "email"), because declaring it
   * there would make Void hard-require these creds on every deploy. Leave both
   * unset to hide the "Continue with GitHub" button.
   */
  AUTH_GITHUB_CLIENT_ID: string().optional(),
  AUTH_GITHUB_CLIENT_SECRET: string().secret().optional(),

  // ---------- GitHub App (check runs) ----------

  /**
   * GitHub App credentials for posting check runs that gate PR merges. The
   * feature is enabled only when ALL of APP_ID + PRIVATE_KEY + WEBHOOK_SECRET
   * are set (`githubAppEnabled` in `src/lib/config.ts`); leave them unset to
   * disable. Distinct from the OAuth `AUTH_GITHUB_*` creds (sign-in) — a check
   * run needs an *installation* token, which only a GitHub App can mint, and
   * works on fork PRs where a CI `GITHUB_TOKEN` is read-only.
   *
   * `GITHUB_APP_PRIVATE_KEY` must be a **PKCS#8** PEM (`BEGIN PRIVATE KEY`);
   * convert GitHub's default PKCS#1 key with
   * `openssl pkcs8 -topk8 -nocrypt -in key.pem`. WebCrypto's `importKey("pkcs8")`
   * only accepts PKCS#8.
   */
  GITHUB_APP_ID: string().optional(),
  GITHUB_APP_PRIVATE_KEY: string().secret().optional(),
  GITHUB_APP_WEBHOOK_SECRET: string().secret().optional(),

  /**
   * The GitHub App's public slug (from its settings URL,
   * `github.com/apps/<slug>`). Used to build the "Install" link on the team
   * settings page. Optional — without it the settings card shows manual setup
   * instructions instead of a one-click install button.
   */
  GITHUB_APP_SLUG: string().optional(),

  /**
   * Per-artifact upload size cap. The cap binds in exactly one place:
   * /api/artifacts/register rejects any artifact whose declared sizeBytes
   * exceeds it with a 413. /api/artifacts/:id/upload does NOT re-read the cap —
   * it only asserts the incoming Content-Length equals the already-registered
   * sizeBytes, which is transitively cap-bound because an oversized artifact
   * never gets a row at register. Lowering the cap therefore only affects
   * future registrations, not already-registered in-flight uploads. Default
   * 50 MiB.
   */
  WRIGHTFUL_MAX_ARTIFACT_BYTES: number().default(52428800),

  /**
   * Minutes a run can sit at status='running' before the cron watchdog marks
   * it 'interrupted'. Default 30 — longer than any realistic single test run,
   * shorter than someone-checks-the-dashboard-the-next-morning.
   */
  WRIGHTFUL_RUN_STALE_MINUTES: number().default(30),

  /**
   * Max stale runs the watchdog cron finalizes per invocation. Caps the sweep so
   * a mass-stranding event (an ingest outage leaving thousands of runs stuck at
   * status='running') can't make the cron self-DoS: each finalize is ~2 serial
   * D1/RPC round-trips, so an unbounded drain blows the Workers subrequest/CPU
   * budget and gets killed mid-pass. With a bounded slice each pass makes
   * guaranteed forward progress and the backlog drains across successive runs
   * (each pass re-scans only still-'running' rows). Default 200 — well under the
   * subrequest cap at ~2 round-trips/run, with headroom for the SELECT itself.
   */
  WRIGHTFUL_SWEEP_BATCH_SIZE: number().default(200),

  /**
   * Maximum distinct test-result rows accepted for one run. Further appends
   * return 413. Defaults to 500,000; set to 0 to disable.
   */
  WRIGHTFUL_MAX_TEST_RESULTS_PER_RUN: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(500000),

  // ---------- Billing / usage quotas ----------

  /**
   * `'free'`-tier monthly run-open allowance. `checkQuota` (`src/lib/usage.ts`)
   * blocks `POST /api/runs` once a team's `usageCounters.runsCount` for the
   * current month would exceed this. Non-free tiers are unlimited (no block).
   * Default 1000.
   */
  WRIGHTFUL_FREE_MONTHLY_RUNS: number().default(1000),

  /**
   * `'free'`-tier monthly test-result allowance. Metered (fresh testResults
   * rows per month) but NOT hard-blocked in v1 — surfaced on the usage page and
   * used for the soft-warn signal. Default 100000.
   */
  WRIGHTFUL_FREE_MONTHLY_TEST_RESULTS: number().default(100000),

  /**
   * `'free'`-tier monthly artifact-byte allowance (R2). `registerArtifacts`
   * blocks once a team's `usageCounters.artifactBytes` for the month would
   * exceed this — enforced on FRESH bytes only, so an idempotent re-registration
   * is never blocked. Default 5 GiB.
   */
  WRIGHTFUL_FREE_ARTIFACT_BYTES: number().default(5368709120),

  /**
   * Percent of a tier limit at which `checkQuota` returns `softWarn` (the
   * ingest response sets an `X-Wrightful-Quota-Warning` header and the usage
   * page shows an amber bar) before the hard block at 100%. Default 90.
   */
  WRIGHTFUL_QUOTA_SOFT_WARN_PCT: number().default(90),

  // ---------- Polar billing (optional; unset = billing OFF, UNLIMITED for all tiers) ----------
  /**
   * Polar org access token (sandbox ≠ prod). RUNTIME secret. OPTIONAL: when this
   * AND POLAR_WEBHOOK_SECRET are unset, `billingEnabled()` is false → billing is
   * OFF → every team is UNLIMITED (no caps, no billing UI, no webhook). This is
   * the OSS / self-host default. `void deploy` never hard-fails on its absence.
   */
  POLAR_ACCESS_TOKEN: string().secret().optional(),
  /** Polar webhook signing secret (per-environment). RUNTIME secret. Second half of the `billingEnabled()` signal. */
  POLAR_WEBHOOK_SECRET: string().secret().optional(),
  /**
   * "sandbox" | "production" — drives the Polar SDK `server` field. Default
   * sandbox (D5). `oneOf` so a typo is rejected at validation time (`void env
   * check` / first access / deploy) and `.env.example` carries an `# enum:` hint,
   * rather than silently falling back to sandbox.
   */
  POLAR_MODE: oneOf(["sandbox", "production"]).default("sandbox"),
  /** Polar Product ID for the flat monthly Pro plan (per-environment). */
  POLAR_PRO_PRODUCT_ID: string().optional(),

  /**
   * Maximum teams checked by each billing reconciliation. The randomly ordered
   * sample rotates coverage between runs. Defaults to 500.
   */
  WRIGHTFUL_BILLING_RECONCILE_BATCH_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .default(500),

  // ---------- Pro-tier caps (apply only when billing is ON; PLACEHOLDER / TBA defaults) ----------
  /**
   * `'pro'`-tier monthly run-open allowance. Mirrors `WRIGHTFUL_FREE_MONTHLY_RUNS`
   * but at a high ceiling — Pro is FINITE, not unlimited; only billing-OFF
   * (self-host) is truly unlimited. Enforced by the SAME `checkQuota` machinery as
   * free (soft-warn then 429 at the ceiling). Default 25000 is a PLACEHOLDER / TBA
   * (sensible, product-tunable later — same TBA treatment as the FREE caps).
   */
  WRIGHTFUL_PRO_MONTHLY_RUNS: number().default(25000),
  /**
   * `'pro'`-tier monthly test-result allowance. Mirrors
   * `WRIGHTFUL_FREE_MONTHLY_TEST_RESULTS` at a high ceiling. Default 5000000 is a
   * PLACEHOLDER / TBA (product-tunable later).
   */
  WRIGHTFUL_PRO_MONTHLY_TEST_RESULTS: number().default(5000000),
  /**
   * `'pro'`-tier monthly artifact-byte allowance (R2). Mirrors
   * `WRIGHTFUL_FREE_ARTIFACT_BYTES` at a high ceiling. Default 107374182400
   * (100 GiB) is a PLACEHOLDER / TBA (product-tunable later).
   */
  WRIGHTFUL_PRO_ARTIFACT_BYTES: number().default(107374182400),

  // ---------- Data retention ----------

  /**
   * Default age (DAYS) after which artifact R2 objects + rows are swept, when a
   * team hasn't set its own `retentionArtifactDays`. The storage-cost axis —
   * shorter than run history because bytes (traces/videos) dominate R2 spend.
   * Must stay ≤ `WRIGHTFUL_RETENTION_TEST_RESULTS_DAYS`. Default 30.
   */
  WRIGHTFUL_RETENTION_ARTIFACT_DAYS: number().default(30),

  /**
   * Default age (DAYS) after which `testResults` rows (+ their cascaded
   * attempts/tags/annotations/artifact rows) are swept, when a team hasn't set
   * its own `retentionTestResultsDays`. The D1-size axis; `runs` summary rows
   * are kept (they hold the aggregate counters). Default 90.
   */
  WRIGHTFUL_RETENTION_TEST_RESULTS_DAYS: number().default(90),

  /**
   * Rows of EACH retention axis deleted per project PER DRAIN ITERATION — the
   * chunk size, NOT a per-invocation cap. The sweep keeps draining chunks (round-
   * robin across projects) until its execution budget is spent
   * (`WRIGHTFUL_RETENTION_SWEEP_BUDGET_MS` / `_MAX_CHUNKS`), so total rows per
   * invocation scales with the budget, not this number. Bigger chunks = fewer
   * round-trips; kept well under Postgres's bound-param ceiling. Default 1000.
   */
  WRIGHTFUL_RETENTION_SWEEP_BATCH_SIZE: number().default(1000),

  /**
   * Wall-clock budget (MS) for ONE retention-sweep cron invocation. The drain
   * loop keeps deleting chunks until this elapses (or nothing eligible remains),
   * so the drain rate tracks what a single Cloudflare Workers invocation can do
   * rather than a fixed row cap. Kept under the Workers per-invocation wall-clock
   * limit with margin. Raise it (or run the cron more often) for tenants whose
   * ingest outpaces the drain. Default 20000 (20s).
   */
  WRIGHTFUL_RETENTION_SWEEP_BUDGET_MS: number().default(20000),

  /**
   * Hard backstop on how many PRODUCTIVE drain chunks one retention-sweep
   * invocation may run — a chunk being one project's per-round sweep of both axes
   * that actually deleted rows. An idle project (nothing eligible) does NOT count
   * against this (it costs only its two probe SELECTs, bounded by `_BUDGET_MS`),
   * so a deployment with many idle projects no longer burns the budget on head
   * probes and starves the tail. Wall-clock (`_BUDGET_MS`) is normally the binding
   * limit; this bounds the pathological case of a project with a massive artifact
   * backlog. Each productive chunk costs a bounded handful of subrequests (~7
   * worst case: two axis SELECTs, a cascaded-artifact-key SELECT, two row DELETEs,
   * and the bulk R2 deletes), so this default keeps worst-case subrequests under
   * the Workers per-invocation cap with margin. Default 120.
   */
  WRIGHTFUL_RETENTION_SWEEP_MAX_CHUNKS: number().default(120),

  /**
   * Enable open email/password signup. Off by default — email verification
   * isn't wired yet, so self-hosters running multi-user need to leave this
   * `false` and create users via invites.
   */
  ALLOW_OPEN_SIGNUP: boolean().default(false),

  /**
   * Allows the first team to be created on an otherwise closed instance.
   * Disable it again after bootstrapping. Defaults to false.
   */
  WRIGHTFUL_BOOTSTRAP_FIRST_TEAM: boolean().default(false),

  // ---------- Data export / public query API (roadmap 2.5) ----------

  /**
   * Hard cap on the number of rows a single CSV export streams (roadmap 2.5).
   * Both the Bearer-authed `routes/api/v1/*?format=csv` and the session-authed
   * `/api/t/.../export/*` cursor-page through the same query and stop once this
   * many rows have been written, so a single request can't drain an entire
   * project's history (or blow the Worker CPU/subrequest budget) in one shot.
   * When the cap is hit the response is NOT silently truncated: the handler sets
   * an `X-Wrightful-Export-Truncated: true` header and logs the event, so the
   * caller can detect it and page the rest via the JSON cursor API. Default
   * 50,000 — generous for an ad-hoc spreadsheet pull, well under a runaway. The
   * per-DB-page size used to reach it is a separate internal constant
   * (`EXPORT_PAGE_SIZE` in `src/lib/export.ts`).
   */
  WRIGHTFUL_EXPORT_MAX_ROWS: number().default(50000),

  /**
   * From address for outbound email (verification, password reset, monitor
   * alerts), e.g. `"Wrightful <noreply@mail.example.com>"` or a bare
   * `"noreply@mail.example.com"`. Sent via the Cloudflare Email Service
   * `EMAIL` binding (`send_email` in `wrangler.jsonc`) — the address MUST
   * belong to a domain you've onboarded to CES, or sends are rejected.
   *
   * OPTIONAL: email is an opt-in capability and degrades gracefully. When
   * unset (or the `EMAIL` binding is absent), `isEmailConfigured()` returns
   * false and `sendEmail()` skips — returning `{ sent: false, reason:
   * "not_configured" }` rather than throwing — so a self-hoster who hasn't set
   * up CES is never blocked (and `void deploy` doesn't hard-fail on this key).
   * Resolution + the send transport live in `src/lib/email.ts`. Server-only
   * (no `VITE_` prefix).
   */
  EMAIL_FROM: string().optional(),

  // ---------- Synthetic monitoring ----------

  /**
   * Max due monitors the sweep cron enqueues per invocation. Bounds the cheap
   * select+enqueue pass so a backlog can't blow the 30s sub-hour cron CPU
   * budget; the backlog drains across successive 1-minute ticks. Mirrors
   * `WRIGHTFUL_SWEEP_BATCH_SIZE`. Default 200.
   */
  WRIGHTFUL_MONITOR_SWEEP_BATCH_SIZE: number().default(200),

  /**
   * Per-project cap on the number of BROWSER monitors. A coarse abuse/cost
   * guardrail — each browser monitor multiplies scheduled container runs.
   * Default 25. (HTTP monitors have their own, higher cap below — they're a
   * plain `fetch()`, far cheaper, so users make many.)
   */
  WRIGHTFUL_MONITOR_MAX_PER_PROJECT: number().default(25),

  /**
   * Per-project cap on HTTP (uptime) monitors. Separate from the browser cap
   * because an http check is a plain `fetch()` from the queue consumer — no
   * container, ~free — so a project can hold many without eating its browser
   * budget. Enforced by a TYPE-SCOPED `countMonitors(scope, "http")`, so the two
   * caps never cross-contaminate. Default 50.
   */
  WRIGHTFUL_HTTP_MONITOR_MAX_PER_PROJECT: number().default(50),

  /**
   * Per-project cap on TCP / ping (uptime) monitors. Separate from the http +
   * browser caps for the same reason they're separate from each other: a tcp
   * check is a single raw `connect()` from the queue consumer — no container,
   * ~free — so a project can hold many without eating its other budgets.
   * Enforced by a TYPE-SCOPED `countMonitors(scope, "tcp")`, so the caps never
   * cross-contaminate. Counts `tcp` rows only — a `ping` monitor is stored with
   * `type = 'tcp'` (a ping IS a TCP-connect probe; see `tcp/tcp-run.ts`), so it
   * falls under this cap. Default 50.
   */
  WRIGHTFUL_TCP_MONITOR_MAX_PER_PROJECT: number().default(50),

  /**
   * Max bytes of an HTTP check's response body the executor buffers for
   * body/JSON assertions (read is truncated past this). Bounds Worker memory +
   * the CPU of evaluating a body assertion against a huge payload. The stored
   * `resultDetail.bodyExcerpt` is a much smaller ≤2 KiB slice, kept only when a
   * body assertion failed. Default 256 KiB.
   */
  WRIGHTFUL_HTTP_CHECK_MAX_BODY_BYTES: number().default(262144),

  /**
   * Which `MonitorExecutor` the queue consumer uses. `'sandbox'` (default) runs
   * the user's Playwright in a Void Sandbox container. `'stub'` synthesizes a
   * deterministic run in-process with no container — used by tests and local
   * dev so the full schedule→queue→ingest pipeline is exercisable without Docker.
   */
  WRIGHTFUL_MONITOR_EXECUTOR: string().default("sandbox"),

  /**
   * Hard per-execution wall-clock cap (seconds) for a synthetic browser run.
   * Bounds container cost and stops a runaway user script. Default 300 (5 min).
   *
   * Coupled to `WRIGHTFUL_MONITOR_EXECUTION_STALE_MINUTES`: the reaper cutoff
   * must stay above `maxRetries × this + queue dwell` or a legitimately
   * slow/retrying execution gets reaped mid-flight. If you raise this, raise the
   * stale window too (defaults: 3 × 5 min = 15 min, comfortably under 30 min).
   */
  WRIGHTFUL_MONITOR_MAX_DURATION_SECONDS: number().default(300),

  /**
   * Minutes a monitor execution can sit non-terminal (`queued`/`running`) before
   * the reaper cron flips it to `error`. Covers an enqueue send that failed
   * (stuck `queued`) or a Worker evicted mid-run (stuck `running`); without it
   * those rows leak forever and skew uptime. Also bounds the synthetic-key
   * sweeper's orphan window. Must comfortably exceed a full retry lifecycle
   * (`maxRetries` × `MAX_DURATION_SECONDS` + queue dwell) so a legitimately
   * slow/retrying execution is never reaped mid-flight. Default 30 — mirrors
   * `WRIGHTFUL_RUN_STALE_MINUTES`, and well past 3 × 5 min.
   */
  WRIGHTFUL_MONITOR_EXECUTION_STALE_MINUTES: number().default(30),

  /**
   * OPTIONAL override for the secret authenticating the server's internal
   * DO-to-DO room-publish POST (ingest → `void/ws` room `onRequest` → broadcast).
   * Normally you do NOT set this: a per-build random is baked into the server
   * bundle at build time (`vite.config.ts` → `__WRIGHTFUL_INTERNAL_SECRET__`),
   * which the publisher worker + the room DOs share because they're one
   * deployment — zero config, auto-rotates per deploy, decoupled from
   * BETTER_AUTH_SECRET. Set this only to PIN a stable value across deploys.
   * Precedence (this → build secret; it deliberately NEVER falls back to
   * BETTER_AUTH_SECRET) lives in `resolveInternalSecret`
   * (src/realtime/room-server.ts). Server-only; travels DO-to-DO over
   * Cloudflare's internal RPC, never the public internet. ≥32 chars.
   */
  REALTIME_INTERNAL_SECRET: string().secret().optional(),
});
