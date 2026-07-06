import { defineHandler } from "void";
import { and, db, desc, eq } from "void/db";
import { artifacts } from "@schema";
import {
  signArtifactToken,
  signedDownloadHref,
  signedTraceViewerUrl,
} from "@/lib/artifact-tokens";
import { childByTestResultWhere } from "@/lib/scope";
import { resolveTenantApiScope } from "@/lib/tenant-api-scope";

export type TestReplayResponse = {
  /** Self-hosted trace-viewer URL with a freshly-signed `?trace=` token. */
  traceViewerUrl: string;
  /** Signed direct download of the raw `trace.zip`. */
  downloadHref: string;
};

/**
 * GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/tests/:testResultId/replay
 *
 * Lazily mints a Test Replay (trace-viewer) URL for one test. The run's live
 * test list (`RunProgress`) is a realtime island carrying only minimal per-test
 * rows — no artifact rows, no signed URLs — so the "Test Replay" button on each
 * row fetches here on click. Minting on demand (rather than pre-signing every
 * row in the SSR loader) keeps the download token fresh (1h TTL) and avoids
 * embedding a token per test in the page.
 *
 * Returns the trace of the LAST attempt (highest `attempt`) — the final,
 * authoritative run of the test. 404 when the test recorded no trace (e.g. a
 * passed test under the reporter's default `artifacts: "failed"` mode).
 */
export const GET = defineHandler(async (c) => {
  const ctx = await resolveTenantApiScope(c, { requireTestResultId: true });
  if (ctx instanceof Response) return ctx;
  const { scope, testResultId } = ctx;

  const rows = await db
    .select({
      id: artifacts.id,
      r2Key: artifacts.r2Key,
      contentType: artifacts.contentType,
    })
    .from(artifacts)
    .where(
      and(
        childByTestResultWhere(artifacts, scope, testResultId),
        eq(artifacts.type, "trace"),
      ),
    )
    .orderBy(desc(artifacts.attempt))
    .limit(1);

  const row = rows[0];
  if (!row) return c.json({ error: "No trace recorded for this test" }, 404);

  const token = await signArtifactToken({
    r2Key: row.r2Key,
    contentType: row.contentType,
  });
  const origin = new URL(c.req.url).origin;
  c.header("Cache-Control", "private, no-store");
  return {
    traceViewerUrl: signedTraceViewerUrl(origin, row.id, token),
    downloadHref: signedDownloadHref(row.id, token),
  } satisfies TestReplayResponse;
});
