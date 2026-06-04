import { defineHandler } from "void";
import { and, db, eq } from "void/db";
import { runs, testResults } from "@schema";
import { resolveTenantApiScope } from "@/lib/tenant-api-scope";

export type TestResultSummaryResponse = {
  id: string;
  runId: string;
  status: string;
  durationMs: number;
  retryCount: number;
  title: string;
  file: string;
  projectName: string | null;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  actor: string | null;
  createdAt: number;
};

/**
 * GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/tests/:testResultId/summary
 *
 * Test-scoped companion to `summary.get.ts`. Used by the history-chart
 * hovercard on the Test Detail page, where the bar represents a single
 * `testResult` occurrence rather than a whole run.
 */
export const GET = defineHandler(async (c) => {
  const ctx = await resolveTenantApiScope(c, { requireTestResultId: true });
  if (ctx instanceof Response) return ctx;
  const { scope, runId, testResultId } = ctx;

  const rows = await db
    .select({
      id: testResults.id,
      runId: testResults.runId,
      status: testResults.status,
      durationMs: testResults.durationMs,
      retryCount: testResults.retryCount,
      title: testResults.title,
      file: testResults.file,
      projectName: testResults.projectName,
      createdAt: testResults.createdAt,
      branch: runs.branch,
      commitSha: runs.commitSha,
      commitMessage: runs.commitMessage,
      actor: runs.actor,
    })
    .from(testResults)
    .innerJoin(runs, eq(runs.id, testResults.runId))
    .where(
      and(
        eq(testResults.projectId, scope.projectId),
        eq(testResults.id, testResultId),
        eq(testResults.runId, runId),
        eq(runs.projectId, scope.projectId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return c.json({ error: "Not found" }, 404);
  c.header("Cache-Control", "private, max-age=30");
  return row satisfies TestResultSummaryResponse;
});
