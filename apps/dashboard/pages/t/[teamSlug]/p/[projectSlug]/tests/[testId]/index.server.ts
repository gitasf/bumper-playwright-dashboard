import { defer, defineHandler, type InferProps } from "void";
import { and, asc, db, desc, eq, sql } from "void/db";
import { runs, testResults, testTags } from "@schema";
import { ciRunsJoinOn } from "@/lib/analytics/filters";
import { statusCounter } from "@/lib/analytics/per-test";
import { listTeamMembers } from "@/lib/auth-users";
import { runRow } from "@/lib/runs/db";
import { intAggExpr, numAggExpr } from "@/lib/db/sql-ops";
import { parseTitleSegments } from "@/lib/group-tests-by-file";
import { resolveTestOwners } from "@/lib/owners-repo";
import { loadQuarantineByTestId } from "@/lib/quarantine-repo";
import { rate } from "@/lib/rate";
import { childByTestIdWhere } from "@/lib/scope";
import { requireTenantContext } from "@/lib/tenant-context";
import { TEST_DETAIL_FLASH } from "@/lib/test-detail-flash";

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
 * The header paints from one cheap eager read: the most-recent (non-synthetic)
 * result for the testId — an index-served `ORDER BY createdAt DESC LIMIT 1`
 * (not a history scan) that doubles as the existence probe and supplies the
 * title/describe-chain/file/latest-status.
 *
 * Two groups stream behind skeletons, each its own `defer()` so neither gates
 * the other or the header:
 *   - `stats`: all-time aggregate (counts, avg/p95 duration, first/last seen)
 *     for the KPI strip. The expensive one — `percentile_cont(0.95)` sorts
 *     every retained row — hence no longer gating the header/existence.
 *   - `details`: recent `HISTORY_LIMIT` results joined to runs (chart +
 *     recent-runs table), tag union, quarantine state, owners + (for owners)
 *     assignable members. One `defer()` so they resolve together.
 *
 * Every read scopes by `projectId` (branded `TenantScope`) per logical
 * tenancy. No result → `kind: "not_found"` (friendly page), not a 404 Response.
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

  // Eager: single most-recent (non-synthetic) result — index-served
  // `ORDER BY createdAt DESC LIMIT 1`. Doubles as existence probe and title/
  // metadata source, so the header paints without the heavy aggregate below.
  // Same `ciRunsJoinOn()` synthetic-exclusion as that aggregate, so a hit here
  // guarantees its `totalRuns` >= 1 — sufficient to gate existence alone.
  const latestRows = await db
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
    .limit(1);

  const latest = latestRows[0];
  // No non-synthetic results for this testId → it isn't a known test here.
  if (!latest) {
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

  // A deferred loader streams a variant-specific body — set no-store so the
  // browser can't replay the wrong (NDJSON vs HTML) variant.
  c.header("Cache-Control", "private, no-store");
  return {
    kind: "ok" as const,
    project: {
      teamSlug: project.teamSlug,
      projectSlug: project.slug,
      teamName: project.teamName,
      // Owner-only quarantine control; non-owners see only the badge.
      canManageQuarantine: project.role === "owner",
      // Owner-only test-ownership assign popover; non-owners see only chips.
      canManageOwners: project.role === "owner",
    },
    testId,
    meta: {
      testTitle,
      describeChain,
      file: latest.file,
      projectName: latest.projectName,
      latestStatus: latest.status,
    },
    quarantineRedirectTo: url.pathname + url.search,
    // `quarantineError` / `ownerError`: set by the quarantine / owner mutation
    // routes on failure (they redirect back here with the message). Surfaced
    // as banners; slot names are the typed contract shared with those routes.
    ...TEST_DETAIL_FLASH.read(url),

    // All-time KPI strip. Display-only, so it streams behind its own skeleton
    // independent of `details`. Formerly the eager existence gate that blocked
    // first paint on a full history sort (`percentile_cont(0.95)`). Existence
    // is now settled by `latest` above, so a missing/zero aggregate can only be
    // a bug — surfaced by throwing, which `DeferredSection`'s error boundary
    // degrades to a scoped error card rather than blanking the page.
    stats: defer(async () => {
      // Raw read → bypasses Drizzle decoders, so the int8/numeric coercions
      // are baked into SQL (intAggExpr / numAggExpr / statusCounter). `min`/
      // `max` over the int8 `createdAt` are cast to double precision
      // (numAggExpr) so node-postgres hands them back as JS numbers.
      const aggregate = await runRow<AggregateRow>(sql`
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
      `);

      if (!aggregate) {
        // `latest` already confirmed existence (same join/predicate), so an
        // empty row here means the two reads disagree — a bug, not empty state.
        throw new Error(
          `Missing all-time aggregate row for testId ${testId} despite a confirmed result`,
        );
      }

      const executed =
        aggregate.passedCount + aggregate.flakyCount + aggregate.failCount;

      return {
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
      };
    }),

    // Streamed behind skeletons: the recent-runs slice (chart + table), the
    // tag union, the quarantine state, the test's resolved owners, and — for
    // owners only — the member list the assign popover selects from. Grouping
    // them into one `defer()` keeps them resolving together while the header
    // paints from the eager read above.
    details: defer(async () => {
      const [history, tagRows, quarantineRows, ownerMap, members] =
        await Promise.all([
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
          // This test's owners (manual + CODEOWNERS-derived, manual-wins).
          resolveTestOwners(scope, [testId]),
          // The assign popover's member options — only loaded for owners (the
          // only viewers who get the control).
          project.role === "owner"
            ? listTeamMembers(project.teamId)
            : Promise.resolve([]),
        ]);

      return {
        history,
        tags: tagRows.map((t) => t.tag),
        quarantine: quarantineRows[0]
          ? { mode: quarantineRows[0].mode, reason: quarantineRows[0].reason }
          : null,
        owners: ownerMap.get(testId) ?? [],
        assignableMembers: members.map((m) => ({
          name: m.name,
          email: m.email,
        })),
      };
    }),
  };
});
