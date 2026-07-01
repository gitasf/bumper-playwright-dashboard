import { defineHandler, type InferProps } from "void";
import { requireAuth } from "void/auth";
import { and, db, desc, eq, gt } from "void/db";
import { memberships, teamInvites } from "@schema";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { getUsersByIds } from "@/lib/auth-users";
import { type TeamRole } from "@/lib/authz";
import { leaveTeamGuarded, removeMemberGuarded } from "@/lib/members-repo";
import { ASSIGNABLE_ROLES, ROLE_DESCRIPTIONS } from "@/lib/roles";
import { readField } from "@/lib/form";
import {
  redirectWithParam,
  requireMemberScope,
  requireRoleScope,
} from "@/lib/settings-scope";

export type Props = InferProps<typeof loader>;

const hereFor = (team: { slug: string }) =>
  `/settings/teams/${team.slug}/members`;

interface MemberRow {
  userId: string;
  role: TeamRole;
  email: string;
  name: string;
  image: string | null;
}

/**
 * Settings → Team → Members. Lists existing members and pending invites.
 *
 * Invite creation (`POST /api/teams/:teamSlug/invites`) and member-role changes
 * (`PATCH /api/teams/:teamSlug/members`, autosaved from the role `<Select>`)
 * happen via the client API. The remaining actions below are no-JS `<form>`
 * posts: revoke-invite, remove-member, and leave-team.
 */
export const loader = defineHandler(async (c) => {
  const { team } = await requireRoleScope(c, "viewSettings");
  const user = requireAuth(c);
  const membersError = new URL(c.req.url).searchParams.get("membersError");

  const [membershipRows, inviteRows] = await Promise.all([
    db
      .select({ userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.teamId, team.id)),
    db
      .select({
        id: teamInvites.id,
        role: teamInvites.role,
        createdAt: teamInvites.createdAt,
        expiresAt: teamInvites.expiresAt,
        email: teamInvites.email,
        githubLogin: teamInvites.githubLogin,
      })
      .from(teamInvites)
      .where(
        and(
          eq(teamInvites.teamId, team.id),
          gt(teamInvites.expiresAt, Math.floor(Date.now() / 1000)),
        ),
      )
      .orderBy(desc(teamInvites.createdAt)),
  ]);

  // Hydrate member profiles from the void-owned `user` table via the
  // auth-users seam (the only owner of that raw read), keyed by user id.
  // Drop memberships without a matching `user` row to preserve the original
  // INNER JOIN semantics (a missing user row should be impossible anyway).
  const profiles = await getUsersByIds(membershipRows.map((m) => m.userId));
  const members: MemberRow[] = membershipRows.flatMap((m) => {
    const profile = profiles.get(m.userId);
    if (!profile) return [];
    return [
      {
        userId: m.userId,
        role: m.role,
        email: profile.email,
        name: profile.name,
        image: profile.image,
      },
    ];
  });

  return {
    team,
    members,
    invites: inviteRows,
    currentUserId: user.id,
    membersError,
    // The role ladder + copy live in `roles.ts`; surface them so the page's
    // role selectors and the validator stay one source of truth.
    assignableRoles: ASSIGNABLE_ROLES,
    roleDescriptions: ROLE_DESCRIPTIONS,
  };
});

export const actions = {
  /** Delete a pending invite by id. Requires `manageMembers`. */
  revokeInvite: defineHandler(async (c) => {
    const { team, here } = await requireRoleScope(c, "manageMembers", hereFor);
    const redirectTo = here ?? hereFor(team);

    const form = await c.req.formData();
    const inviteId = readField(form, "inviteId").trim();
    if (!inviteId) return c.redirect(redirectTo);
    const revoked = await db
      .delete(teamInvites)
      .where(and(eq(teamInvites.id, inviteId), eq(teamInvites.teamId, team.id)))
      .returning({
        email: teamInvites.email,
        githubLogin: teamInvites.githubLogin,
        role: teamInvites.role,
      });
    // Only audit a genuine revoke — a stale/foreign inviteId matches 0 rows.
    if (revoked[0]) {
      const inv = revoked[0];
      await recordAudit(c, {
        teamId: team.id,
        action: AUDIT_ACTIONS.INVITE_REVOKE,
        targetType: "invite",
        targetId:
          inv.email ?? (inv.githubLogin ? `@${inv.githubLogin}` : inviteId),
        metadata: { role: inv.role, inviteId },
      });
    }
    return c.redirect(redirectTo);
  }),

  /**
   * Remove a member from the team. Requires `manageMembers`. Self-removal goes
   * through `leaveTeam` instead (which carries its own last-owner guard).
   *
   * The removal is itself last-owner-safe (`removeMemberGuarded`: owner-count
   * subquery in the DELETE WHERE), so even though self-removal is blocked here,
   * removing another *owner* can never strand the team ownerless — removing the
   * sole owner matches 0 rows and surfaces the inline error.
   */
  removeMember: defineHandler(async (c) => {
    const { team, here } = await requireRoleScope(c, "manageMembers", hereFor);
    const actor = requireAuth(c);
    const redirectTo = here ?? hereFor(team);

    const form = await c.req.formData();
    const userId = readField(form, "userId").trim();
    if (!userId) return c.redirect(redirectTo);
    if (userId === actor.id) {
      return redirectWithParam(
        c,
        redirectTo,
        "membersError",
        "You can't remove yourself — use Leave team instead.",
      );
    }
    const result = await removeMemberGuarded(team.id, userId);
    if (!result.ok && result.reason === "lastOwner") {
      return redirectWithParam(
        c,
        redirectTo,
        "membersError",
        "That's the team's last owner — promote someone else first.",
      );
    }
    // Audit only an actual removal (`ok`) — a vanished member or a last-owner
    // block writes no row.
    if (result.ok) {
      await recordAudit(c, {
        teamId: team.id,
        action: AUDIT_ACTIONS.MEMBER_REMOVE,
        targetType: "member",
        targetId: userId,
      });
    }
    return c.redirect(redirectTo);
  }),

  /**
   * Leave the team (any role, viewers included). The last owner can't leave —
   * a team without an owner has no one who can manage members, keys, or delete
   * it; they must delete the team (or promote someone first).
   *
   * The last-owner guard lives INSIDE the DELETE (the `notLastOwner` owner-count
   * subquery in the WHERE, verified via `.returning()`), not as a separate
   * SELECT: a check-then-delete pair would let the last two owners leave
   * concurrently — both reads see 2 owners, both deletes land, and the team is
   * permanently ownerless. With the guard in the statement, D1 serializes the
   * writes and the second delete matches 0 rows. That guarded-DELETE plumbing
   * lives behind `leaveTeamGuarded` in `members-repo` (the same home and test
   * surface as the member-role and member-remove guarded writes) rather than
   * being open-coded here.
   */
  leaveTeam: defineHandler(async (c) => {
    const { team, here } = await requireMemberScope(c, hereFor);
    const actor = requireAuth(c);

    const result = await leaveTeamGuarded(team.id, actor.id);

    if (!result.ok) {
      // The only guard that can match 0 rows for a live membership is the
      // owner-count subquery — the actor is the last owner.
      return redirectWithParam(
        c,
        here ?? "/",
        "membersError",
        "You're the last owner — delete the team instead.",
      );
    }
    // Audit the leave only when it actually happened. The membership row is
    // gone but the team (and its auditLog) survives — this is a self-removal,
    // not a team cascade — so the awaited write here is safe. The actor IS the
    // target.
    await recordAudit(c, {
      teamId: team.id,
      action: AUDIT_ACTIONS.MEMBER_LEAVE,
      targetType: "member",
      targetId: actor.id,
    });
    return c.redirect("/");
  }),
};
