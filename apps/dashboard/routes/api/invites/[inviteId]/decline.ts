import { defineHandler } from "void";
import { requireAuth } from "void/auth";
import { and, db, eq } from "void/db";
import { teamInvites } from "@schema";
import { buildInviteMatchConds, getUserIdentity } from "@/lib/auth-users";

/**
 * POST /api/invites/:inviteId/decline
 *
 * Soft-decline by deleting the invite. The caller must be the invite's
 * intended recipient — matched by email (from void's user table) or by the
 * GitHub login captured at OAuth sign-in. Without this binding any signed-in
 * user could enumerate invite ids and burn other users' invites.
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
  // Drizzle/D1 returns a meta object; treat 0 affected rows as a 404 so a
  // caller probing for invite ids can't distinguish "exists but not yours"
  // from "doesn't exist".
  const meta = (result as { meta?: { changes?: number } }).meta;
  if (meta && typeof meta.changes === "number" && meta.changes === 0) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ ok: true });
});
