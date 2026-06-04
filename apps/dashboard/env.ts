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
});
