import { and, asc, db, eq, inArray } from "void/db";
import { artifacts } from "@schema";
import type { ArtifactAction } from "@/components/artifact-actions";
import {
  signArtifactToken,
  signedDownloadHref,
  signedTraceViewerUrl,
} from "@/lib/artifact-tokens";
import type { TenantScope } from "@/lib/scope";

// Order within an attempt: trace first (most useful for debugging), then
// video, screenshot, everything else. `other` covers error-context /
// copy-prompt artifacts that aren't rendered in the action row.
const TYPE_ORDER: Record<string, number> = {
  trace: 0,
  video: 1,
  screenshot: 2,
  other: 3,
};

/**
 * Which attempt carries the error for a test with the given final status
 * and total number of attempts. Shared by the test detail page (per-attempt
 * errors) and the run detail page (single error block per failing test).
 *
 *  - `failed` / `timedout` → last attempt
 *  - `flaky` → first attempt (the passing retry isn't where the error lives)
 *  - otherwise → null (no error to show)
 */
export function errorAttempt(
  finalStatus: string,
  totalAttempts: number,
): number | null {
  if (finalStatus === "failed" || finalStatus === "timedout") {
    return totalAttempts - 1;
  }
  if (finalStatus === "flaky") return 0;
  return null;
}

export interface ArtifactRow {
  id: string;
  testResultId: string;
  type: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  attempt: number;
  r2Key: string;
}

/**
 * Convert a raw artifact row into the client-facing `ArtifactAction` the UI
 * renders. Shared between `test-detail.tsx` (per-attempt, all types) and
 * `run-detail.tsx` (failing-attempt, media types).
 */
export function toArtifactAction(
  row: Pick<ArtifactRow, "id" | "type" | "name" | "contentType">,
  origin: string,
  token: string,
): ArtifactAction {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    contentType: row.contentType,
    downloadHref: signedDownloadHref(row.id, token),
    traceViewerUrl:
      row.type === "trace"
        ? signedTraceViewerUrl(origin, row.id, token)
        : undefined,
  };
}

export interface FailingTestInput {
  id: string;
  status: string;
  retryCount: number;
}

/**
 * Load media artifacts (`trace`, `video`, `screenshot`) for the failing
 * attempt of each supplied test result. Returns a map keyed by
 * `testResultId` with already-signed `ArtifactAction[]`, sorted by
 * `TYPE_ORDER` then name.
 */
export async function loadFailingArtifactActions(
  scope: TenantScope,
  failingTests: FailingTestInput[],
  origin: string,
): Promise<Record<string, ArtifactAction[]>> {
  const relevant = failingTests.filter(
    (t) =>
      t.status === "failed" || t.status === "timedout" || t.status === "flaky",
  );
  if (relevant.length === 0) return {};

  const rows = await db
    .select({
      id: artifacts.id,
      testResultId: artifacts.testResultId,
      type: artifacts.type,
      name: artifacts.name,
      contentType: artifacts.contentType,
      attempt: artifacts.attempt,
      r2Key: artifacts.r2Key,
    })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.projectId, scope.projectId),
        inArray(
          artifacts.testResultId,
          relevant.map((t) => t.id),
        ),
      ),
    )
    .orderBy(asc(artifacts.attempt));

  // Group artifacts by testResultId.
  const byTest = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = byTest.get(row.testResultId) ?? [];
    bucket.push(row);
    byTest.set(row.testResultId, bucket);
  }

  const out: Record<string, ArtifactAction[]> = {};
  await Promise.all(
    relevant.map(async (t) => {
      const bucket = byTest.get(t.id) ?? [];
      if (bucket.length === 0) return;
      const maxObservedAttempt = Math.max(...bucket.map((a) => a.attempt));
      const totalAttempts = Math.max(t.retryCount + 1, maxObservedAttempt + 1);
      const target = errorAttempt(t.status, totalAttempts);
      if (target === null) return;
      const forAttempt = bucket
        .filter(
          (a) =>
            a.attempt === target && a.type !== "other" && a.type !== "visual",
        )
        .sort((x, y) => {
          const dx = TYPE_ORDER[x.type] ?? 99;
          const dy = TYPE_ORDER[y.type] ?? 99;
          if (dx !== dy) return dx - dy;
          return x.name.localeCompare(y.name);
        });
      if (forAttempt.length === 0) return;
      const actions = await Promise.all(
        forAttempt.map(async (a) => {
          const token = await signArtifactToken({
            r2Key: a.r2Key,
            contentType: a.contentType,
          });
          return toArtifactAction(a, origin, token);
        }),
      );
      out[t.id] = actions;
    }),
  );
  return out;
}
