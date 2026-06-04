import { defineHandler } from "void";
import { db } from "void/db";
import { runs } from "@schema";
import { runByIdWhere } from "@/lib/scope";
import { resolveTenantApiScope } from "@/lib/tenant-api-scope";

export type RunSummaryResponse = {
  id: string;
  status: string;
  durationMs: number;
  totalTests: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  prNumber: number | null;
  actor: string | null;
  createdAt: number;
  completedAt: number | null;
};

/**
 * GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/summary
 *
 * Compact snapshot of a single run for the run-history hovercard. Totals,
 * branch, commit, author. Per-test detail lives on `/test-preview`.
 */
export const GET = defineHandler(async (c) => {
  const ctx = await resolveTenantApiScope(c);
  if (ctx instanceof Response) return ctx;
  const { scope, runId } = ctx;

  const rows = await db
    .select({
      id: runs.id,
      status: runs.status,
      durationMs: runs.durationMs,
      totalTests: runs.totalTests,
      passed: runs.passed,
      failed: runs.failed,
      flaky: runs.flaky,
      skipped: runs.skipped,
      branch: runs.branch,
      commitSha: runs.commitSha,
      commitMessage: runs.commitMessage,
      prNumber: runs.prNumber,
      actor: runs.actor,
      createdAt: runs.createdAt,
      completedAt: runs.completedAt,
    })
    .from(runs)
    .where(runByIdWhere(scope, runId))
    .limit(1);

  const run = rows[0];
  if (!run) return c.json({ error: "Not found" }, 404);

  c.header("Cache-Control", "private, max-age=30");
  return run satisfies RunSummaryResponse;
});
