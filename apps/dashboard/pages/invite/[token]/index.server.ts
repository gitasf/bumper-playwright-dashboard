import { defineHandler, type InferProps } from "void";
import { getSession, requireAuth } from "void/auth";
import { and, db, eq, gt } from "void/db";
import { ulid } from "ulid";
import { memberships, teamInvites, teams, type MembershipRole } from "@schema";
import { runBatch } from "@/lib/db-batch";
import { inviteIsDirected, inviteMatchesUser } from "@/lib/invite-identity";
import { hashInviteToken } from "@/lib/invite-tokens";

const DIRECTED_MISMATCH_ERROR =
  "This invite is addressed to someone else. Sign in with the invited account or ask the team owner for a fresh link.";

interface ResolvedInvite {
  id: string;
  teamId: string;
  role: MembershipRole;
  email: string | null;
  githubLogin: string | null;
  teamSlug: string;
  teamName: string;
}

async function lookupInvite(token: string): Promise<ResolvedInvite | null> {
  const tokenHash = await hashInviteToken(token);
  const now = Math.floor(Date.now() / 1000);
  const rows = await db
    .select({
      id: teamInvites.id,
      teamId: teamInvites.teamId,
      role: teamInvites.role,
      email: teamInvites.email,
      githubLogin: teamInvites.githubLogin,
      teamSlug: teams.slug,
      teamName: teams.name,
    })
    .from(teamInvites)
    .innerJoin(teams, eq(teams.id, teamInvites.teamId))
    .where(
      and(eq(teamInvites.tokenHash, tokenHash), gt(teamInvites.expiresAt, now)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export type Props = InferProps<typeof loader>;

/**
 * Invite landing loader. Returns one of four states the UI knows how to
 * render. We never 404 on a bad token: an explicit "Invite not valid" panel
 * is more useful than dropping the user on a generic error page.
 */
export const loader = defineHandler(async (c) => {
  const session = getSession();
  if (!session) {
    return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`);
  }
  const token = c.req.param("token");
  if (!token) {
    return {
      kind: "invalid" as const,
      message: "Missing invite token.",
    };
  }
  const url = new URL(c.req.url);
  const error = url.searchParams.get("error");

  const invite = await lookupInvite(token);
  if (!invite) {
    return {
      kind: "invalid" as const,
      message:
        error ??
        "This invite link is no longer active. Ask the team owner for a fresh link.",
    };
  }

  if (
    inviteIsDirected(invite) &&
    !(await inviteMatchesUser(invite, session.user.id))
  ) {
    return {
      kind: "directed_mismatch" as const,
      message: DIRECTED_MISMATCH_ERROR,
    };
  }

  const existing = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, session.user.id),
        eq(memberships.teamId, invite.teamId),
      ),
    )
    .limit(1);
  if (existing[0]) {
    return {
      kind: "already_member" as const,
      invite: { teamSlug: invite.teamSlug, teamName: invite.teamName },
    };
  }

  return {
    kind: "joinable" as const,
    invite: {
      id: invite.id,
      teamSlug: invite.teamSlug,
      teamName: invite.teamName,
      role: invite.role,
    },
    error,
  };
});

/**
 * Form POST: accept the invite. Creates the membership row + deletes the
 * invite atomically via `db.batch` so we never end up with a half-applied
 * state. Mirrors the rwsdk version's transactional semantics.
 */
export const action = defineHandler(async (c) => {
  const user = requireAuth(c);
  const token = c.req.param("token");
  if (!token) throw new Response("Not Found", { status: 404 });
  const here = `/invite/${token}`;

  const invite = await lookupInvite(token);
  if (!invite) {
    return c.redirect(
      `${here}?error=${encodeURIComponent(
        "This invite is no longer valid. Ask the team owner for a fresh link.",
      )}`,
    );
  }

  if (inviteIsDirected(invite) && !(await inviteMatchesUser(invite, user.id))) {
    return c.redirect(
      `${here}?error=${encodeURIComponent(DIRECTED_MISMATCH_ERROR)}`,
    );
  }

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
    // Already a member — don't burn the invite, just redirect.
    return c.redirect(`/t/${invite.teamSlug}`);
  }

  try {
    await runBatch([
      db.insert(memberships).values({
        id: ulid(),
        userId: user.id,
        teamId: invite.teamId,
        role: invite.role,
        createdAt: Math.floor(Date.now() / 1000),
      }),
      db.delete(teamInvites).where(eq(teamInvites.id, invite.id)),
    ]);
  } catch {
    return c.redirect(
      `${here}?error=${encodeURIComponent(
        "Could not join the team — please try again.",
      )}`,
    );
  }

  return c.redirect(`/t/${invite.teamSlug}`);
});
