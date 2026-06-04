// Feature-flag derivation for the auth-surface flags, owned in one place so
// every reader applies exactly one decode rule. The rules themselves are
// trivial; what's non-obvious — and what this seam captures — is the *dual env
// source*: these flags are read both at config-evaluation time (`auth.ts`,
// evaluated during `void prepare` before void's typed `env` proxy is bound, so
// it uses Node's `process.env`) and at request time (page loaders, where the
// typed `env` proxy is available).
//
// Each resolver takes its source object as an argument and owns the decode, so
// the caller-side reader choice stays explicit while the rule lives once. Both
// `process.env` (string | undefined values) and the typed `env` (string |
// undefined for the GitHub creds, boolean for ALLOW_OPEN_SIGNUP) are valid
// inputs — the resolvers normalize across them.
//
// The request-time loaders (login/signup/profile) import these. `auth.ts` is
// the one config-time site that intentionally *inlines* the same rule rather
// than importing it: `void prepare` can't resolve the `@/lib` alias for a
// static value import in that bare-Node context. Its inline copy carries a
// pointer back here so the two stay in sync.

/**
 * Whether GitHub OAuth is wired up: BOTH `AUTH_GITHUB_CLIENT_ID` and
 * `AUTH_GITHUB_CLIENT_SECRET` are present and non-empty. One source of truth
 * for provider registration (`auth.ts`) and the "Continue with GitHub" button
 * (login/signup/profile loaders), so they can't drift.
 *
 * An empty-string secret (allowed by env.ts's `.optional()` string schema) is
 * treated as unset — `Boolean("")` is false — which matches "not configured".
 */
export function githubOAuthEnabled(source: {
  AUTH_GITHUB_CLIENT_ID?: string | undefined;
  AUTH_GITHUB_CLIENT_SECRET?: string | undefined;
}): boolean {
  return Boolean(
    source.AUTH_GITHUB_CLIENT_ID && source.AUTH_GITHUB_CLIENT_SECRET,
  );
}

/**
 * Whether open email/password signup is enabled.
 *
 * Normalizes across the two env sources: the typed `env` already coerces
 * `ALLOW_OPEN_SIGNUP` to a boolean (`boolean().default(false)`), while
 * `process.env` (read at config time) yields the raw string — where only
 * `"true"`/`"1"` (case-insensitive) count as enabled. Anything else, including
 * undefined and the empty string, is off (matching the env default of false).
 */
export function openSignupAllowed(
  value: boolean | string | undefined,
): boolean {
  if (typeof value === "boolean") return value;
  return /^(true|1)$/i.test(value ?? "");
}

/**
 * The secret that signs artifact-download tokens under a given env: a dedicated
 * `ARTIFACT_TOKEN_SECRET` when set, else the session `BETTER_AUTH_SECRET`
 * (documented in env.ts and surfaced as a one-hour HMAC capability in
 * `artifact-tokens.ts#getKey`). This is the ONE place that precedence lives —
 * `getKey()` is its in-worker consumer, and the e2e boot fixture
 * (`packages/e2e/src/dashboard-fixture.ts`) applies the same rule to decide
 * which value to hand the cross-package HMAC forger. Centralizing it means a
 * maintainer rotating to a dedicated secret can't sign with one value and have
 * the test fixture forge with another.
 *
 * Precedence is `??` (presence, not truthiness) — byte-for-byte the rule
 * `getKey()` previously inlined, so an absent (`undefined`/`null`) secret falls
 * back while any provided value, including the empty string, is honored.
 */
export function resolveArtifactTokenSecret(source: {
  ARTIFACT_TOKEN_SECRET?: string | undefined;
  BETTER_AUTH_SECRET: string;
}): string {
  return source.ARTIFACT_TOKEN_SECRET ?? source.BETTER_AUTH_SECRET;
}
