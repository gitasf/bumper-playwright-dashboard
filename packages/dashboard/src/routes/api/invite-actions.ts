import { ulid } from "ulid";
import { getControlDb, batchControl } from "@/control";
import { inviteMatchesUser } from "@/lib/invite-identity";
import type { AppContext } from "@/worker";

type HandlerArgs = {
  request: Request;
  ctx: AppContext;
  params: Record<string, string>;
};

/**
 * Accept an invite addressed directly to this user (by email or GitHub
 * login). The caller's identity must match the invite — we don't trust the
 * id alone, so a leaked id can't be used to claim someone else's invite.
 *
 * Idempotent: already-a-member clears the now-redundant invite and
 * redirects. Directed invites are identity-bound, so leaving them around
 * just makes them keep reappearing on the team picker.
 */
export async function acceptInviteByIdHandler({
  request,
  ctx,
  params,
}: HandlerArgs) {
  if (!ctx.user) return new Response(null, { status: 401 });
  const inviteId = params.inviteId;
  if (!inviteId) return new Response("Bad request", { status: 400 });

  const origin = new URL(request.url).origin;
  const db = getControlDb();
  const now = Math.floor(Date.now() / 1000);

  const invite = await db
    .selectFrom("teamInvites")
    .innerJoin("teams", "teams.id", "teamInvites.teamId")
    .select([
      "teamInvites.id as id",
      "teamInvites.teamId as teamId",
      "teamInvites.role as role",
      "teamInvites.email as email",
      "teamInvites.githubLogin as githubLogin",
      "teamInvites.expiresAt as expiresAt",
      "teams.slug as teamSlug",
    ])
    .where("teamInvites.id", "=", inviteId)
    .where("teamInvites.expiresAt", ">", now)
    .limit(1)
    .executeTakeFirst();

  if (!invite) return new Response("Not found", { status: 404 });
  if (!(await inviteMatchesUser(invite, ctx.user.id))) {
    return new Response("Forbidden", { status: 403 });
  }

  const existing = await db
    .selectFrom("memberships")
    .select("id")
    .where("userId", "=", ctx.user.id)
    .where("teamId", "=", invite.teamId)
    .limit(1)
    .executeTakeFirst();

  if (existing) {
    await db.deleteFrom("teamInvites").where("id", "=", invite.id).execute();
    return Response.redirect(`${origin}/t/${invite.teamSlug}`, 303);
  }

  await batchControl([
    db.insertInto("memberships").values({
      id: ulid(),
      userId: ctx.user.id,
      teamId: invite.teamId,
      role: invite.role,
      createdAt: now,
    }),
    db.deleteFrom("teamInvites").where("id", "=", invite.id),
  ]);

  return Response.redirect(`${origin}/t/${invite.teamSlug}`, 303);
}

/**
 * Decline a directed invite. Same identity check as accept — only the
 * invitee can dismiss it (the team owner can revoke separately from
 * settings). Soft-no-op if the invite is already gone.
 */
export async function declineInviteByIdHandler({
  request,
  ctx,
  params,
}: HandlerArgs) {
  if (!ctx.user) return new Response(null, { status: 401 });
  const inviteId = params.inviteId;
  if (!inviteId) return new Response("Bad request", { status: 400 });

  const db = getControlDb();
  const invite = await db
    .selectFrom("teamInvites")
    .select(["id", "email", "githubLogin"])
    .where("id", "=", inviteId)
    .limit(1)
    .executeTakeFirst();

  if (invite) {
    if (!(await inviteMatchesUser(invite, ctx.user.id))) {
      return new Response("Forbidden", { status: 403 });
    }
    await db.deleteFrom("teamInvites").where("id", "=", invite.id).execute();
  }

  return redirectOr204(request);
}

/**
 * fetch() callers don't set a Referer (by default) or accept navigational
 * redirects: 204 keeps them simple. Browser form POSTs do set a Referer;
 * redirect back so the page updates.
 */
function redirectOr204(request: Request): Response {
  const referer = request.headers.get("referer");
  if (!referer) return new Response(null, { status: 204 });
  try {
    const refUrl = new URL(referer);
    const reqUrl = new URL(request.url);
    if (refUrl.origin !== reqUrl.origin) {
      return new Response(null, { status: 204 });
    }
    return Response.redirect(referer, 303);
  } catch {
    return new Response(null, { status: 204 });
  }
}
