import { defineAuth, type VoidAuthConfigContext } from "void/auth";
import { checkout, polar, portal, webhooks } from "@polar-sh/better-auth";
import { Polar } from "@polar-sh/sdk";
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
// prepare` evaluates this file in a bare Node context that cannot statically
// import the `@/lib/config` source: the `@/lib` alias doesn't resolve, and a
// relative `./src/lib/config` import fails too — extensionless resolution can't
// find the module, and adding the `.ts` extension trips tsgo's TS5097
// (`allowImportingTsExtensions` is off). Both were verified 2026-06-22. So the
// rule is duplicated by hand here; `config.workers.test.ts` pins the canonical
// copy, and the github mirror below is deferred via dynamic import for the same
// config-time-loadability reason. Keep the two in sync.
const githubClientId = process.env.AUTH_GITHUB_CLIENT_ID;
const githubClientSecret = process.env.AUTH_GITHUB_CLIENT_SECRET;
const openSignupAllowed = /^(true|1)$/i.test(
  process.env.ALLOW_OPEN_SIGNUP ?? "",
);
// Email verification turns on ONLY when an email sender is configured. Read
// from `process.env` (not `void/env`) for the same reason as the creds above:
// this file is evaluated at `void prepare` config time too, before void's typed
// `env` proxy is bound. Mirrors the optional-by-default contract in
// `src/lib/email.ts` — no `EMAIL_FROM` ⇒ no verification requirement, so a
// self-hoster who hasn't set up CES is unaffected (and the send hooks below are
// graceful no-ops via `sendEmail`).
const emailConfigured = Boolean(process.env.EMAIL_FROM);

// Polar billing config, read via `process.env` for the same config-time
// (`void prepare`) reason as the creds above. `polarConfigured` is the inline,
// config-time twin of `billingEnabled()` (`@/lib/config`) — it reads the SAME
// two keys, so plugin registration here and the request-time quota/UI gates can't
// disagree. No build flag is needed: the plugin declares no DB tables (fact 1)
// and `new Polar()` never throws (fact 2). When false (the OSS / self-host
// default) no plugin registers, so `POST /api/auth/polar/webhooks` 404s.
const polarAccessToken = process.env.POLAR_ACCESS_TOKEN ?? "";
const polarWebhookSecret = process.env.POLAR_WEBHOOK_SECRET ?? "";
const polarProductId = process.env.POLAR_PRO_PRODUCT_ID;
const polarServer =
  process.env.POLAR_MODE === "production" ? "production" : "sandbox";
const polarConfigured = Boolean(polarAccessToken && polarWebhookSecret);

// Auth emails (verification + reset) are rendered + sent through a request-time
// dynamic import for the same config-time-loadability reason as the github
// mirror above: `@/lib/auth-email` pulls in the React-Email renderer + the
// `cloudflare:workers` email binding, neither of which resolves at `void
// prepare`. The Better Auth hooks fire only at request time, so deferring is safe.
function sendVerificationEmail(args: {
  email: string;
  name?: string | null;
  url: string;
}): Promise<void> {
  return import("@/lib/auth-email").then((m) => m.sendVerificationEmail(args));
}
function sendPasswordResetEmail(args: {
  email: string;
  name?: string | null;
  url: string;
}): Promise<void> {
  return import("@/lib/auth-email").then((m) => m.sendPasswordResetEmail(args));
}

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

// The user-teardown hooks (for the Better Auth `deleteUser` flow below) are
// imported dynamically — deferred to request time — for the same config-time-
// loadability reason as the github mirror above: `void prepare` evaluates this
// file in a bare Node context that can't resolve the `.ts` source. They close
// the logical-FK orphan gap (a deleted user's memberships / group memberships /
// state / github-account rows carry no cascading FK across the auth boundary)
// and enforce the sole-owner guard. See `@/lib/user-teardown`.
function assertUserDeletable(userId: string): Promise<void> {
  return import("@/lib/user-teardown").then((m) =>
    m.assertUserDeletable(userId),
  );
}
function cleanupUserAfterDelete(userId: string): Promise<void> {
  return import("@/lib/user-teardown").then((m) => m.cleanupUserData(userId));
}

// Builds the Polar Better Auth plugin (checkout + portal + auto-mounted webhook
// at POST /api/auth/polar/webhooks). Only invoked when `polarConfigured` is true.
// DB-touching webhook handlers are deferred via request-time dynamic import
// (mirrors the github-mirror / auth-email pattern) so `void prepare` stays clean.
function buildPolarPlugin() {
  const polarSdk = new Polar({
    accessToken: polarAccessToken,
    server: polarServer,
  });
  return polar({
    client: polarSdk,
    createCustomerOnSignUp: false, // D8: lazy team-keyed customer at first checkout
    use: [
      checkout({
        // `slug: "pro"` resolves against this map; productId from env (per-environment).
        products: polarProductId
          ? [{ productId: polarProductId, slug: "pro" }]
          : [],
        // Default success URL — only a fallback. The browser ALWAYS passes a
        // team-scoped `successUrl` (billing-actions.tsx) so teamSlug resolves on
        // return (D6 / S7), making this default effectively unreachable. It points
        // at the generic /settings landing rather than a `__`-placeholder team slug
        // that would 404 if it ever did fire.
        successUrl: "/settings",
        authenticatedUsersOnly: true,
        theme: "dark",
      }),
      portal(),
      webhooks({
        secret: polarWebhookSecret,
        // Defer DB-touching handlers (request-time dynamic import — keeps void prepare clean):
        onSubscriptionActive: (p) =>
          import("@/lib/billing/polar-webhook").then((m) =>
            m.onSubscriptionActive(p),
          ),
        onSubscriptionCanceled: (p) =>
          import("@/lib/billing/polar-webhook").then((m) =>
            m.onSubscriptionCanceled(p),
          ),
        onSubscriptionRevoked: (p) =>
          import("@/lib/billing/polar-webhook").then((m) =>
            m.onSubscriptionRevoked(p),
          ),
        onOrderPaid: (p) =>
          import("@/lib/billing/polar-webhook").then((m) => m.onOrderPaid(p)),
      }),
    ],
  });
}

export default defineAuth(({ defaults }) => ({
  ...defaults,
  // Polar billing plugin, registered ONLY when billing is configured. Preserve
  // any void-default plugins (spread first) so we add rather than clobber.
  plugins: [
    ...(defaults.plugins ?? []),
    ...(polarConfigured ? [buildPolarPlugin()] : []),
  ],
  // Session cookie cache: sign the resolved session into a short-lived cookie so
  // `getSession()` is served in-memory instead of querying Postgres on EVERY
  // authenticated request/navigation (a serialized DB phase per nav otherwise).
  // `maxAge` bounds both the read-avoidance window and the cross-device
  // revocation lag — another device keeps a cached session until its cookie ages
  // out. 5 min keeps revocation lag low for a CI dashboard while cutting the
  // per-nav session read to ~one per active user per window. This was enabled pre-migration
  // (worklog 2026-04-30-better-auth-cookie-cache) but lost when auth moved from
  // the old rwsdk `better-auth.ts` to `void/auth`'s `defineAuth`; re-added here.
  session: {
    ...defaults.session,
    cookieCache: {
      ...defaults.session?.cookieCache,
      enabled: true,
      maxAge: 300,
    },
  },
  advanced: {
    ...defaults.advanced,
    database: { ...defaults.advanced?.database, generateId: () => ulid() },
  },
  // Self-service account deletion, made SAFE by the two hooks: `beforeDelete`
  // blocks a user who is the sole owner of any team (a cascade would strand it),
  // and `afterDelete` sweeps the user's logical-FK rows that void/auth's own
  // cascade doesn't reach. Enabled so the hooks actually fire — a dormant hook
  // would leave the orphan gap open. Guard logic lives in `@/lib/user-teardown`.
  user: {
    ...defaults.user,
    deleteUser: {
      ...defaults.user?.deleteUser,
      enabled: true,
      beforeDelete: (user: { id: string }) => assertUserDeletable(user.id),
      afterDelete: (user: { id: string }) => cleanupUserAfterDelete(user.id),
    },
  },
  emailAndPassword: {
    ...defaults.emailAndPassword,
    enabled: true,
    // On only when a sender is configured (see `emailConfigured`); unset
    // EMAIL_FROM keeps today's no-verification behavior.
    requireEmailVerification: emailConfigured,
    disableSignUp: !openSignupAllowed,
    // 30 minutes — must match the "expires in 30 minutes" copy in the reset
    // email (`src/emails/reset-password.tsx`). Better Auth's default is 1 hour.
    resetPasswordTokenExpiresIn: 60 * 30,
    sendResetPassword: ({ user, url }) =>
      sendPasswordResetEmail({ email: user.email, name: user.name, url }),
  },
  emailVerification: {
    ...defaults.emailVerification,
    // Send the verification email on signup, and sign the user in once they
    // verify. Only auto-send when a sender is configured.
    sendOnSignUp: emailConfigured,
    autoSignInAfterVerification: true,
    // 24 hours — must match the "expires in 24 hours" copy in the verification
    // email (`src/emails/verify-email.tsx`). Better Auth's default is 1 hour.
    expiresIn: 60 * 60 * 24,
    sendVerificationEmail: ({ user, url }) =>
      sendVerificationEmail({ email: user.email, name: user.name, url }),
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
