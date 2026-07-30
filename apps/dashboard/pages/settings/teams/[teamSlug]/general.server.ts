import { all } from "better-all";
import { defineHandler, type InferProps } from "void";
import { and, db, eq, ne, sql } from "void/db";
import { env } from "void/env";
import { logger } from "void/log";
import { githubInstallations, projects, teams as teamsTable } from "@schema";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { githubAppEnabled } from "@/lib/config";
import {
  fetchInstallationDetails,
  fetchInstallationRepositories,
} from "@/lib/github-app";
import { numericSql } from "@/lib/db/sql-ops";
import { scheduleTeamArtifactCleanup } from "@/lib/project-artifact-cleanup";
import { teardownTeamRows } from "@/lib/project-teardown";
import { logMutationFailure, mutationErrorMessage } from "@/lib/action-errors";
import { defineFlashSlots } from "@/lib/flash";
import { readField } from "@/lib/form";
import { requireOwnerScope, requireRoleScope } from "@/lib/settings-scope";
import { isValidSlug, SLUG_ERROR } from "@/lib/slug";

export type Props = InferProps<typeof loader>;

const hereFor = (team: { slug: string }) =>
  `/settings/teams/${team.slug}/general`;

/**
 * This page's form-flash slots — one declaration shared by the actions below,
 * the loader, this page's disconnect action, and the cross-route GitHub setup
 * callback (`routes/api/github/setup.ts`), so a typo'd slot is a compile error
 * rather than a silently-dropped banner.
 */
export const GENERAL_FLASH = defineFlashSlots([
  "generalError",
  "retentionError",
  "githubError",
  "dangerError",
]);

/**
 * Settings → Team → General. Identity (rename + slug) and the Danger zone
 * (delete team). Members + Projects + API keys live on sibling routes.
 */
export const loader = defineHandler(async (c) => {
  const { team } = await requireRoleScope(c, "viewSettings");

  const url = new URL(c.req.url);
  const githubEnabled = githubAppEnabled(env);

  // Three independent reads (project count, retention, GitHub installations)
  // in one parallel wave. `projectCount` is a `count(*)` (not fetching every
  // id to read `.length`) — node-postgres returns it as a string, hence
  // `numericSql`.
  const { projectCount, retentionRows, installations } = await all({
    async projectCount(): Promise<number> {
      const rows = await db
        .select({ value: numericSql(sql`count(*)`) })
        .from(projects)
        .where(eq(projects.teamId, team.id));
      return rows[0]?.value ?? 0;
    },
    async retentionRows() {
      return db
        .select({
          artifactDays: teamsTable.retentionArtifactDays,
          testResultDays: teamsTable.retentionTestResultsDays,
        })
        .from(teamsTable)
        .where(eq(teamsTable.id, team.id))
        .limit(1);
    },
    async installations() {
      return githubEnabled
        ? db
            .select({
              installationId: githubInstallations.installationId,
              accountLogin: githubInstallations.accountLogin,
            })
            .from(githubInstallations)
            .where(eq(githubInstallations.teamId, team.id))
        : [];
    },
  });
  const appSlug = env.GITHUB_APP_SLUG;
  const installUrl =
    githubEnabled && appSlug
      ? `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(team.slug)}`
      : null;

  // The DB owns only the team↔installation link. Repository membership is
  // GitHub-owned state, so resolve it live with an installation token. Isolate
  // each installation and each upstream call: a revoked/stale installation
  // must not take down General settings or hide its Disconnect control.
  const installationSettings = await Promise.all(
    installations.map(async (installation) => {
      // `viewSettings` includes normal members, but an installation can expose
      // names of private repos that have never sent a run to Wrightful. Keep
      // that broader GitHub inventory owner-only along with the controls.
      if (team.role !== "owner") {
        return {
          installationId: installation.installationId,
          accountLogin: installation.accountLogin,
          settingsUrl: null,
          repositorySelection: null,
          repositories: null,
          repositoryCount: null,
          repositoriesTruncated: false,
        };
      }

      const [details, repositoryAccess] = await Promise.all([
        fetchInstallationDetails(installation.installationId).catch((err) => {
          logger.warn("github settings: installation details failed", {
            teamId: team.id,
            installationId: installation.installationId,
            message: err instanceof Error ? err.message : String(err),
          });
          return null;
        }),
        fetchInstallationRepositories(installation.installationId).catch(
          (err) => {
            logger.warn("github settings: repository list failed", {
              teamId: team.id,
              installationId: installation.installationId,
              message: err instanceof Error ? err.message : String(err),
            });
            return null;
          },
        ),
      ]);
      const accountLogin = details?.login ?? installation.accountLogin;
      return {
        installationId: installation.installationId,
        accountLogin,
        // `html_url` is type-aware (`User` vs `Organization`). Do not guess an
        // org URL when the details request fails: that would send a valid
        // personal installation to a nonexistent settings page.
        settingsUrl: details?.settingsUrl ?? null,
        repositorySelection: details?.repositorySelection ?? null,
        repositories: repositoryAccess?.repositories ?? null,
        repositoryCount: repositoryAccess?.totalCount ?? null,
        repositoriesTruncated: repositoryAccess?.truncated ?? false,
      };
    }),
  );
  installationSettings.sort((a, b) =>
    a.accountLogin.localeCompare(b.accountLogin),
  );

  return {
    team,
    projectCount,
    retention: {
      artifactDays: retentionRows[0]?.artifactDays ?? null,
      testResultDays: retentionRows[0]?.testResultDays ?? null,
      defaultArtifactDays: env.WRIGHTFUL_RETENTION_ARTIFACT_DAYS,
      defaultTestResultDays: env.WRIGHTFUL_RETENTION_TEST_RESULTS_DAYS,
    },
    github: {
      enabled: githubEnabled,
      installations: installationSettings,
      installUrl,
    },
    ...GENERAL_FLASH.read(url),
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
      return GENERAL_FLASH.fail(c, here, "generalError", "Name is required.");
    }
    if (!isValidSlug(slug)) {
      return GENERAL_FLASH.fail(c, here, "generalError", SLUG_ERROR);
    }

    if (slug !== team.slug) {
      const clash = await db
        .select({ id: teamsTable.id })
        .from(teamsTable)
        .where(and(eq(teamsTable.slug, slug), ne(teamsTable.id, team.id)))
        .limit(1);
      if (clash[0]) {
        return GENERAL_FLASH.fail(
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
      return GENERAL_FLASH.fail(c, here, "generalError", friendly);
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
      return GENERAL_FLASH.fail(
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
      return GENERAL_FLASH.fail(
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
      logMutationFailure("update retention failed", err, { teamId: team.id });
      return GENERAL_FLASH.fail(
        c,
        here,
        "retentionError",
        "Could not save retention settings.",
      );
    }

    return c.redirect(here);
  }),

  /** Disconnect one GitHub App installation from this team (owner-only). */
  disconnectGithub: defineHandler(async (c) => {
    const { team, here } = await requireOwnerScope(c, hereFor);
    const form = await c.req.formData();
    const installationId = Number(readField(form, "installationId"));
    if (!Number.isInteger(installationId) || installationId <= 0) {
      return GENERAL_FLASH.fail(
        c,
        here,
        "githubError",
        "Could not identify that GitHub organization.",
      );
    }

    // Scope the lookup and delete to this team. An attacker-supplied id for a
    // different tenant is indistinguishable from a missing row and can never
    // disconnect the other team's installation.
    const rows = await db
      .select({ accountLogin: githubInstallations.accountLogin })
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.teamId, team.id),
          eq(githubInstallations.installationId, installationId),
        ),
      )
      .limit(1);
    const installation = rows[0];
    if (!installation) {
      return GENERAL_FLASH.fail(
        c,
        here,
        "githubError",
        "That GitHub organization is no longer connected.",
      );
    }

    try {
      await db
        .delete(githubInstallations)
        .where(
          and(
            eq(githubInstallations.teamId, team.id),
            eq(githubInstallations.installationId, installationId),
          ),
        );
    } catch (err) {
      logMutationFailure("disconnect github installation failed", err, {
        teamId: team.id,
        installationId,
      });
      return GENERAL_FLASH.fail(
        c,
        here,
        "githubError",
        "Could not disconnect the GitHub organization. Please try again.",
      );
    }

    // This link has no dependent audit row that would cascade on delete, so
    // record the event only after the mutation lands. A failed delete must not
    // leave behind an audit entry claiming the installation was disconnected.
    await recordAudit(c, {
      teamId: team.id,
      action: AUDIT_ACTIONS.GITHUB_INSTALLATION_DISCONNECT,
      targetType: "github_installation",
      targetId: installation.accountLogin,
      metadata: { installationId },
    });

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
      return GENERAL_FLASH.fail(
        c,
        here,
        "dangerError",
        `Confirmation did not match. Type "${team.slug}" exactly to delete the team.`,
      );
    }

    // The R2 cleanup outbox rows have no team/project FK so they survive this
    // transaction. Lock the team parent before taking the project snapshot:
    // project inserts acquire a key-share lock through their FK, so once this
    // lock lands no project can appear between the snapshot and teardown.
    // Enqueuing that locked snapshot in the same transaction means a committed
    // delete cannot lose the only durable pointer to any project prefix.
    let deletedProjectIds: string[];
    try {
      deletedProjectIds = await teardownTeamRows(team.id);
    } catch (err) {
      logMutationFailure("delete team failed", err, { teamId: team.id });
      return GENERAL_FLASH.fail(
        c,
        here,
        "dangerError",
        "Could not delete team — please try again.",
      );
    }

    // Start one bounded pass eagerly after commit. Fan-out across a large
    // team's projects can exceed the Worker R2 subrequest budget; every
    // untouched outbox job remains immediately due for the cron.
    scheduleTeamArtifactCleanup(c, deletedProjectIds);

    return c.redirect("/settings/profile");
  }),
};
