import { defineHandler, type InferProps } from "void";
import { getSession, requireAuth } from "void/auth";
import { getPendingInvitesForUser } from "@/lib/authz";
import { acceptDirectedInvite, declineDirectedInvite } from "@/lib/invites";

export type Props = InferProps<typeof loader>;

/**
 * Index loader. Decides where to land a signed-in user:
 *   1. Not signed in → redirect to /login.
 *   2. No pending invites + the `wf_workspace` cookie resolved to a real
 *      team/project → jump there.
 *   3. Otherwise render the team picker (with any pending invites).
 *
 * Pending invites take priority over the redirect-to-default path: a user
 * with active teams *and* a fresh invite needs the picker to accept it.
 *
 * The "where was I last" lookup runs in `middleware/01.context.ts` from the
 * cookie — `c.var.shared.selectedTeam` / `selectedProject` are already
 * membership-checked by the time this loader runs.
 */
export const loader = defineHandler(async (c) => {
  const session = getSession();
  if (!session) return c.redirect("/login");

  const shared = c.get("shared");
  const teams = shared.userTeams;
  const pendingInvites = await getPendingInvitesForUser(session.user.id);

  if (pendingInvites.length === 0) {
    const team = shared.selectedTeam;
    const project = shared.selectedProject;
    if (team && project) {
      return c.redirect(`/t/${team.slug}/p/${project.slug}`);
    }
    if (team) {
      return c.redirect(`/t/${team.slug}`);
    }
  }

  return { teams, pendingInvites };
});

/**
 * The picker's Accept / Decline buttons post here (not to the JSON
 * `/api/invites/*` routes) so a full-page form submission lands the user
 * somewhere useful instead of dumping raw `{"ok":true}` JSON in the browser.
 * Accept redirects into the joined team; both invalid/declined cases fall back
 * to the picker so the (now-consumed) invite drops off the list.
 */
export const actions = {
  accept: defineHandler(async (c) => {
    const user = requireAuth(c);
    const form = await c.req.formData();
    const inviteId = form.get("inviteId");
    if (typeof inviteId !== "string" || !inviteId) return c.redirect("/");

    const result = await acceptDirectedInvite(c, user.id, inviteId);
    if (!result.ok) return c.redirect("/");
    return c.redirect(`/t/${result.teamSlug}`);
  }),

  decline: defineHandler(async (c) => {
    const user = requireAuth(c);
    const form = await c.req.formData();
    const inviteId = form.get("inviteId");
    if (typeof inviteId === "string" && inviteId) {
      await declineDirectedInvite(user.id, inviteId);
    }
    return c.redirect("/");
  }),
};
