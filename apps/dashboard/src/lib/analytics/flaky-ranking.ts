import { and, db, eq, gte, sql } from "void/db";
import { runs, testResults } from "@schema";
import { ciRunsJoinOn } from "@/lib/analytics/filters";
import { numericSql } from "@/lib/db/sql-ops";
import { rate } from "@/lib/rate";
import { childProjectScopeWhere, type TenantScope } from "@/lib/scope";

/**
 * The project's flaky-test ranking pass — the per-testId aggregate + rank that
 * BOTH the dashboard flaky page (`flaky.server.ts`) and the MCP
 * `list_flaky_tests` tool (`src/lib/mcp/queries.ts`) open with.
 *
 * It used to live verbatim in both: same `ciRunsJoinOn()` synthetic-traffic
 * exclusion, same status counters, same
 * `having flaky >= 1`, same `flaky / (flaky + passed)` rate and same
 * rate-then-count sort. An agent and the flaky page disagreeing about "the
 * flakiest tests" for the same window reads as a data bug, so the two were
 * pinned together by comments — exactly the drift risk `paginateRunTests` and
 * `loadTestResultChildren` were extracted to remove for the other MCP reads.
 * This owns that ranking definition once; each caller decorates the ranked
 * slice with its own second pass (sparklines/owners for the page, the latest
 * flaky occurrence for MCP).
 *
 * `flakeRatePct` is the raw 0..100 rate (unrounded) so the sort tiebreak is
 * exact; display rounding stays with each caller.
 */
export interface RankedFlaky {
  testId: string;
  /** Non-skipped executions in the window (includes hard failures). */
  total: number;
  /** Results recorded `flaky` (failed, then passed on retry). */
  flakyCount: number;
  passedCount: number;
  /** Results that remained failed or timed out after retries. */
  hardFailureCount: number;
  /** flaky / (flaky + passed), 0..100, unrounded. */
  flakeRatePct: number;
}

/**
 * Rank a project's tests by flake rate over `[windowStartSec, now]`, flakiest
 * first (rate desc, then flaky-count desc). Only tests with at least one flaky
 * result in the window appear. Synthetic monitor traffic can't rank
 * (`ciRunsJoinOn`). An optional exact `branch` filter narrows to one branch.
 */
export async function rankFlakyTests(
  scope: TenantScope,
  opts: { windowStartSec: number; branch: string | null },
): Promise<RankedFlaky[]> {
  const conditions = [
    childProjectScopeWhere(testResults.projectId, scope),
    gte(testResults.createdAt, opts.windowStartSec),
  ];
  if (opts.branch) conditions.push(eq(runs.branch, opts.branch));

  const aggRows = await db
    .select({
      testId: testResults.testId,
      total: numericSql(
        sql`sum(case when ${testResults.status} != 'skipped' then 1 else 0 end)`,
      ),
      flakyCount: numericSql(
        sql`sum(case when ${testResults.status} = 'flaky' then 1 else 0 end)`,
      ),
      passedCount: numericSql(
        sql`sum(case when ${testResults.status} = 'passed' then 1 else 0 end)`,
      ),
      hardFailureCount: numericSql(
        sql`sum(case when ${testResults.status} in ('failed', 'timedout') then 1 else 0 end)`,
      ),
    })
    .from(testResults)
    .innerJoin(runs, ciRunsJoinOn())
    .where(and(...conditions))
    .groupBy(testResults.testId)
    .having(
      sql`sum(case when ${testResults.status} = 'flaky' then 1 else 0 end) >= 1`,
    );

  return aggRows
    .map((r) => ({
      ...r,
      flakeRatePct: rate(r.flakyCount, r.flakyCount + r.passedCount),
    }))
    .sort(
      (a, b) => b.flakeRatePct - a.flakeRatePct || b.flakyCount - a.flakyCount,
    );
}
