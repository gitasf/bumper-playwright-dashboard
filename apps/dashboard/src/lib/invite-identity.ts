import { getUserIdentity, identityMatchesInvite } from "@/lib/auth-users";

export interface InviteIdentity {
  email: string | null;
  githubLogin: string | null;
}

/**
 * A "directed" invite is addressed to a specific person — either an email
 * address or a GitHub login captured at OAuth sign-in. Token-link invites
 * (no identifier set) remain redeemable by anyone with the token.
 */
export function inviteIsDirected(invite: InviteIdentity): boolean {
  return Boolean(invite.email) || Boolean(invite.githubLogin);
}

/**
 * Confirm the caller's identity matches the invite's email or GitHub login.
 *
 * Used by the **token share-link** route only (`/invite/:token`) so a leaked
 * token can't be redeemed by the wrong person. Pre-existing token-link invites
 * without a directed identifier short-circuit via `inviteIsDirected` before
 * this is called. The tokenless picker / accept / decline paths deliberately do
 * NOT call this — they go through `buildInviteMatchConds`, which trusts only
 * the verified email (the GitHub login is mutable; see its note in
 * `auth-users.ts`). Because the unguessable token already gates this path, it
 * is safe to accept the GitHub login as a second factor here.
 *
 * Resolves the caller's `{ email, githubLogin }` identity through the
 * `auth-users` seam (the single owner of the raw `"user"` read), then matches
 * via {@link identityMatchesInvite}.
 */
export async function inviteMatchesUser(
  invite: InviteIdentity,
  userId: string,
): Promise<boolean> {
  const identity = await getUserIdentity(userId);
  return identityMatchesInvite(identity, invite);
}
