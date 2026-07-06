import { defer, defineHandler, type InferProps } from "void";
import { and, asc, db, desc, eq, sql } from "void/db";
import { runs, testResults, testTags } from "@schema";
import { ciRunsJoinOn } from "@/lib/analytics/filters";
import { statusCounter } from "@/lib/analytics/per-test";
import { runRow } from "@/lib/db-run";
import { intAggExpr, numAggExpr } from "@/lib/db/sql-ops";
import { parseTitleSegments } from "@/lib/group-tests-by-file";
import { loadQuarantineByTestId } from "@/lib/quarantine-repo";
import { rate } from "@/lib/rate";
import { childByTestIdWhere } from "@/lib/scope";
import { requireTenantContext } from "@/lib/tenant-context";

export type Props = InferProps<typeof loader>;

/** Recent runs shown in the chart + history table. The chart caps at 30. */
const HISTORY_LIMIT = 60;

interface AggregateRow {
  totalRuns: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  firstSeen: number | null;
  lastSeen: number | null;
  passedCount: number;
  flakyCount: number;
  failCount: number;
  skippedCount: number;
}

/**
 * Per-test history page. Unlike the run-scoped result detail
 * (`runs/:runId/tests/:testResultId`), this is keyed by the stable `testId`
 * and answers "how has THIS test behaved over time?" — independent of any one
 * run.
 *
 * The header (title/status badge) + all-time KPI strip paint immediately from
 * two cheap eager reads:
 *
 *   1. an all-time aggregate over every (non-synthetic) result for the testId
 *      (counts, avg/p95 duration, first/last seen) — this also gates existence;
 *   2. the single most-recent result, for the page title/breadcrumb metadata
 *      (test title, describe chain, file, latest status).
 *
 * The heavy/streamed group behind skeletons:
 *
 *   3. the recent `HISTORY_LIMIT` results joined to their runs (duration-trend
 *      chart + recent-runs table);
 *   4. the union of tags the test has carried;
 *   5. its quarantine state.
 *
 * Every read scopes by `projectId` (via the branded `TenantScope`) per the
 * logical-tenancy invariant — there is no DO boundary. An empty history means
 * the testId isn't known in this project, so we return `kind: "not_found"`
 * rather than a 404 Response (the page renders a friendly "not found" with a
 * link back to the catalog).
 *
 * Plain `defineHandler` (not `withValidator`) — REQUIRED for `defer()`:
 * `withValidator` awaits/serializes the handler return, collapsing a `Deferred`
 * prop into a plain object so the client's `use()` throws.
 */
export const loader = defineHandler(async (c) => {
  const testId = c.req.param("testId");
  if (!testId) {
    throw new Response("Not Found", { status: 404 });
  }

  const url = new URL(c.req.url);
  const { project, scope } = requireTenantContext(c);

  // Eager: (1) all-time aggregate (gates existence + drives the KPI strip) and
  // (2) the single most-recent result (page title/metadata). Both run in
  // parallel; the heavy history/tags/quarantine reads stream behind skeletons.
  const [aggregate, latestRows] = await Promise.all([
    // (1) All-time aggregate. Raw read → bypasses Drizzle decoders, so the
    // int8/numeric coercions are baked into SQL (intAggExpr / numAggExpr /
    // statusCounter). `min`/`max` over the int8 `createdAt` are cast to double
    // precision (numAggExpr) so node-postgres hands them back as JS numbers.
    runRow<AggregateRow>(sql`
      select
        ${intAggExpr("count(*)", { alias: `"totalRuns"` })},
        -- Qualify with tr.: runs ALSO has a durationMs column, so a bare
        -- avg("durationMs") is ambiguous (42702) once runs is joined in.
        ${numAggExpr(`avg(tr."durationMs")`, { alias: `"avgDurationMs"` })},
        ${intAggExpr(
          `percentile_cont(0.95) within group (order by tr."durationMs")`,
          { alias: `"p95DurationMs"` },
        )},
        ${numAggExpr(`min(tr."createdAt")`, { alias: `"firstSeen"` })},
        ${numAggExpr(`max(tr."createdAt")`, { alias: `"lastSeen"` })},
        ${statusCounter("passed", { alias: `"passedCount"`, statusCol: "tr.status" })},
        ${statusCounter("flaky", { alias: `"flakyCount"`, statusCol: "tr.status" })},
        ${statusCounter("fail", { alias: `"failCount"`, statusCol: "tr.status" })},
        ${statusCounter("skipped", { alias: `"skippedCount"`, statusCol: "tr.status" })}
      from "testResults" tr
      inner join runs on runs.id = tr."runId" and runs.origin <> 'synthetic'
      where tr."projectId" = ${scope.projectId}
        and tr."testId" = ${testId}
    `),
    // (2) The single most-recent (non-synthetic) result — just enough to derive
    // the page title + metadata line, so the header paints without the full
    // history slice. Same `ciRunsJoinOn()` synthetic-exclusion as the aggregate.
    db
      .select({
        status: testResults.status,
        title: testResults.title,
        file: testResults.file,
        projectName: testResults.projectName,
      })
      .from(testResults)
      .innerJoin(runs, ciRunsJoinOn())
      .where(childByTestIdWhere(testResults, scope, testId))
      .orderBy(desc(testResults.createdAt))
      .limit(1),
  ]);

  const latest = latestRows[0];
  // No non-synthetic results for this testId → it isn't a known test here.
  if (!latest || !aggregate || aggregate.totalRuns === 0) {
    return {
      kind: "not_found" as const,
      project: { teamSlug: project.teamSlug, projectSlug: project.slug },
      testId,
    };
  }

  const { describeChain, testTitle } = parseTitleSegments(
    latest.title,
    latest.file,
    latest.projectName,
  );

  const executed =
    aggregate.passedCount + aggregate.flakyCount + aggregate.failCount;

  // A deferred loader streams a variant-specific body — set no-store so the
  // browser can't replay the wrong (NDJSON vs HTML) variant.
  c.header("Cache-Control", "private, no-store");
  return {
    kind: "ok" as const,
    project: {
      teamSlug: project.teamSlug,
      projectSlug: project.slug,
      // Owner-only quarantine control; non-owners see only the badge.
      canManageQuarantine: project.role === "owner",
    },
    testId,
    meta: {
      testTitle,
      describeChain,
      file: latest.file,
      projectName: latest.projectName,
      latestStatus: latest.status,
    },
    stats: {
      totalRuns: aggregate.totalRuns,
      executed,
      passedCount: aggregate.passedCount,
      flakyCount: aggregate.flakyCount,
      failCount: aggregate.failCount,
      skippedCount: aggregate.skippedCount,
      passRate: rate(aggregate.passedCount, executed),
      flakyRate: rate(aggregate.flakyCount, executed),
      avgDurationMs: aggregate.avgDurationMs,
      p95DurationMs: aggregate.p95DurationMs,
      firstSeen: aggregate.firstSeen,
      lastSeen: aggregate.lastSeen,
    },
    quarantineRedirectTo: url.pathname + url.search,
    quarantineError: url.searchParams.get("quarantineError"),

    // Streamed behind skeletons: the recent-runs slice (chart + table), the
    // tag union, and the quarantine state. All three were a single Promise.all
    // leg before; grouping them into one `defer()` keeps them resolving
    // together while the header + KPI strip paint from the eager reads above.
    details: defer(async () => {
      const [history, tagRows, quarantineRows] = await Promise.all([
        // Recent results + their run metadata. Drizzle builder → decoders fire,
        // so `createdAt` (bigint, mode:"number") and `durationMs` come back as
        // numbers. `ciRunsJoinOn()` excludes synthetic monitor traffic.
        db
          .select({
            testResultId: testResults.id,
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
          .innerJoin(runs, ciRunsJoinOn())
          .where(childByTestIdWhere(testResults, scope, testId))
          .orderBy(desc(testResults.createdAt))
          .limit(HISTORY_LIMIT),
        // Union of every tag the test has carried, across its results.
        db
          .selectDistinct({ tag: testTags.tag })
          .from(testTags)
          .innerJoin(testResults, eq(testResults.id, testTags.testResultId))
          .where(
            and(
              eq(testTags.projectId, scope.projectId),
              eq(testResults.projectId, scope.projectId),
              eq(testResults.testId, testId),
            ),
          )
          .orderBy(asc(testTags.tag)),
        loadQuarantineByTestId(project.id, [testId]),
      ]);

      return {
        history,
        tags: tagRows.map((t) => t.tag),
        quarantine: quarantineRows[0]
          ? { mode: quarantineRows[0].mode, reason: quarantineRows[0].reason }
          : null,
      };
    }),
  };
});
