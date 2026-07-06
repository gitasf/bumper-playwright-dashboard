import { defer, defineHandler, type InferProps } from "void";
import { and, db, desc, eq } from "void/db";
import { runs } from "@schema";
import { ALL_BRANCHES } from "@/components/run-history-branch-filter.shared";
import { loadProjectBranches } from "@/lib/branches-query";
import { RUN_PUBLIC_COLUMNS } from "@/lib/run-columns";
import { runByIdWhere, runScopeWhere } from "@/lib/scope";
import { requireTenantContext } from "@/lib/tenant-context";

export type Props = InferProps<typeof loader>;

const HISTORY_LIMIT = 30;

/**
 * Run detail loader. Resolves the active run + the eager bits the shell needs
 * (run row → live-chip seed, branch list → chart filter, history → deferred
 * chart). The Tests-tab group list is NOT loaded here — it loads client-side
 * behind a skeleton via TanStack (`RunProgress`), so the page shell + header +
 * filter chips paint immediately and the group list streams in on demand,
 * matching the deferred-load pattern used elsewhere on the page.
 *
 * The page subscribes via `useRunRoom(runId)`: the summary (from `run.*`) drives
 * the live filter chips, and live `changedTests` merge into loaded groups.
 */
export const loader = defineHandler(async (c) => {
  const runId = c.req.param("runId");
  if (!runId) throw new Response("Not Found", { status: 404 });

  const { project, scope } = requireTenantContext(c);

  const runRows = await db
    // Explicit projection — omits idempotencyKey (the write-reopen credential)
    // from the serialized props. See RUN_PUBLIC_COLUMNS.
    .select(RUN_PUBLIC_COLUMNS)
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

  // History query builder: last HISTORY_LIMIT runs, optionally filtered by
  // branch. Deferred (below), so `defer()`'s awaited promise is the query, not
  // an already-awaited result.
  const historyConditions = [runScopeWhere(scope)];
  if (effectiveBranch !== ALL_BRANCHES) {
    historyConditions.push(eq(runs.branch, effectiveBranch));
  }
  // Duration-trend history query builder — DEFERRED (see `chart` in the return).
  // The resolver awaits this so `defer()` streams the plot body below the fold.
  // History is not a realtime seed, so deferring it can't tear the live islands.
  const historyQuery = db
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
    .limit(HISTORY_LIMIT);

  // `branches` is a cheap index-covered DISTINCT and drives the always-visible
  // branch filter in the chart's title row. Loading it EAGER lets the chart's
  // skeleton render the real filter + title row while only the history plot
  // streams in — so the title row is identical markup in both states and can't
  // shift.
  const branches = await loadProjectBranches(scope);

  // This loader sets no Cache-Control, so nothing changes there: a deferred
  // loader streams its body (NDJSON on SPA nav / chunked HTML on document load),
  // and the absence of a stored SWR/max-age response means the browser can't
  // replay the wrong variant. (See suite-size.server.ts for the case where a
  // pre-existing max-age header had to become `private, no-store`.)
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
    branchParam,
    defaultBranch,
    effectiveBranch,
    tab,
    pathname: url.pathname,
    // Whether the run is sharded — gates the "Shard" group-by option. Read off
    // the run's declared shard total (set at open from config.shard.total) so
    // it's known before any row loads, not derived from the loaded rows.
    isSharded: run.expectedShards != null,
    branches,

    // Below-the-fold duration-trend history. ONLY the plot data is deferred —
    // the card chrome, title, and branch filter render eagerly from `branches`
    // above (see RunHistoryChartFrame), so the skeleton→chart swap changes only
    // the plot body and can't shift the title row. Read-only and NOT a realtime
    // seed (the branch filter reads the URL via `useNavigatingSearchParam`, not
    // a room hook), so deferring it can't tear the live islands.
    chart: defer(async () => {
      const history = await historyQuery;
      return { history };
    }),
  };
});
