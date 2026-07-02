import type { Context } from "hono";
import { and, db, eq, gt } from "void/db";
import { ulid } from "ulid";
import { memberships, teamInvites, teams } from "@schema";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { buildInviteMatchConds, getUserIdentity } from "@/lib/auth-users";
import { changedRows, runBatch } from "@/lib/db-batch";

/**
 * Shared accept/decline core for tokenless (directed-invite) redemption.
 *
 * Both the JSON API routes (`/api/invites/:id/{accept,decline}`) and the team
 * picker's page-level actions run through these so the security binding
 * (`buildInviteMatchConds` — an invite can only be redeemed by the account it's
 * addressed to), the atomic membership+invite write, and the audit record live
 * in exactly ONE place. Callers decide how to surface the result: the API
 * returns JSON, the picker redirects.
 *
 * GitHub-login-directed invites are intentionally NOT redeemable here — see
 * `buildInviteMatchConds` in auth-users.ts. They go through `/invite/:token`.
 */

export type AcceptInviteResult =
  | { ok: true; teamId: string; teamSlug: string }
  | { ok: false; status: 403 | 404; error: string };

export async function acceptDirectedInvite(
  c: Context,
  userId: string,
  inviteId: string,
): Promise<AcceptInviteResult> {
  const identity = await getUserIdentity(userId);
  const matchConds = buildInviteMatchConds(identity);
  if (!matchConds) {
    return {
      ok: false,
      status: 403,
      error: "Invite not addressed to this account",
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const rows = await db
    .select({
      id: teamInvites.id,
      teamId: teamInvites.teamId,
      role: teamInvites.role,
      teamSlug: teams.slug,
    })
    .from(teamInvites)
    .innerJoin(teams, eq(teams.id, teamInvites.teamId))
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
    return { ok: false, status: 404, error: "Invite not found or expired" };
  }

  // Idempotent on re-accept: a second invite to the same team (or a previous
  // acceptance via the page-level handler) leaves the user already a member.
  // Consume the invite without re-inserting to avoid a unique-constraint 500.
  const existing = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.teamId, invite.teamId),
      ),
    )
    .limit(1);
  if (existing[0]) {
    await db.delete(teamInvites).where(eq(teamInvites.id, invite.id));
    return { ok: true, teamId: invite.teamId, teamSlug: invite.teamSlug };
  }

  await runBatch((tx) => [
    tx.insert(memberships).values({
      id: ulid(),
      userId,
      teamId: invite.teamId,
      role: invite.role,
      createdAt: now,
    }),
    tx.delete(teamInvites).where(eq(teamInvites.id, invite.id)),
  ]);

  // Audit the genuine join only (the idempotent re-accept branch above creates
  // no membership). The actor IS the invitee; record the role they joined as.
  await recordAudit(c, {
    teamId: invite.teamId,
    action: AUDIT_ACTIONS.INVITE_ACCEPT,
    targetType: "member",
    targetId: userId,
    metadata: { role: invite.role, inviteId: invite.id },
  });

  return { ok: true, teamId: invite.teamId, teamSlug: invite.teamSlug };
}

export type DeclineInviteResult =
  | { ok: true }
  | { ok: false; status: 403 | 404; error: string };

export async function declineDirectedInvite(
  userId: string,
  inviteId: string,
): Promise<DeclineInviteResult> {
  const identity = await getUserIdentity(userId);
  const matchConds = buildInviteMatchConds(identity);
  if (!matchConds) {
    return {
      ok: false,
      status: 403,
      error: "Invite not addressed to this account",
    };
  }

  const result = await db
    .delete(teamInvites)
    .where(and(eq(teamInvites.id, inviteId), matchConds));
  // Treat 0 affected rows as a 404 so a caller probing for invite ids can't
  // distinguish "exists but not yours" from "doesn't exist".
  if (changedRows(result) === 0) {
    return { ok: false, status: 404, error: "Not found" };
  }
  return { ok: true };
}
