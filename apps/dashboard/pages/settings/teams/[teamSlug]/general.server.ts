import { defineHandler, type InferProps } from "void";
import { and, db, eq, inArray, ne } from "void/db";
import {
  apiKeys,
  memberships,
  projects,
  teamInvites,
  teams as teamsTable,
} from "@schema";
import { logger } from "void/log";
import { runBatch } from "@/lib/db-batch";
import { mutationErrorMessage } from "@/lib/action-errors";
import { readField } from "@/lib/form";
import {
  redirectWithParam,
  requireMemberScope,
  requireOwnerScope,
} from "@/lib/settings-scope";
import { isValidSlug, SLUG_ERROR } from "@/lib/slug";

export type Props = InferProps<typeof loader>;

const hereFor = (team: { slug: string }) =>
  `/settings/teams/${team.slug}/general`;

/**
 * Settings → Team → General. Identity (rename + slug) and the Danger zone
 * (delete team). Members + Projects + API keys live on sibling routes.
 */
export const loader = defineHandler(async (c) => {
  const { team } = await requireMemberScope(c);

  const url = new URL(c.req.url);

  const projectCountRows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.teamId, team.id));

  return {
    team,
    projectCount: projectCountRows.length,
    generalError: url.searchParams.get("generalError"),
    dangerError: url.searchParams.get("dangerError"),
  };
});

export const actions = {
  /** Rename the team and/or change its URL slug. Redirects to new slug on success. */
  updateGeneral: defineHandler(async (c) => {
    const { team, here } = await requireOwnerScope(c, hereFor);

    const form = await c.req.formData();
    const name = readField(form, "name").trim();
    const slug = readField(form, "slug").trim().toLowerCase();

    if (!name) {
      return redirectWithParam(c, here, "generalError", "Name is required.");
    }
    if (!isValidSlug(slug)) {
      return redirectWithParam(c, here, "generalError", SLUG_ERROR);
    }

    if (slug !== team.slug) {
      const clash = await db
        .select({ id: teamsTable.id })
        .from(teamsTable)
        .where(and(eq(teamsTable.slug, slug), ne(teamsTable.id, team.id)))
        .limit(1);
      if (clash[0]) {
        return redirectWithParam(
          c,
          here,
          "generalError",
          "That slug is already taken.",
        );
      }
    }

    try {
      await db
        .update(teamsTable)
        .set({ name, slug })
        .where(eq(teamsTable.id, team.id));
    } catch (err) {
      const friendly = mutationErrorMessage(err, {
        context: "update team failed",
        uniqueMessage: "That slug is already taken.",
        genericMessage: "Could not save changes.",
      });
      return redirectWithParam(c, here, "generalError", friendly);
    }

    return c.redirect(`/settings/teams/${slug}/general`);
  }),

  /**
   * Permanently delete the team + all dependent rows. The form makes the
   * user type the team's slug as a confirmation gate.
   */
  deleteTeam: defineHandler(async (c) => {
    const { team, here } = await requireOwnerScope(c, hereFor);

    const form = await c.req.formData();
    const confirm = readField(form, "confirm").trim();
    if (confirm !== team.slug) {
      return redirectWithParam(
        c,
        here,
        "dangerError",
        `Confirmation did not match. Type "${team.slug}" exactly to delete the team.`,
      );
    }

    const teamProjects = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.teamId, team.id));
    const projectIds = teamProjects.map((r) => r.id);

    const ops: PromiseLike<unknown>[] = [];
    if (projectIds.length > 0) {
      ops.push(
        db.delete(apiKeys).where(inArray(apiKeys.projectId, projectIds)),
      );
    }
    ops.push(
      db.delete(projects).where(eq(projects.teamId, team.id)),
      db.delete(memberships).where(eq(memberships.teamId, team.id)),
      db.delete(teamInvites).where(eq(teamInvites.teamId, team.id)),
      db.delete(teamsTable).where(eq(teamsTable.id, team.id)),
    );

    try {
      await runBatch(ops);
    } catch (err) {
      logger.error("delete team failed", {
        teamId: team.id,
        message: err instanceof Error ? err.message : String(err),
      });
      return redirectWithParam(
        c,
        here,
        "dangerError",
        "Could not delete team — please try again.",
      );
    }

    return c.redirect("/settings/profile");
  }),
};
