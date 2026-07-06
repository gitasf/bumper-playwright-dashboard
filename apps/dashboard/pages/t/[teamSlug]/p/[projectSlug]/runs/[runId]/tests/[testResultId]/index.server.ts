import { defer, defineHandler, type InferProps } from "void";
import { and, asc, db, desc, eq } from "void/db";
import {
  runs,
  testAnnotations,
  testResultAttempts,
  testResults,
  testTags,
} from "@schema";
import { loadQuarantineByTestId } from "@/lib/quarantine-repo";
import { RUN_PUBLIC_COLUMNS } from "@/lib/run-columns";
import {
  childByTestIdWhere,
  childByTestResultWhere,
  runByIdWhere,
} from "@/lib/scope";
import { requireTenantContext } from "@/lib/tenant-context";
import { loadAttemptArtifactGroups } from "@/lib/test-artifact-actions";

export type Props = InferProps<typeof loader>;

const HISTORY_LIMIT = 30;

/**
 * Test detail loader. One async batch:
 *   - the testResults row (404 if it doesn't belong to the supplied run)
 *   - run-level metadata (playwrightVersion for the Environment rail)
 *   - tags + annotations
 *   - per-attempt rows (errorMessage / status)
 *   - last 30 history rows for the same `testId`
 *
 * Artifact presentation (signed download/trace URLs, visual-diff grouping,
 * per-attempt ordering) is owned by `loadAttemptArtifactGroups` — the page
 * receives finished `AttemptArtifactGroup`s. The raw R2 object key and the
 * download tokens are consumed server-side and never serialized to the client.
 */
export const loader = defineHandler(async (c) => {
  const runId = c.req.param("runId");
  const testResultId = c.req.param("testResultId");
  if (!runId || !testResultId) {
    throw new Response("Not Found", { status: 404 });
  }

  const url = new URL(c.req.url);
  const origin = url.origin;

  const { project, scope } = requireTenantContext(c);

  const [resultRows, runRows] = await Promise.all([
    db
      .select()
      .from(testResults)
      .where(
        and(
          eq(testResults.projectId, project.id),
          eq(testResults.id, testResultId),
          eq(testResults.runId, runId),
        ),
      )
      .limit(1),
    db
      .select(RUN_PUBLIC_COLUMNS)
      .from(runs)
      .where(runByIdWhere(scope, runId))
      .limit(1),
  ]);
  const result = resultRows[0];
  const run = runRows[0];

  if (!result || !run) {
    return {
      kind: "not_found" as const,
      project: {
        teamSlug: project.teamSlug,
        projectSlug: project.slug,
      },
      runId,
    };
  }

  // Child reads repeat the projectId predicate even though the parent row was
  // ownership-verified above: the project invariant is that EVERY query
  // against these tables is project-scoped, so a future refactor that loosens
  // the parent probe can't silently turn these into cross-tenant reads.
  //
  // Eager batch: tags + annotations + per-attempt rows + quarantine state —
  // all tiny point/index reads that drive the above-the-fold header, metadata,
  // attempt tabs and error panels. The two costly reads (the bounded history
  // strip and the per-row artifact-signing fan-out) defer below.
  const [tagRows, annotationRows, attemptRows, quarantineRows] =
    await Promise.all([
      db
        .select({ tag: testTags.tag })
        .from(testTags)
        .where(childByTestResultWhere(testTags, scope, testResultId)),
      db
        .select({
          type: testAnnotations.type,
          description: testAnnotations.description,
        })
        .from(testAnnotations)
        .where(childByTestResultWhere(testAnnotations, scope, testResultId)),
      db
        .select({
          attempt: testResultAttempts.attempt,
          status: testResultAttempts.status,
          durationMs: testResultAttempts.durationMs,
          errorMessage: testResultAttempts.errorMessage,
          errorStack: testResultAttempts.errorStack,
        })
        .from(testResultAttempts)
        .where(childByTestResultWhere(testResultAttempts, scope, testResultId))
        .orderBy(asc(testResultAttempts.attempt)),
      // Quarantine state for this test — drives the badge + owner-gated control
      // in the page header. One testId, so at most one row.
      loadQuarantineByTestId(project.id, [result.testId]),
    ]);

  // A deferred loader streams a variant-specific body — set no-store so the
  // browser can't replay the wrong (NDJSON vs HTML) variant.
  c.header("Cache-Control", "private, no-store");
  return {
    kind: "ok" as const,
    project: {
      id: project.id,
      teamSlug: project.teamSlug,
      projectSlug: project.slug,
      // Owner-only quarantine control; non-owners see only the badge.
      canManageQuarantine: project.role === "owner",
    },
    runId,
    testResultId,
    result,
    run,
    // Quarantine state for this test (null = not quarantined) + where to land
    // after the mutation (back on this page). `quarantineError` surfaces a
    // banner when the mutation route bounces back with ?quarantineError=.
    quarantine: quarantineRows[0]
      ? { mode: quarantineRows[0].mode, reason: quarantineRows[0].reason }
      : null,
    quarantineRedirectTo: url.pathname + url.search,
    quarantineError: url.searchParams.get("quarantineError"),
    tags: tagRows,
    annotations: annotationRows,
    attempts: attemptRows,

    // Below-the-fold duration-history strip — a bounded 30-row testId scan,
    // deferred behind the shared RunHistoryChart skeleton.
    history: defer(async () =>
      db
        .select({
          testResultId: testResults.id,
          runId: testResults.runId,
          status: testResults.status,
          durationMs: testResults.durationMs,
          createdAt: testResults.createdAt,
          branch: runs.branch,
          commitSha: runs.commitSha,
        })
        .from(testResults)
        .innerJoin(runs, eq(runs.id, testResults.runId))
        .where(childByTestIdWhere(testResults, scope, result.testId))
        .orderBy(desc(testResults.createdAt))
        .limit(HISTORY_LIMIT),
    ),

    // Server-owned artifact presentation for the right rail: signed URLs +
    // visual grouping + per-attempt ordering. This is the per-row token-signing
    // / SigV4 presign FAN-OUT — the page's most expensive read — so it streams
    // behind the rail skeleton. Raw r2Key / tokens stay inside this call; the
    // page receives finished, serializable AttemptArtifactGroups (Map → array).
    // (Note: dropping the old `maxObservedAttempt` term keeps the eager attempt
    // tab count on `retryCount + 1`, so the left column never reads this.)
    artifacts: defer(async () => {
      const artifactGroupMap = await loadAttemptArtifactGroups(
        scope,
        testResultId,
        origin,
      );
      return { artifactGroups: Array.from(artifactGroupMap.values()) };
    }),
  };
});
