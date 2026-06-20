import { db, eq, inArray, or } from "void/db";
import { getUser } from "void/auth";
import { memberships, teamInvites, userGithubAccounts } from "@schema";
import { authAccount, authUser } from "../../db/better-auth-tables";

/**
 * The single home for reads against the **void-owned** Better Auth tables
 * (`user`, `account`) plus the parallel `userGithubAccounts` mirror.
 *
 * Better Auth's core tables are intentionally NOT declared in `db/schema.ts`
 * (the app's migration source) — Better Auth owns + migrates them, and the two
 * migration runners must not fight over their shape. To read them with the
 * typed, auto-quoting Drizzle query builder anyway, `db/better-auth-tables.ts`
 * declares query-only table objects (`authUser` / `authAccount`) that are NOT in
 * the migration source. That replaces the hand-typed raw SQL this file used to
 * carry, which kept re-introducing Postgres dialect bugs (unquoted camelCase
 * identifiers, `timestamptz`→Date coercion drift).
 *
 * The CURRENT user's identity comes from `void/auth`'s `getUser()` (no DB read);
 * these reads cover what `getUser()` can't — arbitrary users (`getUsersByIds`)
 * and a user's `account` rows (`getUserAccounts`). Email lowercasing for
 * invite-matching is concentrated here so no caller forgets it (a missing
 * `.toLowerCase()` is an invite-hijack vector).
 *
 * NOTE: the *write* side of `userGithubAccounts` (mirroring the GitHub login
 * captured at OAuth sign-in) lives in `@/lib/github-account-mirror`, invoked
 * from `auth.ts`'s Better Auth database hook. It is separate because `auth.ts`
 * is loaded at `void prepare` config time (before the runtime db/schema
 * bindings exist), so the capture-and-upsert uses dynamic imports.
 */

/** The directed-invite identity resolved for a signed-in user. */
export interface UserIdentity {
  /**
   * Lowercased `user.email` when the account's email is VERIFIED, else null.
   * Unverified emails are self-asserted and must never match a directed
   * invite — see `getUserIdentity`.
   */
  email: string | null;
  /** The GitHub login captured at OAuth sign-in, or null. */
  githubLogin: string | null;
}

/** Shape of a single row from the void-owned `account` table. */
export interface UserAccountRow {
  providerId: string;
  /** `account.createdAt` is a Postgres `timestamptz` — node-postgres returns a `Date`. */
  createdAt: Date | null;
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
 * **Only a VERIFIED email is an identity.** An unverified `user.email` is a
 * self-asserted string: with signup open, anyone can register an account
 * claiming `victim@corp.com` (no verification email is sent — none is wired
 * up) and would otherwise see and redeem the victim's directed invites. GitHub
 * OAuth users get `emailVerified` from GitHub's verified-email flag, so the
 * OAuth invite flow keeps matching; unverified password accounts fall back to
 * the GitHub-login channel or an undirected token link. When an email sender +
 * verification ships, password accounts regain email matching automatically.
 *
 * Used by every invite-redemption path (team-picker pending invites, the
 * token share-link gate, and the accept / decline routes).
 */
export async function getUserIdentity(userId: string): Promise<UserIdentity> {
  // The identity belongs to the CURRENT signed-in user — every caller threads
  // the session user's id (the team picker, the token gate, the accept/decline
  // routes). So read email + verified flag from void/auth's `getUser()` (the
  // canonical API) rather than a raw read of the void-owned `"user"` table.
  // Guard on id so a mismatched/absent session can never assert ANOTHER user's
  // email — a directed-invite hijack vector. Only a VERIFIED email is an
  // identity (an unverified, self-asserted email must not match an invite).
  const user = getUser();
  const githubRow = await db
    .select({ githubLogin: userGithubAccounts.githubLogin })
    .from(userGithubAccounts)
    .where(eq(userGithubAccounts.userId, userId))
    .limit(1);
  return {
    email:
      user && user.id === userId && user.emailVerified
        ? user.email.toLowerCase()
        : null,
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

  // Typed query-builder read of the void-owned `user` table (Drizzle quotes the
  // identifiers + binds each id). Team-member counts are far under Postgres's
  // 65535-param ceiling, so a single `in (…)` query needs no chunking.
  const rows = await db
    .select({
      id: authUser.id,
      email: authUser.email,
      name: authUser.name,
      image: authUser.image,
    })
    .from(authUser)
    .where(inArray(authUser.id, ids));
  for (const r of rows) {
    out.set(r.id, { email: r.email, name: r.name, image: r.image });
  }
  return out;
}

/** A team member with their resolved profile. */
export interface TeamMember {
  userId: string;
  name: string;
  email: string;
}

/**
 * List a team's members with their profiles (`memberships ⋈ user`), via the
 * same raw-`user`-read seam (`getUsersByIds`) the members settings page uses.
 * Members whose `user` row is missing are dropped (matches INNER JOIN
 * semantics). Used by the alert-recipient picker, the groups settings page, and
 * monitor alert resolution. Sorted by name for stable picker rendering.
 */
export async function listTeamMembers(teamId: string): Promise<TeamMember[]> {
  const rows = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(eq(memberships.teamId, teamId));
  const profiles = await getUsersByIds(rows.map((r) => r.userId));
  return rows
    .flatMap((r) => {
      const profile = profiles.get(r.userId);
      return profile
        ? [{ userId: r.userId, name: profile.name, email: profile.email }]
        : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Read the void-owned `account` rows for a user (one per linked provider —
 * `credential` for email+password, `github` for OAuth) so callers can derive
 * "has a password" / "connected GitHub at" without knowing the table shape.
 */
export async function getUserAccounts(
  userId: string,
): Promise<UserAccountRow[]> {
  // Typed query-builder read — Drizzle quotes the camelCase identifiers and
  // maps `createdAt` (timestamptz) to a Date (coerced to epoch downstream).
  return db
    .select({
      providerId: authAccount.providerId,
      createdAt: authAccount.createdAt,
    })
    .from(authAccount)
    .where(eq(authAccount.userId, userId));
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
 * `account.createdAt` is a Postgres `timestamptz`, so node-postgres hands it
 * back as a `Date` (the raw `runRows` path bypasses Drizzle's decoders). This
 * is the one place that converts it to the epoch-seconds the profile API
 * exposes. (Pre-Postgres this juggled a number-or-ISO-string D1 quirk; the
 * column is a real timestamp now, so a `Date` is the only shape.)
 */
export function coerceAccountCreatedAt(
  ts: Date | null | undefined,
): number | null {
  return ts instanceof Date ? Math.floor(ts.getTime() / 1000) : null;
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
 * Build the match predicate the **tokenless** invite paths use — team-picker
 * discovery (`getPendingInvitesForUser`) and the picker's accept / decline
 * routes, none of which require the secret invite token. Returns `null` when
 * the identity carries no VERIFIED email, so callers short-circuit with a 403
 * rather than building an empty `or()`.
 *
 * SECURITY: this matches ONLY on the verified email — never the GitHub login.
 * A GitHub login is mutable and reusable: once `@alice` renames or deletes her
 * account GitHub frees the handle, and whoever re-registers it would otherwise
 * see and redeem alice's directed invite straight from the team picker with no
 * token at all (a confirmed account-takeover-into-team primitive). A verified
 * email cannot be taken over that way. GitHub-directed invites remain
 * redeemable via the secret share-link, where {@link identityMatchesInvite}
 * uses the login only as a SECOND factor behind the unguessable token — see
 * `invite-identity.ts`. Keep these two helpers intentionally asymmetric: the
 * tokenless path trusts only the non-takeover-able email; the token path may
 * additionally check the login. Do NOT "re-unify" them.
 */
export function buildInviteMatchConds(
  identity: UserIdentity,
): ReturnType<typeof or> | null {
  if (!identity.email) return null;
  return or(eq(teamInvites.email, identity.email)) ?? null;
}

/**
 * Whether `identity` matches a directed invite by its email or GitHub login.
 *
 * This is the **token-link** second factor (`invite-identity.ts` →
 * `/invite/:token`): the unguessable token is the primary gate, and this match
 * additionally confirms a leaked link isn't redeemed by the wrong person.
 * Because the secret token already bounds who can reach this check, it is safe
 * to accept the mutable GitHub login here — unlike the tokenless
 * {@link buildInviteMatchConds}, which must not (see its note).
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
