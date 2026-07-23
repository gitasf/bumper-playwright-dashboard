// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
  billingEnabled,
  githubOAuthEnabled,
  openSignupAllowed,
} from "@/lib/config";

/**
 * Capability-flag PARITY: `auth.ts` is evaluated at `void prepare` config time
 * in a bare Node context that cannot import `@/lib/config` (the `@/lib` alias
 * doesn't resolve there — see the long note in auth.ts, verified 2026-06-22),
 * so it re-authors three flag rules BY HAND over `process.env`:
 *
 *   - GitHub OAuth registration: `githubClientId && githubClientSecret`
 *   - open signup:               `/^(true|1)$/i.test(process.env.ALLOW_OPEN_SIGNUP ?? "")`
 *   - Polar billing:             `Boolean(polarAccessToken && polarWebhookSecret)`
 *                                (each token read as `process.env.X ?? ""`)
 *
 * Nothing previously asserted those inline copies agree with the canonical
 * `@/lib/config` predicates the request-time loaders use. This suite closes
 * that gap WITHOUT importing auth.ts (its module graph — void/auth, the Polar
 * SDK — doesn't load under the test stubs, and its booleans aren't exported):
 *
 *   1. Local mirrors of the exact inline expressions are asserted equal to the
 *      config.ts predicates over a shared env-fixture matrix
 *      (present / absent / empty-string; "true"/"1"/"false"/junk).
 *   2. The auth.ts SOURCE TEXT is pinned to still contain those exact
 *      expressions, so editing the inline rule without updating the mirror
 *      here (and consciously re-checking parity) fails CI.
 *
 * Node lane (not `*.workers.test.ts`) because the source pin reads auth.ts
 * off disk via node:fs.
 */

/** A config-time env source: raw `process.env` strings (or absent). */
type ConfigTimeEnv = Record<string, string | undefined>;

// ─── Mirrors of the auth.ts inline rules (pinned to the source below) ────────

function inlineGithubOAuthConfigured(env: ConfigTimeEnv): boolean {
  const githubClientId = env.AUTH_GITHUB_CLIENT_ID;
  const githubClientSecret = env.AUTH_GITHUB_CLIENT_SECRET;
  // auth.ts registers the provider under `githubClientId && githubClientSecret`.
  return Boolean(githubClientId && githubClientSecret);
}

function inlineOpenSignupAllowed(env: ConfigTimeEnv): boolean {
  return /^(true|1)$/i.test(env.ALLOW_OPEN_SIGNUP ?? "");
}

function inlinePolarConfigured(env: ConfigTimeEnv): boolean {
  const polarAccessToken = env.POLAR_ACCESS_TOKEN ?? "";
  const polarWebhookSecret = env.POLAR_WEBHOOK_SECRET ?? "";
  return Boolean(polarAccessToken && polarWebhookSecret);
}

// ─── Shared fixtures ─────────────────────────────────────────────────────────

/** present / absent / empty-string — the states an optional env key can be in. */
const CRED_STATES = ["value", undefined, ""] as const;

/** Every (a, b) combination of two optional creds. */
const CRED_PAIRS = CRED_STATES.flatMap((a) =>
  CRED_STATES.map((b) => [a, b] as const),
);

/** The flag-string states ALLOW_OPEN_SIGNUP can arrive in via process.env. */
const SIGNUP_VALUES = [
  "true",
  "TRUE",
  "1",
  "false",
  "FALSE",
  "0",
  "yes",
  "junk",
  "",
  undefined,
] as const;

describe("auth.ts inline flag rules agree with the @/lib/config predicates", () => {
  it("githubOAuth: inline registration condition === githubOAuthEnabled, over the cred matrix", () => {
    for (const [id, secret] of CRED_PAIRS) {
      const env: ConfigTimeEnv = {
        AUTH_GITHUB_CLIENT_ID: id,
        AUTH_GITHUB_CLIENT_SECRET: secret,
      };
      expect(
        inlineGithubOAuthConfigured(env),
        `id=${id} secret=${secret}`,
      ).toBe(githubOAuthEnabled(env));
    }
  });

  it("openSignup: inline /^(true|1)$/i rule === openSignupAllowed, over the flag-string matrix", () => {
    for (const value of SIGNUP_VALUES) {
      expect(
        inlineOpenSignupAllowed({ ALLOW_OPEN_SIGNUP: value }),
        `ALLOW_OPEN_SIGNUP=${value}`,
      ).toBe(openSignupAllowed(value));
    }
  });

  it("billing: inline polarConfigured === billingEnabled, over the secret matrix", () => {
    for (const [token, secret] of CRED_PAIRS) {
      const env: ConfigTimeEnv = {
        POLAR_ACCESS_TOKEN: token,
        POLAR_WEBHOOK_SECRET: secret,
      };
      expect(
        inlinePolarConfigured(env),
        `token=${token} secret=${secret}`,
      ).toBe(billingEnabled(env));
    }
  });
});

describe("auth.ts source still carries the exact inline rules the mirrors copy", () => {
  const authSource = readFileSync(
    fileURLToPath(new URL("../../auth.ts", import.meta.url)),
    "utf8",
  );

  /** Whitespace-insensitive containment check against the auth.ts source. */
  function expectSourceContains(expression: string) {
    const pattern = new RegExp(
      expression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*"),
    );
    expect(authSource, `auth.ts should contain: ${expression}`).toMatch(
      pattern,
    );
  }

  it("pins the GitHub OAuth cred reads + registration condition", () => {
    expectSourceContains(
      "const githubClientId = process.env.AUTH_GITHUB_CLIENT_ID;",
    );
    expectSourceContains(
      "const githubClientSecret = process.env.AUTH_GITHUB_CLIENT_SECRET;",
    );
    expectSourceContains("githubClientId && githubClientSecret");
  });

  it("pins the open-signup decode rule", () => {
    expectSourceContains(
      '/^(true|1)$/i.test( process.env.ALLOW_OPEN_SIGNUP ?? "", )',
    );
  });

  it("pins the Polar billing reads + configured condition", () => {
    expectSourceContains(
      'const polarAccessToken = process.env.POLAR_ACCESS_TOKEN ?? "";',
    );
    expectSourceContains(
      'const polarWebhookSecret = process.env.POLAR_WEBHOOK_SECRET ?? "";',
    );
    expectSourceContains(
      "const polarConfigured = Boolean(polarAccessToken && polarWebhookSecret);",
    );
  });
});
