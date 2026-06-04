import { defineHandler } from "void";
import { requireAuth } from "void/auth";
import { and, db, eq, gt } from "void/db";
import { ulid } from "ulid";
import { memberships, teamInvites } from "@schema";
import { buildInviteMatchConds, getUserIdentity } from "@/lib/auth-users";
import { runBatch } from "@/lib/db-batch";

/**
 * POST /api/invites/:inviteId/accept
 *
 * Resolve a directed invite (email or github login) addressed to the signed-in
 * user, create the membership row, and delete the invite. Same row counts as
 * a transaction via `db.batch` so we don't end up with a membership without
 * the invite being consumed (or vice versa).
 */
export const POST = defineHandler(async (c) => {
  const user = requireAuth(c);
  const inviteId = c.req.param("inviteId");
  if (!inviteId) return c.json({ error: "Not found" }, 404);

  // Resolve the user's `{ email, githubLogin }` identity (raw `"user"` read +
  // github mirror live behind the auth-users seam) and build the invite match
  // predicate from it so a leaked invite id can't be accepted by the wrong
  // account.
  const identity = await getUserIdentity(user.id);
  const matchConds = buildInviteMatchConds(identity);
  if (!matchConds) {
    return c.json({ error: "Invite not addressed to this account" }, 403);
  }

  const now = Math.floor(Date.now() / 1000);
  const rows = await db
    .select({
      id: teamInvites.id,
      teamId: teamInvites.teamId,
      role: teamInvites.role,
    })
    .from(teamInvites)
    .where(
      and(
        eq(teamInvites.id, inviteId),
        gt(teamInvites.expiresAt, now),
        matchConds,
      ),
    )
    .limit(1);
  const invite = rows[0];
  if (!invite) {
    return c.json({ error: "Invite not found or expired" }, 404);
  }

  // Idempotent on re-accept: a second invite to the same team (or a previous
  // acceptance via the page-level handler) leaves the user already a member.
  // Consume the invite without re-inserting to avoid a unique-constraint 500.
  const existing = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, user.id),
        eq(memberships.teamId, invite.teamId),
      ),
    )
    .limit(1);
  if (existing[0]) {
    await db.delete(teamInvites).where(eq(teamInvites.id, invite.id));
    return c.json({ ok: true, teamId: invite.teamId });
  }

  await runBatch([
    db.insert(memberships).values({
      id: ulid(),
      userId: user.id,
      teamId: invite.teamId,
      role: invite.role,
      createdAt: now,
    }),
    db.delete(teamInvites).where(eq(teamInvites.id, invite.id)),
  ]);

  return c.json({ ok: true, teamId: invite.teamId });
});
