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
 * Used by every redemption path (the picker's accept button AND the token
 * share-link route) so a leaked token can't be used to sneak around the
 * directed-invite gate. Pre-existing token-link invites without a directed
 * identifier short-circuit via `inviteIsDirected` before this is called.
 *
 * Resolves the caller's `{ email, githubLogin }` identity through the
 * `auth-users` seam (the single owner of the raw `"user"` read), then matches
 * with the same `email | githubLogin` rule as the rest of the redemption flow.
 */
export async function inviteMatchesUser(
  invite: InviteIdentity,
  userId: string,
): Promise<boolean> {
  const identity = await getUserIdentity(userId);
  return identityMatchesInvite(identity, invite);
}
