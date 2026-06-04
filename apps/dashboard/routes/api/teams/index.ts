import { defineHandler } from "void";
import { requireAuth } from "void/auth";
import { readBodyField } from "@/lib/form";
import { mutationErrorMessage } from "@/lib/action-errors";
import { createTeamForUser, SlugDerivationError } from "@/lib/provisioning";

/**
 * POST /api/teams
 *
 * Auth'd. Creates a team + owner membership for the signed-in user and returns
 * `{ teamSlug }`. The JSON sibling of the `pages/settings/teams/new` form
 * action — both delegate to the shared `createTeamForUser` provisioning seam,
 * so out-of-process bootstrap callers (the local seeder, the e2e dashboard
 * fixture) consume a stable typed contract instead of scraping the form
 * action's 302 `Location` header for the assigned slug.
 */
export const POST = defineHandler(async (c) => {
  const user = requireAuth(c);

  const name = await readBodyField(c, { jsonKey: "name", formKey: "name" });
  if (!name) {
    return c.json({ error: "Name is required." }, 400);
  }

  try {
    const { slug } = await createTeamForUser(user.id, name);
    return c.json({ teamSlug: slug });
  } catch (err) {
    if (err instanceof SlugDerivationError) {
      return c.json({ error: err.message }, 400);
    }
    const friendly = mutationErrorMessage(err, {
      context: "create team failed",
      uniqueMessage: "Could not create team — please try again.",
      genericMessage: "Could not create team.",
    });
    return c.json({ error: friendly }, 500);
  }
});
