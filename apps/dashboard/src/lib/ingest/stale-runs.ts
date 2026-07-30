import { db } from "void/db";
import { logger } from "void/log";
import { runs } from "@schema";
import { staleRunFilter } from "@/lib/scope";
import { finalizeStaleRun } from "./finalization";
import { chunkBySize } from "@/lib/db/chunk";

export interface SweepStaleRunsResult {
  found: number;
  finalized: number;
  failed: number;
}

const STALE_RUN_FINALIZE_CONCURRENCY = 10;

export async function drainStaleRuns<T extends { id: string }>(
  staleRuns: T[],
  finalize: (run: T) => Promise<void>,
  opts: { chunkSize: number; onError?: (run: T, err: unknown) => void },
): Promise<SweepStaleRunsResult> {
  let finalized = 0;
  let failed = 0;
  for (const chunk of chunkBySize(staleRuns, opts.chunkSize)) {
    const settled = await Promise.allSettled(chunk.map((run) => finalize(run)));
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        finalized++;
      } else {
        failed++;
        opts.onError?.(chunk[index]!, result.reason);
      }
    });
  }
  return { found: staleRuns.length, finalized, failed };
}

export async function sweepStaleRuns(opts: {
  cutoffSeconds: number;
  limit: number;
  now: number;
}): Promise<SweepStaleRunsResult> {
  const stale = await db
    .select({ id: runs.id, projectId: runs.projectId, teamId: runs.teamId })
    .from(runs)
    .where(staleRunFilter(opts.cutoffSeconds))
    .limit(opts.limit);

  return drainStaleRuns(stale, (run) => finalizeStaleRun(run, opts.now), {
    chunkSize: STALE_RUN_FINALIZE_CONCURRENCY,
    onError: (run, err) => {
      logger.error("failed to finalize stale run", {
        runId: run.id,
        projectId: run.projectId,
        message: err instanceof Error ? err.message : String(err),
      });
    },
  });
}
