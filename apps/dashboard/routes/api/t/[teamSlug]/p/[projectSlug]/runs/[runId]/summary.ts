import { defineHandler } from "void";
import { loadRunColumns, RUN_SUMMARY_COLUMNS } from "@/lib/runs/read-model";
import { resolveTenantApiScope } from "@/lib/tenant-api-scope";

/**
 * The wire shape of `/summary` — exactly the shared run-summary base
 * (`RUN_SUMMARY_COLUMNS` in `@/lib/runs/read-model`). Adopting the base ADDED
 * `environment` / `repo` / `origin` to this response (additive only — the
 * hovercard consumer reads a subset, so nothing it renders changed).
 */
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
  environment: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  prNumber: number | null;
  actor: string | null;
  repo: string | null;
  origin: string;
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

  const run = await loadRunColumns(scope, runId, RUN_SUMMARY_COLUMNS);
  if (!run) return c.json({ error: "Not found" }, 404);

  c.header("Cache-Control", "private, max-age=30");
  return run satisfies RunSummaryResponse;
});
