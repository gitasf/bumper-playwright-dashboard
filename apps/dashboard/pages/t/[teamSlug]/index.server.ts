import { defineHandler, type InferProps } from "void";
import { getSession } from "void/auth";
import { asc, db, eq } from "void/db";
import { projects } from "@schema";

export type Props = InferProps<typeof loader>;

/**
 * Team root. If the user lands here with at least one project, jump to the
 * first one — that's the natural "show me runs" landing. Otherwise render
 * the empty-state picker that points at /settings/.../projects/new.
 *
 * Team membership + the team/project scaffolding are already resolved for
 * this exact URL by `middleware/01.context.ts` (`resolveTenantBundleForUser`
 * keyed on the `/t/:teamSlug` path segment, not the `wf_workspace` cookie) —
 * reuse `c.get("shared")` instead of re-querying `resolveTeamBySlug`.
 * `shared.teamProjects` (`{ slug, name }`, no `id`) can rule out the
 * zero-projects case for free, but can't reproduce the `asc(projects.id)`
 * "first created project" ordering, so the ordered lookup still runs a query
 * when the team has at least one project.
 */
export const loader = defineHandler(async (c) => {
  const session = getSession();
  if (!session) return c.redirect("/login");
  const teamSlug = c.req.param("teamSlug");
  if (!teamSlug) throw new Response("Not Found", { status: 404 });

  const shared = c.get("shared");
  const team = shared.selectedTeam;
  if (!team || team.slug !== teamSlug) {
    throw new Response("Not Found", { status: 404 });
  }

  if (shared.teamProjects.length === 0) {
    return { team };
  }

  const firstProject = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.teamId, team.id))
    .orderBy(asc(projects.id))
    .limit(1);

  if (firstProject[0]) {
    return c.redirect(`/t/${team.slug}/p/${firstProject[0].slug}`);
  }

  return { team };
});
