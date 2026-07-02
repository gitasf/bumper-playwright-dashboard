import { defineHandler } from "void";
import { requireAuth } from "void/auth";
import { declineDirectedInvite } from "@/lib/invites";

/**
 * POST /api/invites/:inviteId/decline
 *
 * Soft-decline by deleting the invite. The caller must be the invite's
 * intended recipient — the match binding lives in `declineDirectedInvite`
 * (`@/lib/invites`), shared with the team picker's page-level action. Without
 * it any signed-in user could enumerate invite ids and burn other users'
 * invites. GitHub-login-directed invites aren't declinable here for the same
 * reason they aren't acceptable here — they're handled via `/invite/:token`.
 */
export const POST = defineHandler(async (c) => {
  const user = requireAuth(c);
  const inviteId = c.req.param("inviteId");
  if (!inviteId) return c.json({ error: "Not found" }, 404);

  const result = await declineDirectedInvite(user.id, inviteId);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ ok: true });
});
