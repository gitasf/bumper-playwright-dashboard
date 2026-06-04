import { defineHandler, type InferProps } from "void";
import { and, asc, db, desc, eq } from "void/db";
import {
  artifacts,
  runs,
  testAnnotations,
  testResultAttempts,
  testResults,
  testTags,
} from "@schema";
import { signArtifactToken } from "@/lib/artifact-tokens";
import { runByIdWhere } from "@/lib/scope";
import { requireTenantContext } from "@/lib/tenant-context";

export type Props = InferProps<typeof loader>;

const HISTORY_LIMIT = 30;

interface ArtifactRow {
  id: string;
  type: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  attempt: number;
  r2Key: string;
  role: string | null;
  snapshotName: string | null;
}

/**
 * Test detail loader. One async batch:
 *   - the testResults row (404 if it doesn't belong to the supplied run)
 *   - run-level metadata (playwrightVersion for the Environment rail)
 *   - tags + annotations
 *   - artifacts (grouped + sorted client-side)
 *   - per-attempt rows (errorMessage / status)
 *   - last 30 history rows for the same `testId`
 *
 * Artifact URLs are signed server-side — we hand the page a precomputed
 * map of artifactId → token so the client can build short-lived
 * download/trace-viewer URLs without making a round-trip.
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
    db.select().from(runs).where(runByIdWhere(scope, runId)).limit(1),
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

  const [tagRows, annotationRows, artifactRows, attemptRows, historyRows] =
    await Promise.all([
      db
        .select({ tag: testTags.tag })
        .from(testTags)
        .where(eq(testTags.testResultId, testResultId)),
      db
        .select({
          type: testAnnotations.type,
          description: testAnnotations.description,
        })
        .from(testAnnotations)
        .where(eq(testAnnotations.testResultId, testResultId)),
      db
        .select({
          id: artifacts.id,
          type: artifacts.type,
          name: artifacts.name,
          contentType: artifacts.contentType,
          sizeBytes: artifacts.sizeBytes,
          attempt: artifacts.attempt,
          r2Key: artifacts.r2Key,
          role: artifacts.role,
          snapshotName: artifacts.snapshotName,
        })
        .from(artifacts)
        .where(eq(artifacts.testResultId, testResultId))
        .orderBy(asc(artifacts.attempt)),
      db
        .select({
          attempt: testResultAttempts.attempt,
          status: testResultAttempts.status,
          durationMs: testResultAttempts.durationMs,
          errorMessage: testResultAttempts.errorMessage,
          errorStack: testResultAttempts.errorStack,
        })
        .from(testResultAttempts)
        .where(eq(testResultAttempts.testResultId, testResultId))
        .orderBy(asc(testResultAttempts.attempt)),
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
        .where(
          and(
            eq(testResults.projectId, project.id),
            eq(testResults.testId, result.testId),
          ),
        )
        .orderBy(desc(testResults.createdAt))
        .limit(HISTORY_LIMIT),
    ]);

  // Precompute artifact tokens server-side so the client doesn't need to
  // request them one-by-one. Same TTL semantics as the rwsdk version.
  const artifactTokens: Record<string, string> = {};
  await Promise.all(
    artifactRows.map(async (a) => {
      artifactTokens[a.id] = await signArtifactToken({
        r2Key: a.r2Key,
        contentType: a.contentType,
      });
    }),
  );

  return {
    kind: "ok" as const,
    project: {
      id: project.id,
      teamSlug: project.teamSlug,
      projectSlug: project.slug,
    },
    runId,
    testResultId,
    result,
    run,
    tags: tagRows,
    annotations: annotationRows,
    artifacts: artifactRows satisfies ArtifactRow[],
    attempts: attemptRows,
    history: historyRows,
    artifactTokens,
    origin,
  };
});
