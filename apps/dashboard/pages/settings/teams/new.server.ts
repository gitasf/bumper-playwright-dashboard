import { defineHandler, type InferProps } from "void";
import { requireAuth } from "void/auth";
import { mutationErrorMessage } from "@/lib/action-errors";
import { readField } from "@/lib/form";
import { createTeamForUser, SlugDerivationError } from "@/lib/provisioning";

export type Props = InferProps<typeof loader>;

/**
 * Settings → New team loader. Renders the create-team form. Errors are
 * carried over from the action via the `?error=...` query string (same
 * convention used by the legacy rwsdk page so the wire shape doesn't shift).
 */
export const loader = defineHandler(async (c) => {
  requireAuth(c);
  const error = new URL(c.req.url).searchParams.get("error");
  return { error };
});

/**
 * Settings → New team action. Delegates the slug-pick + atomic
 * team+owner-membership insert to the shared `createTeamForUser` provisioning
 * seam (also called by `POST /api/teams`), then redirects to the team's detail
 * page. This handler owns only the form-decode + error-to-`?error=` mapping:
 * an unusable name surfaces the SlugDerivationError message, DB errors round
 * through `mutationErrorMessage` so the form re-renders with a message.
 */
export const action = defineHandler(async (c) => {
  const user = requireAuth(c);

  const form = await c.req.formData();
  const name = readField(form, "name").trim();
  const formUrl = "/settings/teams/new";

  if (!name) {
    return c.redirect(
      `${formUrl}?error=${encodeURIComponent("Name is required.")}`,
    );
  }

  let slug: string;
  try {
    ({ slug } = await createTeamForUser(user.id, name));
  } catch (err) {
    if (err instanceof SlugDerivationError) {
      return c.redirect(`${formUrl}?error=${encodeURIComponent(err.message)}`);
    }
    const friendly = mutationErrorMessage(err, {
      context: "create team failed",
      uniqueMessage: "Could not create team — please try again.",
      genericMessage: "Could not create team.",
    });
    return c.redirect(`${formUrl}?error=${encodeURIComponent(friendly)}`);
  }

  return c.redirect(`/settings/teams/${slug}`);
});
