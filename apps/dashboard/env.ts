import { boolean, defineEnv, number, string, url } from "void/env";

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
   * Enable open email/password signup. Off by default — email verification
   * isn't wired yet, so self-hosters running multi-user need to leave this
   * `false` and create users via invites.
   */
  ALLOW_OPEN_SIGNUP: boolean().default(false),

  // ---------- Synthetic monitoring ----------

  /**
   * Max due monitors the sweep cron enqueues per invocation. Bounds the cheap
   * select+enqueue pass so a backlog can't blow the 30s sub-hour cron CPU
   * budget; the backlog drains across successive 1-minute ticks. Mirrors
   * `WRIGHTFUL_SWEEP_BATCH_SIZE`. Default 200.
   */
  WRIGHTFUL_MONITOR_SWEEP_BATCH_SIZE: number().default(200),

  /**
   * Per-project cap on the number of monitors. A coarse abuse/cost guardrail —
   * each monitor multiplies scheduled browser-container runs. Default 25.
   */
  WRIGHTFUL_MONITOR_MAX_PER_PROJECT: number().default(25),

  /**
   * Floor on a monitor's interval. Cloudflare cron granularity is 1 minute and
   * sub-minute scheduling needs a different primitive (Durable Object alarms),
   * so 60 is the v1 floor; also a cost guard against 10s-interval browser runs.
   */
  WRIGHTFUL_MONITOR_MIN_INTERVAL_SECONDS: number().default(60),

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
