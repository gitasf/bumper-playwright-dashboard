import { defineHandler, type InferProps } from "void";
import { mutationErrorMessage } from "@/lib/action-errors";
import { readField } from "@/lib/form";
import { createProjectAudited, SlugDerivationError } from "@/lib/provisioning";
import { requireOwnerScope } from "@/lib/settings-scope";

export type Props = InferProps<typeof loader>;

const hereFor = (team: { slug: string }) =>
  `/settings/teams/${team.slug}/projects/new`;

/**
 * Settings → New project loader. Owner-only. The page only renders a single
 * form, so the loader's only job is verifying access + carrying flash error
 * state forward via `?error=...`.
 */
export const loader = defineHandler(async (c) => {
  const { team } = await requireOwnerScope(c, hereFor);
  const error = new URL(c.req.url).searchParams.get("error");
  return { team, error };
});

/**
 * Settings → New project action. Owner-only. Delegates the slug-pick + insert
 * + PROJECT_CREATE audit row to the shared `createProjectAudited` provisioning
 * seam (also called by `POST /api/teams/:teamSlug/projects`); uniqueness is
 * scoped to the team (the schema enforces `(teamId, slug)` uniqueness). This
 * handler owns only the form-decode + error-to-`?error=` mapping.
 */
export const action = defineHandler(async (c) => {
  const { team, here: formUrl } = await requireOwnerScope(c, hereFor);

  const form = await c.req.formData();
  const name = readField(form, "name").trim();

  if (!name) {
    return c.redirect(
      `${formUrl}?error=${encodeURIComponent("Name is required.")}`,
    );
  }

  try {
    await createProjectAudited(c, team.id, name);
  } catch (err) {
    if (err instanceof SlugDerivationError) {
      return c.redirect(`${formUrl}?error=${encodeURIComponent(err.message)}`);
    }
    const friendly = mutationErrorMessage(err, {
      context: "create project failed",
      uniqueMessage: "Could not create project — please try again.",
      genericMessage: "Could not create project.",
    });
    return c.redirect(`${formUrl}?error=${encodeURIComponent(friendly)}`);
  }

  return c.redirect(`/settings/teams/${team.slug}`);
});
