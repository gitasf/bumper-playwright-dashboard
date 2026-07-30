import { ulid } from "ulid";
import { and, db, eq, sql } from "void/db";
import { runs, runShards } from "@schema";
import { postGithubRunSurfaces } from "@/lib/github-run-surfaces";
import { runByIdWhere, type TenantScope } from "@/lib/scope";
import type { CompleteRunPayload } from "@/lib/schemas";
import { RUN_WRITE_GUARD_COLUMNS, runClosedForWrites } from "./lifecycle";
import {
  aggregateRecomputeStatement,
  broadcastRunProgress,
  bumpTeamActivity,
  reconcileAndBroadcast,
  summaryFromBatchResults,
} from "./write-and-publish";

export type CompleteRunOutcome =
  | { kind: "ok"; status: string }
  | { kind: "notFound" }
  | { kind: "runClosed" }
  | { kind: "invalidShard"; expectedShards: number };

const RUN_STATUS_SEVERITY: Record<string, number> = {
  skipped: 0,
  passed: 1,
  flaky: 2,
  interrupted: 3,
  timedout: 4,
  failed: 4,
};
const UNKNOWN_STATUS_SEVERITY = 0;

function runStatusSeverity(status: string): number {
  return RUN_STATUS_SEVERITY[status] ?? UNKNOWN_STATUS_SEVERITY;
}

export function mergeRunStatus(current: string, incoming: string): string {
  if (current === "running") return incoming;
  return runStatusSeverity(incoming) > runStatusSeverity(current)
    ? incoming
    : current;
}

export function worstShardStatus(statuses: readonly string[]): string | null {
  if (statuses.length === 0) return null;
  return statuses.reduce((worst, status) => mergeRunStatus(worst, status));
}

export function currentStatusSeveritySql() {
  let expression = sql`case ${runs.status}`;
  for (const [status, severity] of Object.entries(RUN_STATUS_SEVERITY)) {
    expression = sql`${expression} when ${status} then ${severity}`;
  }
  return sql`(${expression} else ${UNKNOWN_STATUS_SEVERITY} end)`;
}

export function mergeRunStatusSql(incoming: string) {
  const incomingSeverity = runStatusSeverity(incoming);
  return sql`case when ${runs.status} = 'running' then ${incoming} when ${currentStatusSeveritySql()} < ${incomingSeverity} then ${incoming} else ${runs.status} end`;
}

export async function completeRun(
  scope: TenantScope,
  runId: string,
  payload: CompleteRunPayload,
  completedAt: number,
): Promise<CompleteRunOutcome> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const owner = await db
    .select(RUN_WRITE_GUARD_COLUMNS)
    .from(runs)
    .where(runByIdWhere(scope, runId))
    .limit(1);
  if (!owner[0]) return { kind: "notFound" };
  if (runClosedForWrites(owner[0], nowSeconds)) return { kind: "runClosed" };

  const expectedShards =
    owner[0].expectedShards ?? payload.shard?.total ?? null;
  if (expectedShards !== null && expectedShards > 1) {
    if (
      payload.shard &&
      (payload.shard.total !== expectedShards ||
        payload.shard.index < 1 ||
        payload.shard.index > expectedShards)
    ) {
      return { kind: "invalidShard", expectedShards };
    }
    return completeShardedRun(
      scope,
      runId,
      payload,
      completedAt,
      nowSeconds,
      payload.shard,
      expectedShards,
    );
  }

  const summary = await reconcileAndBroadcast(
    runId,
    (tx) =>
      tx
        .update(runs)
        .set({
          status: mergeRunStatusSql(payload.status),
          durationMs: sql`greatest(${runs.durationMs}, ${payload.durationMs})`,
          completedAt: sql`greatest(coalesce(${runs.completedAt}, 0), ${completedAt})`,
          lastActivityAt: nowSeconds,
        })
        .where(runByIdWhere(scope, runId)),
    scope,
  );
  await bumpTeamActivity(scope.teamId, nowSeconds);
  await postGithubRunSurfaces(runId, scope.projectId);
  return { kind: "ok", status: summary?.status ?? payload.status };
}

async function completeShardedRun(
  scope: TenantScope,
  runId: string,
  payload: CompleteRunPayload,
  completedAt: number,
  nowSeconds: number,
  shard: CompleteRunPayload["shard"] | undefined,
  expectedShards: number,
): Promise<CompleteRunOutcome> {
  const { summary, allDone } = await db.transaction(async (tx) => {
    await tx
      .select({ id: runs.id })
      .from(runs)
      .where(runByIdWhere(scope, runId))
      .for("update");

    if (shard) {
      await tx
        .insert(runShards)
        .values({
          id: ulid(),
          projectId: scope.projectId,
          runId,
          shardIndex: shard.index,
          shardTotal: shard.total,
          status: payload.status,
          durationMs: payload.durationMs,
          completedAt,
          createdAt: nowSeconds,
        })
        .onConflictDoUpdate({
          target: [runShards.projectId, runShards.runId, runShards.shardIndex],
          set: {
            status: payload.status,
            durationMs: payload.durationMs,
            completedAt,
            shardTotal: shard.total,
          },
        });
    }

    const shardRows = await tx
      .select({
        status: runShards.status,
        durationMs: runShards.durationMs,
        completedAt: runShards.completedAt,
      })
      .from(runShards)
      .where(
        and(
          eq(runShards.projectId, scope.projectId),
          eq(runShards.runId, runId),
        ),
      );
    const done = shardRows.length >= expectedShards;

    if (done) {
      const finalStatus =
        worstShardStatus(shardRows.map((row) => row.status)) ?? payload.status;
      const maxDuration = shardRows.reduce(
        (maximum, row) => Math.max(maximum, row.durationMs),
        payload.durationMs,
      );
      const maxCompletedAt = shardRows.reduce(
        (maximum, row) => Math.max(maximum, row.completedAt),
        completedAt,
      );
      await tx
        .update(runs)
        .set({
          // Merge rather than overwrite, exactly as the non-sharded path above
          // does. `finalStatus` is derived from the shard rows alone, and the
          // stale-run watchdog writes `interrupted` to the RUN row without
          // touching any shard row. A last shard reporting `passed` inside the
          // 30-minute `runClosedForWrites` grace would otherwise downgrade that
          // terminal marker back to `passed`.
          status: mergeRunStatusSql(finalStatus),
          durationMs: maxDuration,
          completedAt: maxCompletedAt,
          lastActivityAt: nowSeconds,
          expectedShards,
        })
        .where(runByIdWhere(scope, runId));
    } else {
      await tx
        .update(runs)
        .set({ lastActivityAt: nowSeconds })
        .where(runByIdWhere(scope, runId));
    }

    const recomputed = await aggregateRecomputeStatement(
      { projectId: scope.projectId },
      runId,
      tx,
    );
    return { summary: summaryFromBatchResults([recomputed]), allDone: done };
  });

  await bumpTeamActivity(scope.teamId, nowSeconds);
  if (summary) {
    await broadcastRunProgress(runId, scope.projectId, summary);
  }
  if (allDone) {
    await postGithubRunSurfaces(runId, scope.projectId);
  }
  return {
    kind: "ok",
    status: summary?.status ?? (allDone ? payload.status : "running"),
  };
}

export async function finalizeStaleRun(
  run: { id: string; projectId: string; teamId: string },
  completedAt: number,
): Promise<void> {
  const shardRows = await db
    .select({ status: runShards.status })
    .from(runShards)
    .where(
      and(eq(runShards.projectId, run.projectId), eq(runShards.runId, run.id)),
    );
  const finalStatus =
    worstShardStatus([...shardRows.map((row) => row.status), "interrupted"]) ??
    "interrupted";
  await reconcileAndBroadcast(
    run.id,
    (tx) =>
      tx
        .update(runs)
        .set({
          status: finalStatus,
          completedAt,
          lastActivityAt: completedAt,
        })
        .where(
          and(
            eq(runs.projectId, run.projectId),
            eq(runs.id, run.id),
            eq(runs.status, "running"),
          ),
        ),
    { projectId: run.projectId },
    { requireStatusFlip: true },
  );
  await postGithubRunSurfaces(run.id, run.projectId);
}
