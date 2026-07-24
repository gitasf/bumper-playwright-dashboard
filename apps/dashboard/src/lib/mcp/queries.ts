import { and, db, desc, eq, gte, inArray } from "void/db";
import {
  artifacts,
  memberships,
  projects,
  runs,
  teams,
  testResults,
} from "@schema";
import { ciRunsJoinOn } from "@/lib/analytics/filters";
import { rankFlakyTests } from "@/lib/analytics/flaky-ranking";
import { loadRunColumns, RUN_SUMMARY_COLUMNS } from "@/lib/runs/read-model";
import { paginateRunTests } from "@/lib/runs/results-page";
import {
  childByIdWhere,
  childByTestResultWhere,
  childProjectScopeWhere,
  type TenantScope,
} from "@/lib/scope";
import { loadTestResultChildren } from "@/lib/test-result-children";

/**
 * Project-scoped reads for the MCP tool surface (`src/lib/mcp/server.ts`).
 *
 * These deliberately live NEXT TO the tool definitions rather than being
 * bolted onto the dashboard's page loaders: the MCP shapes differ in one
 * load-bearing way — they carry `errorMessage`/`errorStack` (the thing an
 * agent is here for), which the realtime-oriented `loadRunResultsPage`
 * projection deliberately omits to keep ws payloads small. Scoping rules are
 * identical: every query goes through the blessed predicate family in
 * `@/lib/scope`, so a project-A key can never read project-B rows.
 */

/** One test row as the `list_tests` tool returns it. */
export interface McpTestRow {
  id: string;
  testId: string;
  title: string;
  file: string;
  projectName: string | null;
  status: string;
  durationMs: number;
  retryCount: number;
  /** Truncated to {@link ERROR_MESSAGE_SNIPPET_CHARS} — full text via get_test_result. */
  errorMessage: string | null;
}

/** Keep list payloads bounded; `get_test_result` returns the full message + stack. */
export const ERROR_MESSAGE_SNIPPET_CHARS = 2000;

export function truncateText(text: string | null, max: number): string | null {
  if (text === null) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated ${text.length - max} chars — see get_test_result for the full text]`;
}

/**
 * The run columns the `get_run` tool returns — its full summary card: the shared
 * summary base plus this surface's agent-debugging extras (which CI produced the
 * run, which Playwright version ran it). Deliberately omits v1's
 * `expectedTotalTests` — the two contracts are pinned independently (see
 * `@/lib/runs/read-model`).
 */
const MCP_RUN_COLUMNS = {
  ...RUN_SUMMARY_COLUMNS,
  ciProvider: runs.ciProvider,
  playwrightVersion: runs.playwrightVersion,
} as const;

/** One run's full summary by id, project-scoped; `null` when out of scope. */
export async function loadMcpRun(scope: TenantScope, runId: string) {
  return loadRunColumns(scope, runId, MCP_RUN_COLUMNS);
}

/**
 * Cursor-paginated test results for one run, INCLUDING the error snippet.
 * Shares the canonical `paginateRunTests` engine (owner probe, cursor tuple,
 * ordering, nextCursor) with `loadRunResultsPage`; the ONLY thing this adds is
 * a wider projection (`errorMessage`, truncated) — the thing an agent is here
 * for, which the realtime `RunProgressTest` projection deliberately omits to
 * keep ws payloads small.
 */
export async function loadMcpRunTests(
  scope: TenantScope,
  runId: string,
  opts: { status: string | null; limit: number; cursor: string | null },
): Promise<{ tests: McpTestRow[]; nextCursor: string | null } | null> {
  const page = await paginateRunTests(
    scope,
    runId,
    opts,
    (where, orderBy, limit) =>
      db
        .select({
          id: testResults.id,
          testId: testResults.testId,
          title: testResults.title,
          file: testResults.file,
          projectName: testResults.projectName,
          status: testResults.status,
          durationMs: testResults.durationMs,
          retryCount: testResults.retryCount,
          errorMessage: testResults.errorMessage,
          createdAt: testResults.createdAt,
        })
        .from(testResults)
        .where(where)
        .orderBy(...orderBy)
        .limit(limit),
    (r) => ({
      id: r.id,
      testId: r.testId,
      title: r.title,
      file: r.file,
      projectName: r.projectName,
      status: r.status,
      durationMs: r.durationMs,
      retryCount: r.retryCount,
      errorMessage: truncateText(r.errorMessage, ERROR_MESSAGE_SNIPPET_CHARS),
    }),
  );
  if (!page) return null;
  return { tests: page.items, nextCursor: page.nextCursor };
}

export interface McpArtifactRow {
  id: string;
  type: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  attempt: number;
  role: string | null;
  snapshotName: string | null;
}

const ARTIFACT_LIST_COLUMNS = {
  id: artifacts.id,
  type: artifacts.type,
  name: artifacts.name,
  contentType: artifacts.contentType,
  sizeBytes: artifacts.sizeBytes,
  attempt: artifacts.attempt,
  role: artifacts.role,
  snapshotName: artifacts.snapshotName,
} as const;

/**
 * Full detail for one test result: the row + its run's VCS context, every
 * retry attempt's error, tags, annotations, and the artifact index the agent
 * feeds into `get_artifact`.
 */
export async function loadMcpTestResultDetail(
  scope: TenantScope,
  testResultId: string,
) {
  const rows = await db
    .select({
      id: testResults.id,
      runId: testResults.runId,
      testId: testResults.testId,
      title: testResults.title,
      file: testResults.file,
      projectName: testResults.projectName,
      status: testResults.status,
      durationMs: testResults.durationMs,
      retryCount: testResults.retryCount,
      errorMessage: testResults.errorMessage,
      errorStack: testResults.errorStack,
      workerIndex: testResults.workerIndex,
      shardIndex: testResults.shardIndex,
      createdAt: testResults.createdAt,
      branch: runs.branch,
      commitSha: runs.commitSha,
      commitMessage: runs.commitMessage,
      prNumber: runs.prNumber,
      repo: runs.repo,
      environment: runs.environment,
      actor: runs.actor,
    })
    .from(testResults)
    .innerJoin(runs, eq(runs.id, testResults.runId))
    .where(
      and(
        childByIdWhere(testResults, scope, testResultId),
        eq(runs.projectId, scope.projectId),
      ),
    )
    .limit(1);
  const result = rows[0];
  if (!result) return null;

  const [children, artifactRows] = await Promise.all([
    loadTestResultChildren(scope, testResultId),
    db
      .select(ARTIFACT_LIST_COLUMNS)
      .from(artifacts)
      .where(childByTestResultWhere(artifacts, scope, testResultId))
      .orderBy(artifacts.attempt, artifacts.type, artifacts.name),
  ]);

  return {
    result,
    attempts: children.attempts,
    tags: children.tags.map((t) => t.tag),
    annotations: children.annotations,
    artifacts: artifactRows as McpArtifactRow[],
  };
}

/** One row per (team, project) the user can read; `project*` null for a team with no projects yet. */
export interface UserProjectRow {
  team: string;
  teamName: string;
  project: string | null;
  projectName: string | null;
}

/**
 * Every project the user's memberships reach — the `list_projects` tool and
 * the "not a member" error hint on the OAuth-authed MCP surface. Membership
 * join only; the branded scope for actual reads still comes from
 * `tenantScopeForUserBySlugs` per call.
 */
export async function listUserProjects(
  userId: string,
): Promise<UserProjectRow[]> {
  return db
    .select({
      team: teams.slug,
      teamName: teams.name,
      project: projects.slug,
      projectName: projects.name,
    })
    .from(memberships)
    .innerJoin(teams, eq(teams.id, memberships.teamId))
    .leftJoin(projects, eq(projects.teamId, teams.id))
    .where(eq(memberships.userId, userId))
    .orderBy(teams.slug, projects.slug);
}

/** One ranked flaky test as the `list_flaky_tests` tool returns it. */
export interface McpFlakyTest {
  testId: string;
  title: string;
  file: string;
  /** Results in the window recorded `flaky` (failed, then passed on retry). */
  flakyCount: number;
  passedCount: number;
  /** Non-skipped executions in the window (includes hard failures). */
  totalExecuted: number;
  /** flaky / (flaky + passed), 0–100 — same definition as the dashboard's flaky page. */
  flakeRatePct: number;
  lastFlakyAt: number | null;
  /** Entry point for diagnosis — feed into get_test_result. */
  lastFlakyTestResultId: string | null;
  lastFlakyRunId: string | null;
  /** Error snippet from the latest flaky occurrence (attempt-level errors via get_test_result). */
  errorMessage: string | null;
}

export interface McpFlakyTestsResult {
  flakyTests: McpFlakyTest[];
  /** Total distinct flaky tests in the window (may exceed flakyTests.length). */
  totalFlakyTests: number;
  windowDays: number;
}

/**
 * Rank the project's flakiest tests over a trailing window — the "find" half
 * of the flaky-test loop (the "fix" half is `get_test_result`'s per-attempt
 * errors + per-attempt artifacts).
 *
 * PASS 1 is `rankFlakyTests` — the SAME ranking function the dashboard flaky
 * page (flaky.server.ts) opens with, so an agent and the dashboard can't report
 * different "flakiest tests" for the same window (that would read as a data
 * bug). It owns the per-testId counters, the `ciRunsJoinOn()` synthetic-traffic
 * exclusion, the flake rate = flaky / (flaky + passed), and the rate-then-count
 * sort once, for both surfaces.
 *
 * PASS 2 fetches each ranked test's LATEST flaky occurrence (`distinct on`,
 * Postgres-only like the rest of the store) for its title/file, timestamp,
 * error snippet, and — most importantly — the `testResultId` handle the agent
 * feeds straight into `get_test_result` for attempts + artifacts.
 */
export async function loadMcpFlakyTests(
  scope: TenantScope,
  opts: { days: number; branch: string | null; limit: number },
): Promise<McpFlakyTestsResult> {
  const windowStartSec = Math.floor(Date.now() / 1000) - opts.days * 86400;
  const ranked = await rankFlakyTests(scope, {
    windowStartSec,
    branch: opts.branch,
  });
  const slice = ranked.slice(0, opts.limit);
  if (slice.length === 0) {
    return {
      flakyTests: [],
      totalFlakyTests: ranked.length,
      windowDays: opts.days,
    };
  }

  const latestConditions = [
    childProjectScopeWhere(testResults.projectId, scope),
    inArray(
      testResults.testId,
      slice.map((r) => r.testId),
    ),
    eq(testResults.status, "flaky"),
    gte(testResults.createdAt, windowStartSec),
  ];
  if (opts.branch) latestConditions.push(eq(runs.branch, opts.branch));
  const latestRows = await db
    .selectDistinctOn([testResults.testId], {
      testId: testResults.testId,
      id: testResults.id,
      runId: testResults.runId,
      title: testResults.title,
      file: testResults.file,
      errorMessage: testResults.errorMessage,
      createdAt: testResults.createdAt,
    })
    .from(testResults)
    .innerJoin(runs, ciRunsJoinOn())
    .where(and(...latestConditions))
    // `distinct on` requires the distinct column to lead the ordering; the
    // createdAt DESC tiebreak makes "the" row per test the latest one.
    .orderBy(testResults.testId, desc(testResults.createdAt));

  const latestByTestId = new Map(latestRows.map((r) => [r.testId, r]));
  return {
    totalFlakyTests: ranked.length,
    windowDays: opts.days,
    flakyTests: slice.map((r) => {
      const latest = latestByTestId.get(r.testId);
      return {
        testId: r.testId,
        title: latest?.title ?? "",
        file: latest?.file ?? "",
        flakyCount: r.flakyCount,
        passedCount: r.passedCount,
        totalExecuted: r.total,
        flakeRatePct: Math.round(r.flakeRatePct * 10) / 10,
        lastFlakyAt: latest?.createdAt ?? null,
        lastFlakyTestResultId: latest?.id ?? null,
        lastFlakyRunId: latest?.runId ?? null,
        errorMessage: truncateText(
          latest?.errorMessage ?? null,
          ERROR_MESSAGE_SNIPPET_CHARS,
        ),
      };
    }),
  };
}

/** One artifact row by id, project-scoped, with its R2 key for the byte read. */
export async function loadMcpArtifact(scope: TenantScope, artifactId: string) {
  const rows = await db
    .select({
      ...ARTIFACT_LIST_COLUMNS,
      testResultId: artifacts.testResultId,
      r2Key: artifacts.r2Key,
    })
    .from(artifacts)
    .where(childByIdWhere(artifacts, scope, artifactId))
    .limit(1);
  return rows[0] ?? null;
}
