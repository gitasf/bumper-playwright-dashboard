import { defineHandler } from "void";
import { and, asc, db, eq, inArray } from "void/db";
import { testResults } from "@schema";
import { resolveTenantApiScope } from "@/lib/tenant-api-scope";

const PREVIEW_LIMIT = 5;

export type TestPreviewItem = {
  id: string;
  title: string;
  file: string;
  projectName: string | null;
  status: string;
  errorMessage: string | null;
};

export type TestPreviewResponse = {
  failed: TestPreviewItem[];
  flaky: TestPreviewItem[];
  passed: TestPreviewItem[];
  skipped: TestPreviewItem[];
};

type BucketKey = keyof TestPreviewResponse;

const BUCKETS: Array<{ key: BucketKey; statuses: string[] }> = [
  { key: "failed", statuses: ["failed", "timedout"] },
  { key: "flaky", statuses: ["flaky"] },
  { key: "passed", statuses: ["passed"] },
  { key: "skipped", statuses: ["skipped"] },
];

/**
 * GET /api/t/:teamSlug/p/:projectSlug/runs/:runId/test-preview
 *
 * Returns up to 5 test results per category (failed/flaky/passed/skipped)
 * for the given run. Used by the runs list badge popovers.
 */
export const GET = defineHandler(async (c) => {
  const ctx = await resolveTenantApiScope(c);
  if (ctx instanceof Response) return ctx;
  const { scope, runId } = ctx;

  const buckets = await Promise.all(
    BUCKETS.map((bucket) =>
      db
        .select({
          id: testResults.id,
          title: testResults.title,
          file: testResults.file,
          projectName: testResults.projectName,
          status: testResults.status,
          errorMessage: testResults.errorMessage,
        })
        .from(testResults)
        .where(
          and(
            eq(testResults.projectId, scope.projectId),
            eq(testResults.runId, runId),
            inArray(testResults.status, bucket.statuses),
          ),
        )
        .orderBy(asc(testResults.file), asc(testResults.title))
        .limit(PREVIEW_LIMIT),
    ),
  );

  const body: TestPreviewResponse = {
    failed: buckets[0],
    flaky: buckets[1],
    passed: buckets[2],
    skipped: buckets[3],
  };
  c.header("Cache-Control", "private, max-age=15");
  return body;
});
