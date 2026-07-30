import type { Context } from "hono";
import { and, db, eq } from "void/db";
import { auditLog, projectArtifactCleanupJobs, projects, teams } from "@schema";
import { buildAuditRow, type RecordAuditInput } from "@/lib/audit";
import {
  projectArtifactCleanupJobValues,
  scheduleProjectArtifactCleanup,
} from "@/lib/project-artifact-cleanup";
import { lockTeamForChildMutation, lockTeamForDeletion } from "@/lib/team-lock";

/**
 * Atomically delete a team and enqueue cleanup for every project present at the
 * deletion boundary. Locking the team row first serializes against child
 * project inserts through their FK key-share lock, so the selected project set
 * cannot become stale before the delete.
 *
 * Returns the committed project ids so the request can dispatch eager cleanup
 * passes after the transaction. The outbox rows remain the durable retry seam.
 */
export async function teardownTeamRows(
  teamId: string,
  clock: () => number = () => Math.floor(Date.now() / 1000),
): Promise<string[]> {
  return db.transaction(async (tx) => {
    if (!(await lockTeamForDeletion(tx, teamId))) return [];
    // This timestamp is the capability cutoff, not merely request start time.
    // The parent lock conflicts with direct-PUT presigning, so sampling only
    // after it lands guarantees every URL that escaped was minted no later
    // than the cleanup job's baseline.
    const cleanupCreatedAt = clock();

    const currentProjects = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.teamId, teamId));
    const projectIds = currentProjects.map((row) => row.id);
    if (projectIds.length > 0) {
      await tx
        .insert(projectArtifactCleanupJobs)
        .values(
          projectIds.map((projectId) =>
            projectArtifactCleanupJobValues(
              teamId,
              projectId,
              cleanupCreatedAt,
            ),
          ),
        )
        .onConflictDoNothing();
    }

    // Every team-owned application row has an FK cascade from teams.id.
    // Deleting only the parent keeps the transaction's lock footprint small
    // and avoids redundant child deletes acquiring locks in a second order.
    await tx.delete(teams).where(eq(teams.id, teamId));
    return projectIds;
  });
}

/**
 * Destroy ONE project and transactionally enqueue reclamation of its R2 bytes.
 * The single-project teardown the project-delete action (`keys.server.ts`) uses.
 *
 * Deletes only the `projects` row: every project-scoped child (apiKeys, runs,
 * testResults, testResultAttempts, testTags, testAnnotations, artifacts,
 * monitors, …) has an `onDelete: "cascade"` FK to `projects.id`, so the single
 * delete reclaims all dependent rows (which is why the old explicit
 * `db.delete(apiKeys)` was redundant). (`auditLog.projectId` is `set null`, so
 * an audit row survives the cascade with a null projectId — see `db/schema.ts`.)
 *
 * The row delete and cleanup outbox insert are one transaction. The caller
 * decides how to surface a DB failure. Once committed, an eager `waitUntil`
 * starts cleanup; the cron-owned outbox row retries failures and bounded passes.
 *
 * The team-delete action does NOT use this per-project helper. It uses
 * {@link teardownTeamRows} to lock the parent, snapshot every current project,
 * enqueue every cleanup job, and delete all team-owned rows in one transaction.
 * Forcing that path through this helper would trade an all-or-nothing teardown
 * for a partially-committable loop.
 */
export async function teardownProject(
  c: Context,
  teamId: string,
  projectId: string,
  audit?: { actorUserId: string; input: RecordAuditInput },
): Promise<boolean> {
  const deleted = await db.transaction(async (tx) => {
    if (!(await lockTeamForChildMutation(tx, teamId))) return false;
    const rows = await tx
      .delete(projects)
      .where(and(eq(projects.id, projectId), eq(projects.teamId, teamId)))
      .returning({ id: projects.id });
    if (rows.length === 0) return false;
    // DELETE's project-row lock conflicts with direct-PUT presigning. Sampling
    // after it succeeds makes the outbox baseline no earlier than the latest
    // capability which could have escaped for this project.
    const cleanupCreatedAt = Math.floor(Date.now() / 1000);
    if (audit) {
      // The project row is already gone inside this transaction, so persist the
      // deletion event with its intentionally-null FK. Human identity remains
      // in targetId/metadata.
      await tx.insert(auditLog).values(
        buildAuditRow(audit.actorUserId, {
          ...audit.input,
          teamId,
          projectId: null,
        }),
      );
    }
    await tx
      .insert(projectArtifactCleanupJobs)
      .values(
        projectArtifactCleanupJobValues(teamId, projectId, cleanupCreatedAt),
      )
      .onConflictDoNothing();
    return true;
  });
  if (deleted) scheduleProjectArtifactCleanup(c, projectId);
  return deleted;
}
