import { defineHandler } from "void";
import { requireAuth } from "void/auth";
import { and, db, eq } from "void/db";
import { teamInvites } from "@schema";
import { buildInviteMatchConds, getUserIdentity } from "@/lib/auth-users";
import { changedRows } from "@/lib/db-batch";

/**
 * POST /api/invites/:inviteId/decline
 *
 * Soft-decline by deleting the invite. The caller must be the invite's
 * intended recipient — matched by VERIFIED email (`buildInviteMatchConds`).
 * Without this binding any signed-in user could enumerate invite ids and burn
 * other users' invites. GitHub-login-directed invites aren't declinable here
 * for the same reason they aren't acceptable here (the login is mutable; see
 * auth-users.ts) — they're redeemed/ignored via the `/invite/:token` link.
 *
 * We don't keep a "declined" tombstone because directed invites are
 * re-issuable — an admin who wants the user back can just send a fresh one.
 */
export const POST = defineHandler(async (c) => {
  const user = requireAuth(c);
  const inviteId = c.req.param("inviteId");
  if (!inviteId) return c.json({ error: "Not found" }, 404);

  const identity = await getUserIdentity(user.id);
  const matchConds = buildInviteMatchConds(identity);
  if (!matchConds) {
    return c.json({ error: "Invite not addressed to this account" }, 403);
  }

  const result = await db
    .delete(teamInvites)
    .where(and(eq(teamInvites.id, inviteId), matchConds));
  // Treat 0 affected rows as a 404 so a caller probing for invite ids can't
  // distinguish "exists but not yours" from "doesn't exist". `changedRows`
  // reads the affected count (node-postgres `rowCount` in prod, pglite
  // `affectedRows` in the test lane) — without it, the count read 0 and this
  // 404 probe-guard would silently never fire.
  if (changedRows(result) === 0) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ ok: true });
});
