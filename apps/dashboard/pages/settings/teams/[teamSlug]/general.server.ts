import { defineHandler, type InferProps } from "void";
import { and, db, eq, ne } from "void/db";
import { env } from "void/env";
import {
  githubInstallations,
  memberships,
  projects,
  teamInvites,
  teams as teamsTable,
} from "@schema";
import { logger } from "void/log";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { githubAppEnabled } from "@/lib/config";
import { runBatch } from "@/lib/db-batch";
import { scheduleProjectArtifactCleanup } from "@/lib/project-teardown";
import { mutationErrorMessage } from "@/lib/action-errors";
import { readField } from "@/lib/form";
import {
  redirectWithParam,
  requireOwnerScope,
  requireRoleScope,
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
  const { team } = await requireRoleScope(c, "viewSettings");

  const url = new URL(c.req.url);

  const projectCountRows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.teamId, team.id));

  const retentionRows = await db
    .select({
      artifactDays: teamsTable.retentionArtifactDays,
      testResultDays: teamsTable.retentionTestResultsDays,
    })
    .from(teamsTable)
    .where(eq(teamsTable.id, team.id))
    .limit(1);

  const githubEnabled = githubAppEnabled(env);
  const installations = githubEnabled
    ? await db
        .select({ accountLogin: githubInstallations.accountLogin })
        .from(githubInstallations)
        .where(eq(githubInstallations.teamId, team.id))
    : [];
  const appSlug = env.GITHUB_APP_SLUG;
  const installUrl =
    githubEnabled && appSlug
      ? `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(team.slug)}`
      : null;

  return {
    team,
    projectCount: projectCountRows.length,
    retention: {
      artifactDays: retentionRows[0]?.artifactDays ?? null,
      testResultDays: retentionRows[0]?.testResultDays ?? null,
      defaultArtifactDays: env.WRIGHTFUL_RETENTION_ARTIFACT_DAYS,
      defaultTestResultDays: env.WRIGHTFUL_RETENTION_TEST_RESULTS_DAYS,
    },
    github: {
      enabled: githubEnabled,
      installations: installations.map((i) => i.accountLogin),
      installUrl,
    },
    generalError: url.searchParams.get("generalError"),
    retentionError: url.searchParams.get("retentionError"),
    githubError: url.searchParams.get("githubError"),
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

    // Audit the rename only after it lands (best-effort). Capture the before/
    // after identity so the diff is legible in the log.
    await recordAudit(c, {
      teamId: team.id,
      action: AUDIT_ACTIONS.TEAM_RENAME,
      targetType: "team",
      targetId: slug,
      metadata: {
        fromName: team.name,
        toName: name,
        fromSlug: team.slug,
        toSlug: slug,
      },
    });

    return c.redirect(`/settings/teams/${slug}/general`);
  }),

  /**
   * Set the team's two-axis data-retention windows (in days). Either field may
   * be left blank to inherit the deployment default. The artifact window must
   * stay ≤ the testResults window so an expiring testResult's FK cascade never
   * orphans live R2 objects.
   */
  updateRetention: defineHandler(async (c) => {
    const { team, here } = await requireOwnerScope(c, hereFor);
    const form = await c.req.formData();

    const parseDays = (raw: string): number | null | "invalid" => {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < 1) return "invalid";
      return n;
    };

    const artifactDays = parseDays(readField(form, "artifactDays"));
    const testResultDays = parseDays(readField(form, "testResultDays"));

    if (artifactDays === "invalid" || testResultDays === "invalid") {
      return redirectWithParam(
        c,
        here,
        "retentionError",
        "Retention windows must be whole numbers of days (1 or more), or blank to use the default.",
      );
    }

    const effectiveArtifact =
      artifactDays ?? env.WRIGHTFUL_RETENTION_ARTIFACT_DAYS;
    const effectiveTestResult =
      testResultDays ?? env.WRIGHTFUL_RETENTION_TEST_RESULTS_DAYS;
    if (effectiveArtifact > effectiveTestResult) {
      return redirectWithParam(
        c,
        here,
        "retentionError",
        "The artifact window must be less than or equal to the test-results window.",
      );
    }

    try {
      await db
        .update(teamsTable)
        .set({
          retentionArtifactDays: artifactDays,
          retentionTestResultsDays: testResultDays,
        })
        .where(eq(teamsTable.id, team.id));
    } catch (err) {
      logger.error("update retention failed", {
        teamId: team.id,
        message: err instanceof Error ? err.message : String(err),
      });
      return redirectWithParam(
        c,
        here,
        "retentionError",
        "Could not save retention settings.",
      );
    }

    return c.redirect(here);
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

    // Record the audit row SYNCHRONOUSLY *before* the delete batch (roadmap
    // 3.2). The audit log is team-scoped, so `auditLog.teamId` cascades and this
    // row dies with the team — an accepted, documented choice (no one can read a
    // dead team's log). Recording it here, awaited, still captures the actor +
    // confirmation context before the cascade and keeps workerd from dropping a
    // post-response write.
    await recordAudit(c, {
      teamId: team.id,
      action: AUDIT_ACTIONS.TEAM_DELETE,
      targetType: "team",
      targetId: team.slug,
      metadata: { teamName: team.name, projectCount: projectIds.length },
    });

    // One atomic batch — all-or-nothing, so a mid-teardown failure can't leave a
    // half-deleted team (the guarantee `db-batch.ts` documents). Deleting the
    // project rows cascades every project-scoped child (apiKeys, runs,
    // testResults, …) via their `onDelete: "cascade"` FKs, so the old explicit
    // `db.delete(apiKeys)` is redundant and dropped.
    try {
      await runBatch((tx) => [
        tx.delete(projects).where(eq(projects.teamId, team.id)),
        tx.delete(memberships).where(eq(memberships.teamId, team.id)),
        tx.delete(teamInvites).where(eq(teamInvites.teamId, team.id)),
        tx.delete(teamsTable).where(eq(teamsTable.id, team.id)),
      ]);
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

    // Best-effort R2 byte cleanup per project, AFTER the atomic row deletion
    // succeeded — the shared `scheduleProjectArtifactCleanup` (also used by the
    // single-project delete) so the sweep pattern lives in one place.
    for (const projectId of projectIds) {
      scheduleProjectArtifactCleanup(c, team.id, projectId);
    }

    return c.redirect("/settings/profile");
  }),
};
