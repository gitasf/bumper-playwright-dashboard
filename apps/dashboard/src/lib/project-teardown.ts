import type { Context } from "hono";
import { and, db, eq } from "void/db";
import { logger } from "void/log";
import { projects } from "@schema";
import { deleteProjectArtifactObjects } from "@/lib/artifacts/store";

/**
 * Schedule the best-effort R2 byte sweep for a project whose rows are already
 * (durably) gone. Runs via `waitUntil` so the sweep (up to ~200 R2 subrequests)
 * never blocks the redirect; a failure never resurrects the project — it is
 * logged and dropped (the orphaned objects are unreferenced and unguessable).
 *
 * The genuinely-shared half of "destroy a project": the project-delete action
 * and the team-delete action's per-project loop both reclaim R2 bytes this
 * exact way. Call it ONLY after the project's rows are committed-gone — never
 * speculatively, so a failed row delete can't strand bytes (and so a team-delete
 * can keep its row deletion atomic and sweep only on the success path).
 */
export function scheduleProjectArtifactCleanup(
  c: Context,
  teamId: string,
  projectId: string,
): void {
  c.executionCtx.waitUntil(
    deleteProjectArtifactObjects(teamId, projectId).catch((err: unknown) => {
      logger.error("project artifact R2 sweep failed", {
        projectId,
        message: err instanceof Error ? err.message : String(err),
      });
    }),
  );
}

/**
 * Destroy ONE project: delete its row, then reclaim its R2 artifact bytes. The
 * single-project teardown the project-delete action (`keys.server.ts`) uses.
 *
 * Deletes only the `projects` row: every project-scoped child (apiKeys, runs,
 * testResults, testResultAttempts, testTags, testAnnotations, artifacts,
 * monitors, …) has an `onDelete: "cascade"` FK to `projects.id`, so the single
 * delete reclaims all dependent rows (which is why the old explicit
 * `db.delete(apiKeys)` was redundant). (`auditLog.projectId` is `set null`, so
 * an audit row survives the cascade with a null projectId — see `db/schema.ts`.)
 *
 * The row delete is AWAITED and may throw — the caller decides how to surface a
 * DB failure (the settings action redirects back with an inline error). The R2
 * sweep is scheduled only AFTER the delete resolves, via
 * {@link scheduleProjectArtifactCleanup}.
 *
 * The team-delete action does NOT use this — it deletes all of a team's project
 * rows in one atomic `runBatch` (so the whole-team teardown stays all-or-nothing)
 * and calls {@link scheduleProjectArtifactCleanup} per project on the success
 * path. Forcing that path through this per-project helper would have traded the
 * atomic batch for a partially-committable loop.
 */
export async function teardownProject(
  c: Context,
  teamId: string,
  projectId: string,
): Promise<void> {
  await db
    .delete(projects)
    .where(and(eq(projects.id, projectId), eq(projects.teamId, teamId)));
  scheduleProjectArtifactCleanup(c, teamId, projectId);
}
