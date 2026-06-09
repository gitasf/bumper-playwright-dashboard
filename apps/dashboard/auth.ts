import { defineAuth, type VoidAuthConfigContext } from "void/auth";
import { ulid } from "ulid";
import type { MirrorableAccount } from "@/lib/github-account-mirror";

// Derive hook signatures from void/auth's defaults shape so we don't have
// to add a direct dependency on `better-auth` (it's transitive via `void`).
// Better Auth's `create.after` and `update.after` share the same
// `(account, context) => Promise<void>` shape — using `create` covers both.
type AccountAfter = NonNullable<
  NonNullable<
    NonNullable<
      NonNullable<VoidAuthConfigContext["defaults"]["databaseHooks"]>["account"]
    >["create"]
  >["after"]
>;
type AccountRow = Parameters<AccountAfter>[0];
type AccountContext = Parameters<AccountAfter>[1];

/**
 * Customize the void-managed Better Auth instance.
 *
 * Void owns the mount path (`/api/auth/*`), the D1 adapter, and the
 * `BETTER_AUTH_SECRET` lifecycle. `void.json#auth.providers` declares only
 * `["email"]` — GitHub is registered HERE, conditionally, only when both
 * `AUTH_GITHUB_CLIENT_ID` / `AUTH_GITHUB_CLIENT_SECRET` are set. (Declaring
 * `github` in `void.json` would make void hard-require those creds at startup
 * — `resolveSocialProviderCredentials` throws on empty creds — which breaks a
 * clean checkout that has no GitHub OAuth app. Keeping the gate in this file
 * matches the request-time `githubOAuthEnabled` predicate the login/signup
 * pages already use.)
 *
 * We extend that surface with:
 *   - ULID ids for auth rows (matches the rest of the schema).
 *   - `requireEmailVerification: false` until an email sender is wired up.
 *   - A post-create/update hook on the `account` row that mirrors the GitHub
 *     login into `userGithubAccounts` so directed-by-github-handle invites can
 *     resolve. Better Auth only stores the numeric `accountId`; we need the
 *     human-readable login as well. The capture-and-upsert (and its
 *     config-time-safe dynamic imports) lives in
 *     `@/lib/github-account-mirror`; both hooks delegate to
 *     `runGithubAccountMirror`, which owns the chain-default-then-guard
 *     ordering and logs (rather than swallows) capture failures.
 */

// GitHub OAuth creds + open-signup flag are read via Node's `process.env` so
// this works at `void prepare` (config-evaluation time, before void's typed
// `env` proxy is bound). The same decode rules — register the GitHub provider
// only when BOTH creds are set (so a clean checkout works without a GitHub
// OAuth app), and open signup off unless explicitly truthy — are owned for the
// request-time loaders by `@/lib/config` (`githubOAuthEnabled` /
// `openSignupAllowed`). They're inlined HERE, not imported, because `void
// prepare` evaluates this file in a bare Node context that can't resolve the
// `@/lib` alias for a static value import (the same reason the github mirror
// below is loaded via a deferred dynamic import). Keep the two in sync.
const githubClientId = process.env.AUTH_GITHUB_CLIENT_ID;
const githubClientSecret = process.env.AUTH_GITHUB_CLIENT_SECRET;
const openSignupAllowed = /^(true|1)$/i.test(
  process.env.ALLOW_OPEN_SIGNUP ?? "",
);

// The github-login mirror is imported dynamically (deferred to request time)
// for the same config-time-loadability reason as the dynamic `void/db` /
// `@schema` imports inside the mirror itself: `void prepare` evaluates this
// file in a bare Node context that can't resolve a static `.ts` source import.
// Both account hooks delegate here; the chain-default-then-guard ordering and
// log-on-failure live in `runGithubAccountMirror`.
function mirrorGithubAccount(
  account: MirrorableAccount,
  chainDefault: () => Promise<void> | void,
): Promise<void> {
  return import("@/lib/github-account-mirror").then((m) =>
    m.runGithubAccountMirror(account, chainDefault),
  );
}

export default defineAuth(({ defaults }) => ({
  ...defaults,
  advanced: {
    ...defaults.advanced,
    database: { ...defaults.advanced?.database, generateId: () => ulid() },
  },
  emailAndPassword: {
    ...defaults.emailAndPassword,
    enabled: true,
    requireEmailVerification: false,
    disableSignUp: !openSignupAllowed,
  },
  socialProviders: {
    ...defaults.socialProviders,
    ...(githubClientId && githubClientSecret
      ? {
          github: {
            clientId: githubClientId,
            clientSecret: githubClientSecret,
            // Only `user:email` (required for the email claim). The previous
            // `read:org` scope existed for GitHub-org auto-join team
            // suggestions, which were replaced by directed invites
            // (docs/worklog/2026-05-05-directed-invites-replace-org-link.md) —
            // nothing reads org membership anymore, so requesting it just
            // inflates the OAuth consent screen.
            scope: ["user:email"],
          },
        }
      : {}),
  },
  databaseHooks: {
    ...defaults.databaseHooks,
    account: {
      ...defaults.databaseHooks?.account,
      create: {
        ...defaults.databaseHooks?.account?.create,
        after: (account: AccountRow, context: AccountContext) =>
          mirrorGithubAccount(account, () =>
            defaults.databaseHooks?.account?.create?.after?.(account, context),
          ),
      },
      update: {
        ...defaults.databaseHooks?.account?.update,
        after: (account: AccountRow, context: AccountContext) =>
          mirrorGithubAccount(account, () =>
            defaults.databaseHooks?.account?.update?.after?.(account, context),
          ),
      },
    },
  },
}));
