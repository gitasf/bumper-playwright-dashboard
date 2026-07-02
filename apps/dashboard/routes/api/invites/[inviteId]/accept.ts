import { defineHandler } from "void";
import { requireAuth } from "void/auth";
import { acceptDirectedInvite } from "@/lib/invites";

/**
 * POST /api/invites/:inviteId/accept
 *
 * Tokenless accept for an invite addressed to the signed-in user's VERIFIED
 * EMAIL. The security binding, atomic membership write, and audit all live in
 * `acceptDirectedInvite` (`@/lib/invites`) — shared with the team picker's
 * page-level action so both redemption paths behave identically.
 *
 * GitHub-login-directed invites are intentionally NOT redeemable here — the
 * login is mutable/reusable, so a tokenless accept-by-login is an account-
 * takeover vector. Those are redeemed via the secret `/invite/:token` link.
 */
export const POST = defineHandler(async (c) => {
  const user = requireAuth(c);
  const inviteId = c.req.param("inviteId");
  if (!inviteId) return c.json({ error: "Not found" }, 404);

  const result = await acceptDirectedInvite(c, user.id, inviteId);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ ok: true, teamId: result.teamId });
});
