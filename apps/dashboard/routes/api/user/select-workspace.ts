import { defineHandler } from "void";
import { requireAuth } from "void/auth";
import { resolveProjectBySlugs, resolveTeamBySlug } from "@/lib/authz";
import { readField } from "@/lib/form";
import { setWorkspaceCookie } from "@/lib/workspace-cookie";

/**
 * POST /api/user/select-workspace
 *
 * Update the `wf_workspace` cookie without forcing a tenant-page navigation.
 * Called by the sidebar workspace switcher when the user changes team/project
 * while on a non-tenant page (e.g. /settings/profile) — we want to stay on
 * the current page but record the new selection.
 *
 * Membership is re-verified here even though the switcher only shows teams +
 * projects the user can see; the middleware does the same check on every
 * subsequent request, but blocking unauthorized writes at the source keeps
 * the cookie clean.
 */
export const POST = defineHandler(async (c) => {
  const user = requireAuth(c);
  const form = await c.req.formData();
  const teamSlug = readField(form, "teamSlug").trim();
  const projectSlugRaw = readField(form, "projectSlug").trim();
  const projectSlug = projectSlugRaw === "" ? null : projectSlugRaw;

  if (!teamSlug) {
    return c.json({ error: "teamSlug required" }, 400);
  }

  const team = await resolveTeamBySlug(user.id, teamSlug);
  if (!team) {
    return c.json({ error: "Not found" }, 404);
  }

  if (projectSlug) {
    const project = await resolveProjectBySlugs(user.id, teamSlug, projectSlug);
    if (!project) {
      return c.json({ error: "Not found" }, 404);
    }
  }

  setWorkspaceCookie(c, teamSlug, projectSlug);
  return c.body(null, 204);
});
