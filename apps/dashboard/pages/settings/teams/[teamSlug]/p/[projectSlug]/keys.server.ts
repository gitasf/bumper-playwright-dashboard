import { defineHandler, type InferProps } from "void";
import { and, db, desc, eq, isNull, ne } from "void/db";
import { apiKeys, projects, type ApiKey } from "@schema";
import { readField } from "@/lib/form";
import { runBatch } from "@/lib/db-batch";
import {
  redirectWithParam,
  requireOwnedProjectScope,
} from "@/lib/settings-scope";
import { logger } from "void/log";
import { isValidSlug, SLUG_ERROR } from "@/lib/slug";
import { mutationErrorMessage } from "@/lib/action-errors";

export type Props = InferProps<typeof loader>;

const hereFor = (project: { teamSlug: string; slug: string }) =>
  `/settings/teams/${project.teamSlug}/p/${project.slug}/keys`;

/**
 * Settings → Project keys loader. Owner-only. Returns the project's keys list
 * and any per-section error messages stashed on a redirect.
 *
 * Minting a key happens via `POST /api/teams/:teamSlug/p/:projectSlug/keys`
 * (client-side fetch). The plaintext token comes back in that response and
 * the client surfaces it once in a modal — no flash cookie, no full reload.
 */
export const loader = defineHandler(async (c) => {
  const { project } = await requireOwnedProjectScope(c, hereFor);

  const url = new URL(c.req.url);
  const generalError = url.searchParams.get("generalError");
  const dangerError = url.searchParams.get("dangerError");

  const keys = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.projectId, project.id))
    .orderBy(desc(apiKeys.createdAt));

  return {
    project: {
      id: project.id,
      teamId: project.teamId,
      slug: project.slug,
      name: project.name,
      teamSlug: project.teamSlug,
    },
    keys: keys as ApiKey[],
    generalError,
    dangerError,
  };
});

/**
 * Settings → Project keys mutations. Mint-key is client-side via `/api/teams/.../keys`.
 * The remaining server actions handle slow-path / no-JS flows for revoke key,
 * rename / re-slug, and project delete.
 */
export const actions = {
  /** Flip `revokedAt` on a non-revoked key. Idempotent. */
  revokeKey: defineHandler(async (c) => {
    const { project, here } = await requireOwnedProjectScope(c, hereFor);

    const form = await c.req.formData();
    const keyId = readField(form, "keyId");
    if (!keyId) return c.redirect(here);
    await db
      .update(apiKeys)
      .set({ revokedAt: Math.floor(Date.now() / 1000) })
      .where(
        and(
          eq(apiKeys.id, keyId),
          eq(apiKeys.projectId, project.id),
          isNull(apiKeys.revokedAt),
        ),
      );
    return c.redirect(here);
  }),

  /** Rename project or change slug. */
  updateGeneral: defineHandler(async (c) => {
    const { project, here } = await requireOwnedProjectScope(c, hereFor);

    const form = await c.req.formData();
    const name = readField(form, "name").trim();
    const slug = readField(form, "slug").trim().toLowerCase();

    if (!name) {
      return redirectWithParam(c, here, "generalError", "Name is required.");
    }
    if (!isValidSlug(slug)) {
      return redirectWithParam(c, here, "generalError", SLUG_ERROR);
    }

    if (slug !== project.slug) {
      const clash = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.teamId, project.teamId),
            eq(projects.slug, slug),
            ne(projects.id, project.id),
          ),
        )
        .limit(1);
      if (clash[0]) {
        return redirectWithParam(
          c,
          here,
          "generalError",
          "That slug is already used by another project in this team.",
        );
      }
    }

    try {
      await db
        .update(projects)
        .set({ name, slug })
        .where(eq(projects.id, project.id));
    } catch (err) {
      const friendly = mutationErrorMessage(err, {
        context: "update project failed",
        uniqueMessage:
          "That slug is already used by another project in this team.",
        genericMessage: "Could not save changes.",
      });
      return redirectWithParam(c, here, "generalError", friendly);
    }

    return c.redirect(`/settings/teams/${project.teamSlug}/p/${slug}/keys`);
  }),

  /** Delete project + its keys. */
  deleteProject: defineHandler(async (c) => {
    const { project, here } = await requireOwnedProjectScope(c, hereFor);

    const form = await c.req.formData();
    const confirm = readField(form, "confirm").trim();
    if (confirm !== project.slug) {
      return redirectWithParam(
        c,
        here,
        "dangerError",
        `Confirmation did not match. Type "${project.slug}" exactly to delete the project.`,
      );
    }

    try {
      await runBatch([
        db.delete(apiKeys).where(eq(apiKeys.projectId, project.id)),
        db.delete(projects).where(eq(projects.id, project.id)),
      ]);
    } catch (err) {
      logger.error("delete project failed", {
        projectId: project.id,
        message: err instanceof Error ? err.message : String(err),
      });
      return redirectWithParam(
        c,
        here,
        "dangerError",
        "Could not delete project — please try again.",
      );
    }

    return c.redirect(`/settings/teams/${project.teamSlug}`);
  }),
};
