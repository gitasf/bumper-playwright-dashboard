import { defineHandler, type InferProps } from "void";
import { db, desc, eq } from "void/db";
import { projects } from "@schema";
import { requireMemberScope } from "@/lib/settings-scope";

export type Props = InferProps<typeof loader>;

/**
 * Settings → Team → Projects. Lists the team's projects; navigation only —
 * the create-project action lives at `./projects/new`, key management on
 * `./p/[projectSlug]/keys`.
 */
export const loader = defineHandler(async (c) => {
  const { team } = await requireMemberScope(c);

  const projectRows = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .where(eq(projects.teamId, team.id))
    .orderBy(desc(projects.createdAt));

  return {
    team,
    projects: projectRows,
  };
});
