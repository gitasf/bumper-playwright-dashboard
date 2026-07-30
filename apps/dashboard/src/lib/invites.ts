import type { Context } from "hono";
import { and, db, eq, gt, inArray, lt } from "void/db";
import { ulid } from "ulid";
import { memberships, teamInvites, teams } from "@schema";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { buildInviteMatchConds, getUserIdentity } from "@/lib/auth-users";
import { changedRows, isUniqueViolation } from "@/lib/db/batch";
import { lockTeamForChildMutation } from "@/lib/team-lock";

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

/**
 * Consume a token-link invite and grant its membership in one transaction.
 * DELETE … RETURNING is the single-use latch: only the transaction that removes
 * the still-unexpired row may insert a membership.
 */
export async function consumeTokenInvite(
  userId: string,
  inviteId: string,
  now: number,
): Promise<{ teamId: string; role: string } | null> {
  return db.transaction(async (tx) => {
    // Resolve the parent without locking the child, then take the canonical
    // parent lock before DELETE locks the invite. A concurrent consumer may
    // win between these reads; DELETE ... RETURNING remains the single-use
    // latch below.
    const candidates = await tx
      .select({ teamId: teamInvites.teamId })
      .from(teamInvites)
      .where(and(eq(teamInvites.id, inviteId), gt(teamInvites.expiresAt, now)))
      .limit(1);
    const candidate = candidates[0];
    if (!candidate || !(await lockTeamForChildMutation(tx, candidate.teamId))) {
      return null;
    }
    const consumed = await tx
      .delete(teamInvites)
      .where(
        and(
          eq(teamInvites.id, inviteId),
          eq(teamInvites.teamId, candidate.teamId),
          gt(teamInvites.expiresAt, now),
        ),
      )
      .returning({
        teamId: teamInvites.teamId,
        role: teamInvites.role,
      });
    const invite = consumed[0];
    if (!invite) return null;
    await tx.insert(memberships).values({
      id: ulid(),
      userId,
      teamId: invite.teamId,
      role: invite.role,
      createdAt: now,
    });
    return invite;
  });
}

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
  // The transaction below revalidates the invite before granting membership.
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

  let joined: { teamId: string; role: string } | null = null;
  try {
    joined = await db.transaction(async (tx) => {
      if (!(await lockTeamForChildMutation(tx, invite.teamId))) return null;
      const consumed = await tx
        .delete(teamInvites)
        .where(
          and(
            eq(teamInvites.id, inviteId),
            eq(teamInvites.teamId, invite.teamId),
            gt(teamInvites.expiresAt, now),
            matchConds,
          ),
        )
        .returning({
          teamId: teamInvites.teamId,
          role: teamInvites.role,
        });
      const row = consumed[0];
      if (!row) return null;
      await tx.insert(memberships).values({
        id: ulid(),
        userId,
        teamId: row.teamId,
        role: row.role,
        createdAt: now,
      });
      return { teamId: row.teamId, role: row.role };
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Already a member, so the accept is idempotent — retire the now-redundant
    // invite. A lost parent lock means teardown removed the team, cascading
    // both that membership and this invite, so report the same gone outcome as
    // a missing invite instead of a success carrying the dead team's slug.
    const teamSurvived = await db.transaction(async (tx) => {
      if (!(await lockTeamForChildMutation(tx, invite.teamId))) return false;
      await tx
        .delete(teamInvites)
        .where(
          and(
            eq(teamInvites.id, inviteId),
            eq(teamInvites.teamId, invite.teamId),
            matchConds,
          ),
        );
      return true;
    });
    if (!teamSurvived) {
      return { ok: false, status: 404, error: "Invite not found or expired" };
    }
    return { ok: true, teamId: invite.teamId, teamSlug: invite.teamSlug };
  }

  if (!joined) {
    return { ok: false, status: 404, error: "Invite not found or expired" };
  }

  await recordAudit(c, {
    teamId: joined.teamId,
    action: AUDIT_ACTIONS.INVITE_ACCEPT,
    targetType: "member",
    targetId: userId,
    metadata: { role: joined.role, inviteId: invite.id },
  });

  return { ok: true, teamId: joined.teamId, teamSlug: invite.teamSlug };
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

/** Maximum expired invites deleted by one sweep chunk. */
export const EXPIRED_INVITE_SWEEP_BATCH_SIZE = 500;

/** Delete one bounded chunk of expired invites. */
export async function sweepExpiredInvites(
  now: number,
  limit: number = EXPIRED_INVITE_SWEEP_BATCH_SIZE,
): Promise<number> {
  const doomed = db
    .select({ id: teamInvites.id })
    .from(teamInvites)
    .where(lt(teamInvites.expiresAt, now))
    .limit(limit);
  const result = await db
    .delete(teamInvites)
    .where(inArray(teamInvites.id, doomed));
  return changedRows(result);
}
