import { betterAuth, type SecondaryStorage } from "better-auth";
import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { ulid } from "ulid";
import { env } from "cloudflare:workers";
import { getControlDb } from "@/control";
import { captureGithubLogin } from "@/lib/github-login";

// Cloudflare KV requires `expirationTtl >= 60`. Better Auth always passes
// session-class TTLs (cookie cache 5 min, sessions 7 days, OAuth verifications
// minutes) so this is mostly a defensive floor, not a real-world clamp.
function buildSecondaryStorage(kv: KVNamespace): SecondaryStorage {
  return {
    get: (key) => kv.get(key),
    set: async (key, value, ttl) => {
      const opts =
        typeof ttl === "number" && ttl > 0
          ? { expirationTtl: Math.max(60, Math.floor(ttl)) }
          : undefined;
      await kv.put(key, value, opts);
    },
    delete: (key) => kv.delete(key),
  };
}

export function hasGithubOAuthConfigured(): boolean {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

function getGithubOAuthCreds():
  | { clientId: string; clientSecret: string }
  | undefined {
  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

function buildAuth() {
  const publicUrl = env.WRIGHTFUL_PUBLIC_URL;
  const secret = env.BETTER_AUTH_SECRET;

  if (!publicUrl || !secret) {
    throw new Error(
      "Wrightful requires WRIGHTFUL_PUBLIC_URL and BETTER_AUTH_SECRET. Locally, set them in packages/dashboard/.dev.vars. In production, set them as environment variables on your Worker (Cloudflare dashboard → Workers & Pages → your worker → Settings → Variables). Generate BETTER_AUTH_SECRET with `openssl rand -base64 32`.",
    );
  }

  // GitHub OAuth is optional. Self-hosters who just want email/password can
  // skip registering a GitHub OAuth app entirely.
  const githubCreds = getGithubOAuthCreds();
  const socialProviders = githubCreds
    ? {
        // `read:org` is required so we can list the user's GitHub
        // organisations and surface teams that auto-grant access based
        // on org membership.
        github: { ...githubCreds, scope: ["read:org", "user:email"] },
      }
    : undefined;

  // KV-backed secondary storage. Cloudflare auto-provisions the AUTH_KV
  // binding on first `wrangler deploy` (see wrangler.jsonc#kv_namespaces).
  // Better Auth stores sessions in KV instead of the singleton ControlDO;
  // reads on the cookie-cache-miss path go to KV (~1–10 ms) instead of an
  // RPC to ControlDO. Users / accounts / verifications / app data remain
  // in ControlDO.
  //
  // Stateless sessions: revocation lag is bounded by the cookie cache
  // (5 min), same as today, so this doesn't change sign-out semantics.
  // KV eviction would log a user out involuntarily — rare; same outcome
  // as a session expiring slightly earlier than scheduled.
  //
  // Optional in code so the test suite (no env binding) and any
  // misconfigured deployment fall back gracefully to ControlDO.
  const authKv = env.AUTH_KV;
  const secondaryStorage = authKv ? buildSecondaryStorage(authKv) : undefined;

  return betterAuth({
    baseURL: publicUrl,
    secret,
    // kyselyAdapter uses Better Auth's default camelCase field names
    // (`userId`, `emailVerified`, …). The ControlDO migrations create
    // tables with camelCase columns verbatim — no plugin layer required.
    database: kyselyAdapter(getControlDb(), { type: "sqlite" }),
    secondaryStorage,
    advanced: {
      // Keep Wrightful's ULID convention for user/session/account/verification ids.
      database: { generateId: () => ulid() },
    },
    emailAndPassword: {
      enabled: true,
      // Email sending isn't wired up; verification would block sign-up.
      // Flip this on once an email provider is configured.
      requireEmailVerification: false,
    },
    socialProviders,
    session: {
      // Sign the resolved session into a short-lived cookie alongside the
      // session ID. Subsequent requests verify the signature in-memory and
      // skip both KV and the ControlDO lookup until the cache ages out.
      // Tradeoff: a sign-out / revoke from another device only takes effect
      // on this device when the cookie expires (max 5 min). Same lag bound
      // applies whether sessions live in KV or ControlDO.
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
      },
      // Default behavior when `secondaryStorage` is set: sessions live in
      // KV only — not in ControlDO. Sessions are pure cache; KV's TTL
      // handles expiration; revocation lag is gated by the cookie cache.
      // Without `secondaryStorage` (no KV binding), sessions fall back
      // to ControlDO automatically, so this default is correct in both
      // configurations.
    },
    databaseHooks: {
      account: {
        // Capture the user's GitHub login on first OAuth sign-in (and on
        // re-auth) so directed invites addressed to a login can resolve
        // when the invitee lands on the team picker. Awaited but failures
        // are swallowed — email-keyed invites still resolve, and the next
        // sign-in retries the fetch.
        create: {
          after: async (account) => {
            if (account.providerId !== "github") return;
            try {
              await captureGithubLogin(account.userId, account.accessToken);
            } catch {
              // Best effort — don't block sign-in on a GitHub API hiccup.
            }
          },
        },
        update: {
          after: async (account) => {
            if (account.providerId !== "github") return;
            try {
              await captureGithubLogin(account.userId, account.accessToken);
            } catch {
              // Best effort.
            }
          },
        },
      },
    },
  });
}

let cached: ReturnType<typeof buildAuth> | null = null;

export function getAuth(): ReturnType<typeof buildAuth> {
  if (!cached) cached = buildAuth();
  return cached;
}
