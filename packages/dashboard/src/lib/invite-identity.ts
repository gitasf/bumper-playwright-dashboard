import { getControlDb } from "@/control";

export type InviteIdentity = {
  email: string | null;
  githubLogin: string | null;
};

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
 */
export async function inviteMatchesUser(
  invite: InviteIdentity,
  userId: string,
): Promise<boolean> {
  const db = getControlDb();
  if (invite.email) {
    const userRow = await db
      .selectFrom("user")
      .select("email")
      .where("id", "=", userId)
      .limit(1)
      .executeTakeFirst();
    if (userRow?.email && userRow.email.toLowerCase() === invite.email) {
      return true;
    }
  }
  if (invite.githubLogin) {
    const accountRow = await db
      .selectFrom("account")
      .select("githubLogin")
      .where("userId", "=", userId)
      .where("providerId", "=", "github")
      .limit(1)
      .executeTakeFirst();
    if (accountRow?.githubLogin === invite.githubLogin) return true;
  }
  return false;
}
