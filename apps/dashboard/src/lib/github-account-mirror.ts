import { logger } from "void/log";
import { githubFetch } from "@/lib/github-http";

/**
 * The write side of the `userGithubAccounts` mirror.
 *
 * Better Auth (owned by `void/auth`) only stores the numeric GitHub
 * `accountId` on its `account` row; directed-by-github-handle invites resolve
 * against the human-readable *login*, so we capture it at OAuth sign-in and
 * mirror it into our own `userGithubAccounts` table. The read side of that
 * mirror lives in {@link import("./auth-users")} — this module is its
 * counterpart, the single home for the capture-and-upsert.
 *
 * It is invoked from `auth.ts`'s Better Auth `databaseHooks.account`
 * create/update `after` hooks. Those hooks ran byte-identical copies of the
 * "chain the default `after` first, then guard `providerId === "github"`, then
 * best-effort capture" dance — that ordering invariant + guard is concentrated
 * here in {@link runGithubAccountMirror} so the two hooks become one-line
 * delegations.
 *
 * NOTE: `auth.ts` is loaded at `void prepare` config time (before the runtime
 * db/schema bindings exist), so anything it transitively imports must be
 * loadable then. {@link captureGithubLogin} therefore keeps the
 * dynamic-`import("void/db")` / `import("@schema")` trick inside the function
 * body — the bindings are only touched when the hook actually fires at
 * request time. (`void/log`'s `logger` and the env-free `github-http.ts` core
 * are config-time-safe imports.)
 */

/** The subset of a Better Auth `account` row this mirror reads. */
export interface MirrorableAccount {
  userId: string;
  providerId: string;
  accessToken?: string | null;
}

/**
 * Fetch the GitHub login for `accessToken` and upsert it into the
 * `userGithubAccounts` mirror. Best-effort: a missing token, a non-OK GitHub
 * response, or an empty/absent `login` is a no-op (callers treat a missing
 * mirror as "backfills on next sign-in"). Throws only on unexpected fetch / DB
 * failure — {@link runGithubAccountMirror} is responsible for logging those.
 */
export async function captureGithubLogin(
  userId: string,
  accessToken: string | null | undefined,
): Promise<void> {
  if (!accessToken) return;
  // Standard GitHub envelope + 10s timeout via the env-free `github-http.ts`
  // core, so a hung GitHub call can't stall the sign-in hook this runs in.
  // (`github-http` deliberately has no `void/env` in its import graph, so this
  // module stays loadable at `void prepare` config time — see the module note
  // above; the env-reading App-auth seam lives in `github-app.ts`.)
  const res = await githubFetch("/user", {}, accessToken);
  if (!res.ok) return;
  const body = (await res.json()) as { login?: unknown };
  if (typeof body.login !== "string" || body.login === "") return;
  const login = body.login.toLowerCase();
  // Epoch-seconds, matching the `big()` timestamp convention (see db/schema.ts).
  const nowSeconds = Math.floor(Date.now() / 1000);
  // Dynamic imports so `auth.ts` stays loadable at `void prepare` config time.
  const [{ db }, { userGithubAccounts }] = await Promise.all([
    import("void/db"),
    import("@schema"),
  ]);
  await db
    .insert(userGithubAccounts)
    .values({ userId, githubLogin: login, updatedAt: nowSeconds })
    .onConflictDoUpdate({
      target: userGithubAccounts.userId,
      set: { githubLogin: login, updatedAt: nowSeconds },
    });
}

/**
 * Run the GitHub-login mirror for a Better Auth `account.{create,update}.after`
 * hook, concentrating the ordering + guard + failure-handling invariants both
 * hooks shared:
 *
 *   1. await `chainDefault` first so void's own bookkeeping isn't disturbed;
 *   2. only mirror `github` accounts (skip `credential` / other providers);
 *   3. on capture failure, `logger.warn` (visible under Cloudflare Tail)
 *      instead of swallowing it — a silently-failed mirror leaves directed
 *      github invites unresolvable with zero diagnostic trail;
 *   4. never throw into the hook — a mirror failure must not break sign-in.
 *
 * `capture` is injected so the orchestration (ordering, guard, log-on-failure)
 * is unit-testable without the real GitHub fetch + D1 upsert.
 */
export async function runGithubAccountMirror(
  account: MirrorableAccount,
  chainDefault: () => Promise<void> | void,
  capture: (
    userId: string,
    accessToken: string | null | undefined,
  ) => Promise<void> = captureGithubLogin,
): Promise<void> {
  await chainDefault();
  if (account.providerId !== "github") return;
  try {
    await capture(account.userId, account.accessToken);
  } catch (err) {
    logger.warn("github-account-mirror: failed to mirror github login", {
      userId: account.userId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
