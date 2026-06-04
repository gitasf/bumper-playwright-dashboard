import { db, eq, or, sql } from "void/db";
import { teamInvites, userGithubAccounts } from "@schema";

/**
 * The single home for reads against the **void-owned** Better Auth tables
 * (`user`, `account`) plus the parallel `userGithubAccounts` mirror.
 *
 * Better Auth's core tables are intentionally NOT declared in our Drizzle
 * schema (see db/schema.ts header) — the two migration runners must not fight
 * over their shape — so every cross-table read of them has to drop to raw SQL
 * and hand-cast the untyped D1 result envelope. That `sql\`... from "user" ...\``
 * + `.results?.[0] as { ... }` pattern is a trust boundary against a schema we
 * don't own; left smeared across the invite / profile / members callers it was
 * re-derived (with case + lowercasing drift) at six sites, and a single site
 * forgetting `.toLowerCase()` on the email is an invite-hijack vector.
 *
 * This module concentrates that knowledge: the magic table names, the result
 * envelope shape, the casts, and email lowercasing all live here, behind three
 * typed reads. It is the ONLY file in the app that issues raw SQL against
 * `"user"` / `account`.
 *
 * NOTE: the *write* side of `userGithubAccounts` (mirroring the GitHub login
 * captured at OAuth sign-in) lives in `@/lib/github-account-mirror`, invoked
 * from `auth.ts`'s Better Auth database hook. It is separate because `auth.ts`
 * is loaded at `void prepare` config time (before the runtime db/schema
 * bindings exist), so the capture-and-upsert uses dynamic imports.
 */

/** The directed-invite identity resolved for a signed-in user. */
export interface UserIdentity {
  /** Lowercased `user.email`, or null when the row/column is absent. */
  email: string | null;
  /** The GitHub login captured at OAuth sign-in, or null. */
  githubLogin: string | null;
}

/** Shape of a single row from the void-owned `account` table. */
export interface UserAccountRow {
  providerId: string;
  createdAt: number | string | null;
}

/** Public profile fields read from the void-owned `user` table. */
export interface UserProfile {
  email: string;
  name: string;
  image: string | null;
}

/**
 * The signed-in user's auth posture, derived from their void-owned `account`
 * rows + the `userGithubAccounts` mirror — with the account-row storage quirks
 * (number-OR-ISO `createdAt`, `credential`/`github` provider ids) resolved
 * behind this seam so page code never touches them.
 */
export interface UserAuthProfile {
  /** True when the user has a `credential` (email+password) account row. */
  hasPassword: boolean;
  /**
   * The linked GitHub account, or null when none is linked. `login` is empty
   * when an `account` row exists but the `userGithubAccounts` mirror is missing
   * (it backfills on the next OAuth sign-in). `connectedAt` is epoch SECONDS.
   */
  github: { login: string; connectedAt: number | null } | null;
}

/**
 * Resolve the email + GitHub login a directed invite can be addressed to.
 *
 * Reads `user.email` via raw SQL (void-owned table) in parallel with the
 * `userGithubAccounts` Drizzle lookup, then merges into the `{ email,
 * githubLogin }` identity. The email is lowercased here so callers never have
 * to remember to — directed invites store emails lowercased, so a missing
 * `.toLowerCase()` would silently fail to match.
 *
 * Used by every invite-redemption path (team-picker pending invites, the
 * token share-link gate, and the accept / decline routes).
 */
export async function getUserIdentity(userId: string): Promise<UserIdentity> {
  const [userRow, githubRow] = await Promise.all([
    db.run(sql`select email from "user" where id = ${userId} limit 1`),
    db
      .select({ githubLogin: userGithubAccounts.githubLogin })
      .from(userGithubAccounts)
      .where(eq(userGithubAccounts.userId, userId))
      .limit(1),
  ]);

  const rawEmail = (userRow.results?.[0] as { email?: string } | undefined)
    ?.email;
  return {
    email: rawEmail ? rawEmail.toLowerCase() : null,
    githubLogin: githubRow[0]?.githubLogin ?? null,
  };
}

/**
 * Fetch the public profile (email/name/image) for a set of user ids via a raw
 * `memberships ⋈ "user"`-style read against the void-owned `user` table.
 * Returns a `Map` keyed by user id so callers can join it against their own
 * rows without re-issuing per-user lookups.
 */
export async function getUsersByIds(
  ids: string[],
): Promise<Map<string, UserProfile>> {
  const out = new Map<string, UserProfile>();
  if (ids.length === 0) return out;

  // D1 caps bound parameters at 100 per statement. Chunk at 99 to stay under
  // the limit regardless of team size (the rest of the codebase does the same).
  const CHUNK = 99;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const idList = sql.join(
      chunk.map((id) => sql`${id}`),
      sql`, `,
    );
    const rows = await db.run(
      sql`select id, email, name, image from "user" where id in (${idList})`,
    );
    const results = (rows.results ?? []) as Array<{
      id: string;
      email: string;
      name: string;
      image: string | null;
    }>;
    for (const r of results) {
      out.set(r.id, { email: r.email, name: r.name, image: r.image });
    }
  }
  return out;
}

/**
 * Read the void-owned `account` rows for a user (one per linked provider —
 * `credential` for email+password, `github` for OAuth) so callers can derive
 * "has a password" / "connected GitHub at" without knowing the table shape.
 */
export async function getUserAccounts(
  userId: string,
): Promise<UserAccountRow[]> {
  const accountsRaw = await db.run(
    sql`select providerId, createdAt from account where userId = ${userId}`,
  );
  return (accountsRaw.results ?? []) as UserAccountRow[];
}

/**
 * Resolve a user's auth posture for the Settings → Profile page: do they have
 * a password, and is GitHub linked (with the login + when it connected)?
 *
 * Reads the void-owned `account` rows in parallel with the `userGithubAccounts`
 * mirror, then projects them through {@link projectAuthProfile} so the
 * `credential`/`github` provider-id semantics and the number-OR-ISO
 * `account.createdAt` storage quirk are resolved here rather than in the page
 * loader. Returns normalized values only: `hasPassword` and an epoch-seconds
 * `connectedAt`.
 */
export async function getUserAuthProfile(
  userId: string,
): Promise<UserAuthProfile> {
  const [accounts, githubRow] = await Promise.all([
    getUserAccounts(userId),
    db
      .select({ githubLogin: userGithubAccounts.githubLogin })
      .from(userGithubAccounts)
      .where(eq(userGithubAccounts.userId, userId))
      .limit(1),
  ]);
  return projectAuthProfile(accounts, githubRow[0]?.githubLogin ?? null);
}

// ---------- Pure helpers (unit-testable) ----------

/**
 * Coerce a void `account.createdAt` cell into epoch SECONDS (or null).
 *
 * Better Auth's account rows hand back the timestamp as either a number
 * (already epoch seconds) or an ISO string, depending on how the row was
 * written; an unparseable / absent value yields null. This is the one place
 * that knows that storage quirk.
 */
export function coerceAccountCreatedAt(
  ts: number | string | null | undefined,
): number | null {
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
  }
  return null;
}

/**
 * Project raw void `account` rows + the GitHub mirror login into a normalized
 * {@link UserAuthProfile}. Concentrates the `credential` = has-password and
 * `github` = OAuth-link provider-id semantics, plus the `createdAt` coercion.
 *
 * `githubLogin` is the value from the `userGithubAccounts` mirror (or null when
 * the mirror row is missing — it backfills on next sign-in). When a `github`
 * account row exists but the mirror is absent, `github.login` is "".
 */
export function projectAuthProfile(
  accounts: UserAccountRow[],
  githubLogin: string | null,
): UserAuthProfile {
  const hasPassword = accounts.some((a) => a.providerId === "credential");
  const githubAccountRow = accounts.find((a) => a.providerId === "github");

  let github: UserAuthProfile["github"] = null;
  if (githubAccountRow) {
    github = {
      login: githubLogin ?? "",
      connectedAt: githubLogin
        ? coerceAccountCreatedAt(githubAccountRow.createdAt)
        : null,
    };
  }
  return { hasPassword, github };
}

/**
 * Build the `or(...)` of `teamInvites` equality predicates a directed invite
 * matches an identity by. Returns `null` when the identity carries neither an
 * email nor a GitHub login (an undirected / anonymous identity), so callers
 * can short-circuit with a 403 rather than building an empty `or()`.
 *
 * Concentrates the `matchConds` assembly that three invite routes hand-wrote
 * identically — the single place that decides which invite columns an identity
 * is allowed to redeem against.
 */
export function buildInviteMatchConds(
  identity: UserIdentity,
): ReturnType<typeof or> | null {
  const conds: ReturnType<typeof eq>[] = [];
  if (identity.email) conds.push(eq(teamInvites.email, identity.email));
  if (identity.githubLogin) {
    conds.push(eq(teamInvites.githubLogin, identity.githubLogin));
  }
  if (conds.length === 0) return null;
  return or(...conds) ?? null;
}

/**
 * Whether `identity` matches an invite addressed by `inviteEmail` /
 * `inviteGithubLogin`. Mirrors the redemption gate: a directed invite is
 * redeemable when its email matches the (lowercased) identity email, or its
 * GitHub login matches.
 */
export function identityMatchesInvite(
  identity: UserIdentity,
  invite: { email: string | null; githubLogin: string | null },
): boolean {
  if (invite.email && identity.email && invite.email === identity.email) {
    return true;
  }
  if (
    invite.githubLogin &&
    identity.githubLogin &&
    invite.githubLogin === identity.githubLogin
  ) {
    return true;
  }
  return false;
}

/**
 * Classify which addressing channel a pending invite matched the identity on.
 * Used by the team picker to label "invited by email" vs "invited by GitHub".
 */
export function inviteMatchedBy(
  identity: UserIdentity,
  inviteEmail: string | null,
): "email" | "githubLogin" {
  return identity.email && inviteEmail === identity.email
    ? "email"
    : "githubLogin";
}
