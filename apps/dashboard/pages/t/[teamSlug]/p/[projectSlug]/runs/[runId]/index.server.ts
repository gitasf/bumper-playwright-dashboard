import { defineHandler, type InferProps } from "void";
import { and, db, desc, eq } from "void/db";
import { runs } from "@schema";
import { ALL_BRANCHES } from "@/components/run-history-branch-filter.shared";
import { loadProjectBranches } from "@/lib/branches-query";
import { loadRunResultsPage } from "@/lib/run-results-page";
import { runByIdWhere, runScopeWhere } from "@/lib/scope";
import { requireTenantContext } from "@/lib/tenant-context";
import { loadFailingArtifactActions } from "@/lib/test-artifact-actions";

export type Props = InferProps<typeof loader>;

const HISTORY_LIMIT = 30;
const TESTS_LIMIT = 200;

/**
 * Run detail loader. Resolves the active run + its history strip + the
 * first page of tests + per-test artifact actions in a single batch. The
 * page component uses `useRunProgress(runId)` for live updates merged on
 * top of these SSR-seeded rows.
 */
export const loader = defineHandler(async (c) => {
  const runId = c.req.param("runId");
  if (!runId) throw new Response("Not Found", { status: 404 });

  const { project, scope } = requireTenantContext(c);

  const runRows = await db
    .select()
    .from(runs)
    .where(runByIdWhere(scope, runId))
    .limit(1);
  const run = runRows[0];
  if (!run) throw new Response("Not Found", { status: 404 });

  const url = new URL(c.req.url);
  const branchParam = url.searchParams.get("branch");
  const defaultBranch = run.branch ?? ALL_BRANCHES;
  const effectiveBranch = branchParam ?? defaultBranch;
  const tabParam = url.searchParams.get("tab");
  const tab: "tests" | "env" = tabParam === "env" ? "env" : "tests";

  const origin = url.origin;

  // History: last HISTORY_LIMIT runs, optionally filtered by branch.
  const historyConditions = [runScopeWhere(scope)];
  if (effectiveBranch !== ALL_BRANCHES) {
    historyConditions.push(eq(runs.branch, effectiveBranch));
  }
  const [history, branches, resultsPage] = await Promise.all([
    db
      .select({
        id: runs.id,
        status: runs.status,
        durationMs: runs.durationMs,
        createdAt: runs.createdAt,
        branch: runs.branch,
        commitSha: runs.commitSha,
        commitMessage: runs.commitMessage,
      })
      .from(runs)
      .where(and(...historyConditions))
      .orderBy(desc(runs.createdAt))
      .limit(HISTORY_LIMIT),
    loadProjectBranches(scope),
    // Canonical "first page of a run's testResults as RunProgressTest[]" —
    // shared with the GET /results back-paginator so the SSR seed and any
    // later pages can never diverge in shape, ordering, or status
    // normalization (see @/lib/run-results-page).
    loadRunResultsPage(scope, runId, {
      cursor: null,
      limit: TESTS_LIMIT,
      status: null,
    }),
  ]);

  // The full-run select() above already 404s on a foreign/missing run, so the
  // run is owned here; loadRunResultsPage's own ownership probe agrees.
  const tests = resultsPage?.results ?? [];

  const artifactActionsByTestId = await loadFailingArtifactActions(
    scope,
    tests.map((t) => ({
      id: t.id,
      status: t.status,
      retryCount: t.retryCount,
    })),
    origin,
  );

  return {
    project: {
      id: project.id,
      teamId: project.teamId,
      slug: project.slug,
      name: project.name,
      teamSlug: project.teamSlug,
      role: project.role,
    },
    run,
    runId,
    history,
    branches,
    branchParam,
    defaultBranch,
    effectiveBranch,
    tab,
    pathname: url.pathname,
    tests,
    artifactActionsByTestId,
  };
});
