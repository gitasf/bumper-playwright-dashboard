import { and, db, eq, inArray } from "void/db";
import { artifacts } from "@schema";
import { childProjectScopeWhere, type TenantScope } from "@/lib/scope";
import {
  isReplayTraceArtifact,
  REPLAY_TRACE_ARTIFACT_NAMES,
} from "@/lib/artifacts/trace";
import type { RunProgressTest } from "@/realtime/run-progress";

/**
 * Enrich a page of test rows with `hasTrace` — whether each test recorded a
 * `trace` artifact — so the run's Tests-tab list can gate its per-row "Replay"
 * button. One batched distinct-id query over just the page's ids.
 *
 * This is a UI-only concern (it gates a button) and deliberately lives OUTSIDE
 * the shared `loadRunResultsPage`, which also feeds the public `/api/v1/*`,
 * CSV export, and MCP surfaces — `hasTrace` doesn't belong in those contracts.
 * It's applied only by the run-detail `…/results` route. Artifacts register in
 * a flush AFTER the results post, so trace-presence can't ride the realtime
 * event; it's minted on the paginated read (see `RunProgressTest.hasTrace`).
 */
export async function attachHasTrace(
  scope: TenantScope,
  rows: readonly RunProgressTest[],
): Promise<RunProgressTest[]> {
  if (rows.length === 0) return [...rows];
  const ids = rows.map((r) => r.id);
  const candidates = await db
    .selectDistinct({
      testResultId: artifacts.testResultId,
      type: artifacts.type,
      name: artifacts.name,
      contentType: artifacts.contentType,
    })
    .from(artifacts)
    .where(
      and(
        childProjectScopeWhere(artifacts.projectId, scope),
        eq(artifacts.type, "trace"),
        inArray(artifacts.name, REPLAY_TRACE_ARTIFACT_NAMES),
        inArray(artifacts.testResultId, ids),
      ),
    );
  const traced = new Set(
    candidates
      .filter(isReplayTraceArtifact)
      .map((candidate) => candidate.testResultId),
  );
  return rows.map((r) => ({ ...r, hasTrace: traced.has(r.id) }));
}
