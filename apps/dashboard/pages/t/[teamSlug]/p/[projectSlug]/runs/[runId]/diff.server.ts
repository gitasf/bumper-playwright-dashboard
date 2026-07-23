import { defer, defineHandler, type InferProps } from "void";
import { computeRunDiff, resolveRunDiffTargets } from "@/lib/runs/diff";
import { requireTenantContext } from "@/lib/tenant-context";

export type Props = InferProps<typeof loader>;

const BASE_CANDIDATE_LIMIT = 20;

/**
 * Run-diff loader (roadmap 2.4). Loads the head run (project-scoped), resolves
 * a base — an explicit `?base=<runId>` validated via the project-scoped run
 * lookup, else the most recent passing run on the same branch — then diffs the
 * two runs' per-test statuses with the pure `diffRuns`.
 *
 * Renders an empty state (no diff) when there is no suitable base: a head run
 * with no branch, or no prior passing run on the branch, or an invalid
 * `?base`.
 */
export const loader = defineHandler(async (c) => {
  const runId = c.req.param("runId");
  if (!runId) throw new Response("Not Found", { status: 404 });

  const { project, scope } = requireTenantContext(c);

  const url = new URL(c.req.url);
  // Eager: the head (404 gate), the base, and the base-candidate selector list
  // — all cheap single-row/indexed lookups that drive the always-visible
  // header, RunChips, base selector and the empty (no-baseline) state.
  // `resolveRunDiffTargets` runs these across two parallel waves rather than
  // three-to-four serial round trips (see its docstring). The two heavy
  // per-test scans + diff defer below.
  const targets = await resolveRunDiffTargets(scope, runId, {
    baseParam: url.searchParams.get("base"),
    baseCandidateLimit: BASE_CANDIDATE_LIMIT,
  });
  if ("notFound" in targets) throw new Response("Not Found", { status: 404 });
  const { head, base, baseCandidates = [] } = targets;

  // A deferred loader streams a variant-specific body (keyed by ?base) — set
  // no-store so the browser can't replay the wrong variant against a stale base.
  c.header("Cache-Control", "private, no-store");
  return {
    project: {
      slug: project.slug,
      teamSlug: project.teamSlug,
    },
    head,
    base,
    baseCandidates: baseCandidates.filter((r) => r.id !== runId),
    pathname: url.pathname,

    // The two full per-test scans + the pure diff — the heavy work — stream
    // behind the diff-body skeleton. `counts` derives from the same diff, so it
    // resolves here too (can't exist without the scans). `base` stays eager, so
    // the shell already knows whether to show the diff body or the no-baseline
    // empty state; only the CountPill row + bucket tables defer.
    comparison: defer(async () => {
      const diff = await computeRunDiff(scope, runId, base);
      const counts = diff
        ? {
            newlyFailed: diff.newlyFailed.length,
            newlyPassed: diff.newlyPassed.length,
            stillFailing: diff.stillFailing.length,
            flakyDeltas: diff.flakyDeltas.length,
            addedTests: diff.addedTests.length,
            removedTests: diff.removedTests.length,
          }
        : null;
      return { diff, counts };
    }),
  };
});
