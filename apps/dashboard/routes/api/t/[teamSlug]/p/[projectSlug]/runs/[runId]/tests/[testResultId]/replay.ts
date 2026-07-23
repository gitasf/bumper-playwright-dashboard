import { defineHandler } from "void";
import { and, asc, db, eq } from "void/db";
import { artifacts, testResults } from "@schema";
import {
  signArtifactDownloadToken,
  signedDownloadHref,
} from "@/lib/artifacts/tokens";
import { childByTestResultWhere, childProjectScopeWhere } from "@/lib/scope";
import { resolveTenantApiScope } from "@/lib/tenant-api-scope";
import { selectReplayTracesByAttempt } from "@/lib/artifacts/trace";

export type TestReplayResponse = {
  /** The test's title, so a deep-linked modal can render its header. */
  title: string;
  /**
   * Every attempt that recorded a trace, ascending by `attempt` (0-based),
   * non-empty. Drives the modal's attempt switcher when a test retried (the
   * modal defaults to the LAST — final, authoritative — attempt); the viewer's
   * service worker range-reads the signed `downloadHref` (`trace.zip`) itself.
   */
  attempts: Array<{
    attempt: number;
    downloadHref: string;
  }>;
};

/**
 * GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/tests/:testResultId/replay
 *
 * Lazily mints Replay (trace-viewer) URLs for one test — one per attempt that
 * recorded a trace (there are at most a handful of retries). The run's
 * Tests-tab list carries only minimal per-test rows — no artifact rows, no
 * signed URLs — so the per-row "Replay" button (and any
 * `?replay=<testResultId>` deep-link) fetches here. Minting on demand (rather
 * than pre-signing every row in the loader) keeps the download tokens fresh
 * and avoids embedding one per test in the page.
 *
 * Every trace token is signed through the canonical artifact lifetime policy,
 * which grants replayable traces a longer lifetime because the viewer's
 * service worker range-reads them lazily throughout the session.
 *
 * 404 when the test recorded no trace at all (e.g. a passed test under the
 * reporter's default `artifacts: "failed"` mode).
 */
export const GET = defineHandler(async (c) => {
  const ctx = await resolveTenantApiScope(c, { requireTestResultId: true });
  if (ctx instanceof Response) return ctx;
  const { scope, testResultId } = ctx;

  const rows = await db
    .select({
      id: artifacts.id,
      name: artifacts.name,
      type: artifacts.type,
      r2Key: artifacts.r2Key,
      contentType: artifacts.contentType,
      attempt: artifacts.attempt,
    })
    .from(artifacts)
    .where(
      and(
        childByTestResultWhere(artifacts, scope, testResultId),
        eq(artifacts.type, "trace"),
      ),
    )
    .orderBy(asc(artifacts.attempt));

  const traces = selectReplayTracesByAttempt(rows);

  if (traces.length === 0) {
    return c.json({ error: "No trace recorded for this test" }, 404);
  }

  // The test title for the modal header (the rows already scoped the
  // artifacts, so this is the same project + the test's own id).
  const titleRow = await db
    .select({ title: testResults.title })
    .from(testResults)
    .where(
      and(
        childProjectScopeWhere(testResults.projectId, scope),
        eq(testResults.id, testResultId),
      ),
    )
    .limit(1);

  // One entry per recorded trace (rows are already ascending by attempt);
  // each attempt gets its own freshly-signed token.
  const attempts = await Promise.all(
    traces.map(async (row) => {
      const { token } = await signArtifactDownloadToken(row);
      return {
        attempt: row.attempt,
        downloadHref: signedDownloadHref(row.id, token),
      };
    }),
  );

  c.header("Cache-Control", "private, no-store");
  return {
    title: titleRow[0]?.title ?? "Trace",
    attempts,
  } satisfies TestReplayResponse;
});
