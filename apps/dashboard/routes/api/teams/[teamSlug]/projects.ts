import { defineHandler } from "void";
import { AuthzError, resolveOwnedTeam } from "@/lib/settings-scope";
import { readBodyField } from "@/lib/form";
import { mutationErrorMessage } from "@/lib/action-errors";
import { createProjectAudited, SlugDerivationError } from "@/lib/provisioning";

/**
 * POST /api/teams/:teamSlug/projects
 *
 * Owner-only. Creates a project within the team named by the route and returns
 * `{ projectSlug }`. The JSON sibling of the `.../projects/new` form action —
 * both delegate to the shared `createProjectAudited` provisioning seam (create
 * + PROJECT_CREATE audit row), so bootstrap callers consume a typed contract
 * instead of comparing the form action's success/error 302 `Location` paths.
 */
export const POST = defineHandler(async (c) => {
  let team: Awaited<ReturnType<typeof resolveOwnedTeam>>;
  try {
    team = await resolveOwnedTeam(c);
  } catch (err) {
    if (err instanceof AuthzError) return c.json({ error: "Forbidden" }, 403);
    throw err;
  }

  const name = await readBodyField(c, { jsonKey: "name", formKey: "name" });
  if (!name) {
    return c.json({ error: "Name is required." }, 400);
  }

  try {
    const { slug } = await createProjectAudited(c, team.id, name);
    return c.json({ projectSlug: slug });
  } catch (err) {
    if (err instanceof SlugDerivationError) {
      return c.json({ error: err.message }, 400);
    }
    const friendly = mutationErrorMessage(err, {
      context: "create project failed",
      uniqueMessage: "Could not create project — please try again.",
      genericMessage: "Could not create project.",
    });
    return c.json({ error: friendly }, 500);
  }
});
