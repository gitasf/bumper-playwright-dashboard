import { defineHandler } from "void";
import { resolveRunDiff, type RunDiff } from "@/lib/runs/diff";
import { resolveTenantApiScope } from "@/lib/tenant-api-scope";

export type RunDiffResponse = {
  head: { id: string; status: string; branch: string | null };
  base: { id: string; status: string; branch: string | null } | null;
  diff: RunDiff | null;
};

/**
 * GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/diff
 *
 * Session-authed JSON view of a run-to-run diff. Resolves the head + base the
 * same way the page loader does — explicit `?base=<runId>` (project-scoped
 * validated) else the most recent passing run on the same branch — and returns
 * the pure `diffRuns` output. `diff` is `null` when there is no suitable base.
 *
 * Mirrors `summary.ts`: `Cache-Control: private, max-age=30`.
 */
export const GET = defineHandler(async (c) => {
  const ctx = await resolveTenantApiScope(c);
  if (ctx instanceof Response) return ctx;
  const { scope, runId } = ctx;

  const resolved = await resolveRunDiff(scope, runId, {
    baseParam: c.req.query("base"),
  });
  if ("notFound" in resolved) return c.json({ error: "Not found" }, 404);
  const { head, base, diff } = resolved;

  c.header("Cache-Control", "private, max-age=30");
  return {
    head: { id: head.id, status: head.status, branch: head.branch },
    base: base
      ? { id: base.id, status: base.status, branch: base.branch }
      : null,
    diff,
  } satisfies RunDiffResponse;
});
