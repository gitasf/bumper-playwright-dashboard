import { ulid } from "ulid";
import { and, db, eq, sql } from "void/db";
import { env } from "void/env";
import { logger } from "void/log";
import { runs } from "@schema";
import { isForeignKeyViolation, isUniqueViolation } from "@/lib/db/batch";
import { setCodeownersFile } from "@/lib/owners-repo";
import { runByIdWhere, type TenantScope } from "@/lib/scope";
import {
  monthStartSeconds,
  usageBumpStatement,
  usageGuardedBumpStatement,
} from "@/lib/usage";
import { broadcastProjectRoom } from "@/realtime/publish";
import type { OpenRunPayload } from "@/lib/schemas";
import type { ProjectFeedEvent } from "@/realtime/events";
import {
  broadcastRunUpdate,
  buildQueuePrefillStatements,
  buildTestCatalogUpsertStatements,
  bumpTeamActivity,
  type RunAggregateSummary,
} from "./write-and-publish";

/**
 * Best-effort CODEOWNERS capture from an `openRun` payload. Failures are logged
 * and swallowed on purpose: ownership metadata is a convenience for the run
 * views, and a codeowners write must never fail the run open that carries it.
 */
async function maybeUpdateCodeowners(
  scope: TenantScope,
  codeowners: string | undefined,
  nowSeconds: number,
): Promise<void> {
  if (typeof codeowners !== "string" || codeowners.trim().length === 0) return;
  try {
    await setCodeownersFile(scope, codeowners, nowSeconds);
  } catch (err) {
    logger.error("update codeowners from ingest failed", {
      projectId: scope.projectId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface OpenRunResult {
  runId: string;
  duplicate: boolean;
  /** The key already belongs to a completed execution and cannot be reopened. */
  terminalDuplicate?: boolean;
}

export class RunQuotaOvershootError extends Error {
  constructor(readonly limit: number) {
    super("run quota exceeded");
    this.name = "RunQuotaOvershootError";
  }
}

export class RunRowCapExceededError extends Error {
  constructor(
    readonly limit: number,
    readonly count: number,
  ) {
    super("planned-test set exceeds the per-run test-result ceiling");
    this.name = "RunRowCapExceededError";
  }
}

export const RUN_WRITE_GRACE_SECONDS = 30 * 60;

export function runClosedForWrites(
  run: {
    status: string;
    completedAt: number | null;
    lastActivityAt: number | null;
  },
  nowSeconds: number,
): boolean {
  if (run.status === "running") return false;
  if (run.completedAt === null) return false;
  const lastWrite = Math.max(run.completedAt, run.lastActivityAt ?? 0);
  return nowSeconds - lastWrite > RUN_WRITE_GRACE_SECONDS;
}

export const RUN_WRITE_GUARD_COLUMNS = {
  id: runs.id,
  status: runs.status,
  completedAt: runs.completedAt,
  lastActivityAt: runs.lastActivityAt,
  expectedShards: runs.expectedShards,
  totalTests: runs.totalTests,
} as const;

function expectedTestsFromOpenPayload(payload: OpenRunPayload): number {
  return (
    payload.run.expectedTotalTests ?? (payload.run.plannedTests ?? []).length
  );
}

/**
 * Refresh a duplicate only while it is still running.
 *
 * Returns false if a completion won the race after `openRun`'s initial probe.
 * The caller then reports a terminal duplicate instead of accepting a colliding
 * execution whose refresh silently matched no rows.
 */
export async function reopenRunForWrites(
  scope: TenantScope,
  runId: string,
  nowSeconds: number,
  payload: OpenRunPayload,
): Promise<boolean> {
  const shard = payload.shard;
  if (!shard) {
    const refreshed = await db
      .update(runs)
      .set({ lastActivityAt: nowSeconds })
      .where(and(runByIdWhere(scope, runId), eq(runs.status, "running")))
      .returning({ id: runs.id });
    return refreshed.length > 0;
  }
  return applyShardExpectedTests(
    scope,
    runId,
    shard,
    expectedTestsFromOpenPayload(payload),
    nowSeconds,
  );
}

export async function applyShardExpectedTests(
  scope: TenantScope,
  runId: string,
  shard: { index: number; total: number },
  expectedTests: number,
  nowSeconds: number,
): Promise<boolean> {
  const baseMap = sql`coalesce(${runs.shardExpectedTests}, '{}'::jsonb)`;
  const mergedMap = sql`jsonb_set(${baseMap}, array[${String(shard.index)}], to_jsonb(cast(${expectedTests} as integer)))`;
  return db.transaction(async (tx) => {
    await tx
      .select({ id: runs.id })
      .from(runs)
      .where(runByIdWhere(scope, runId))
      .for("update");
    const refreshed = await tx
      .update(runs)
      .set({
        shardExpectedTests: mergedMap,
        expectedTotalTests: sql`cast((select sum(cast(value as integer)) from jsonb_each_text(${mergedMap})) as integer)`,
        expectedShards: sql`coalesce(${runs.expectedShards}, cast(${shard.total} as integer))`,
        lastActivityAt: nowSeconds,
      })
      .where(and(runByIdWhere(scope, runId), eq(runs.status, "running")))
      .returning({ id: runs.id });
    return refreshed.length > 0;
  });
}

export function buildRunInsertValues(
  runId: string,
  scope: TenantScope,
  payload: OpenRunPayload,
  nowSeconds: number,
): typeof runs.$inferInsert {
  const plannedTests = payload.run.plannedTests ?? [];
  return {
    id: runId,
    teamId: scope.teamId,
    projectId: scope.projectId,
    idempotencyKey: payload.idempotencyKey,
    ciProvider: payload.run.ciProvider ?? null,
    ciBuildId: payload.run.ciBuildId ?? null,
    branch: payload.run.branch ?? null,
    environment: payload.run.environment ?? null,
    commitSha: payload.run.commitSha ?? null,
    commitMessage: payload.run.commitMessage ?? null,
    prNumber: payload.run.prNumber ?? null,
    repo: payload.run.repo ?? null,
    actor: payload.run.actor ?? null,
    totalTests: plannedTests.length,
    expectedTotalTests: expectedTestsFromOpenPayload(payload),
    shardExpectedTests: payload.shard
      ? { [String(payload.shard.index)]: expectedTestsFromOpenPayload(payload) }
      : null,
    expectedShards: payload.shard?.total ?? null,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    durationMs: 0,
    status: "running",
    reporterVersion: payload.run.reporterVersion ?? null,
    playwrightVersion: payload.run.playwrightVersion ?? null,
    origin: payload.run.origin ?? "ci",
    monitorId: payload.run.monitorId ?? null,
    createdAt: nowSeconds,
    lastActivityAt: nowSeconds,
    completedAt: null,
  };
}

export function backdatingAllowed(): boolean {
  return Boolean(import.meta.env?.VITE_IS_DEV_SERVER);
}

function terminalDuplicate(runId: string): OpenRunResult {
  return { runId, duplicate: true, terminalDuplicate: true };
}

export async function openRun(
  scope: TenantScope,
  payload: OpenRunPayload,
  nowSeconds: number,
  opts: { runsQuotaLimit?: number } = {},
): Promise<OpenRunResult> {
  await maybeUpdateCodeowners(scope, payload.codeowners, nowSeconds);

  const existing = await db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, scope.projectId),
        eq(runs.idempotencyKey, payload.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing[0]) {
    if (existing[0].status !== "running") {
      return terminalDuplicate(existing[0].id);
    }
    const reopened = await reopenRunForWrites(
      scope,
      existing[0].id,
      nowSeconds,
      payload,
    );
    return reopened
      ? { runId: existing[0].id, duplicate: true }
      : terminalDuplicate(existing[0].id);
  }

  const runId = ulid();
  const plannedTests = payload.run.plannedTests ?? [];
  const rowCap = env.WRIGHTFUL_MAX_TEST_RESULTS_PER_RUN;
  if (rowCap > 0 && plannedTests.length > rowCap) {
    throw new RunRowCapExceededError(rowCap, plannedTests.length);
  }

  const runValues = buildRunInsertValues(runId, scope, payload, nowSeconds);
  const runsQuotaLimit = opts.runsQuotaLimit;
  const enforceRuns =
    runsQuotaLimit !== undefined && Number.isFinite(runsQuotaLimit);
  const runOpenBatch = () =>
    db.transaction(async (tx) => {
      await tx.insert(runs).values(runValues);
      for (const statement of buildQueuePrefillStatements(
        scope,
        runId,
        plannedTests,
        nowSeconds,
        tx,
        payload.shard?.index ?? null,
      )) {
        await statement;
      }
      for (const statement of buildTestCatalogUpsertStatements(
        scope,
        plannedTests,
        nowSeconds,
        tx,
      )) {
        await statement;
      }
      if (enforceRuns) {
        const applied = await usageGuardedBumpStatement(
          scope.teamId,
          monthStartSeconds(nowSeconds),
          { runs: 1 },
          { dimension: "runs", limit: runsQuotaLimit },
          nowSeconds,
          tx,
        );
        if (applied.length === 0) {
          throw new RunQuotaOvershootError(runsQuotaLimit);
        }
      } else {
        const usageBump = usageBumpStatement(
          scope.teamId,
          monthStartSeconds(nowSeconds),
          { runs: 1 },
          nowSeconds,
          tx,
        );
        if (usageBump) await usageBump;
      }
    });

  const recoverDuplicate = async (): Promise<OpenRunResult | null> => {
    const winner = await db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(
        and(
          eq(runs.projectId, scope.projectId),
          eq(runs.idempotencyKey, payload.idempotencyKey),
        ),
      )
      .limit(1);
    if (!winner[0]) return null;
    if (winner[0].status !== "running") {
      return terminalDuplicate(winner[0].id);
    }
    const reopened = await reopenRunForWrites(
      scope,
      winner[0].id,
      nowSeconds,
      payload,
    );
    return reopened
      ? { runId: winner[0].id, duplicate: true }
      : terminalDuplicate(winner[0].id);
  };

  try {
    await runOpenBatch();
  } catch (err) {
    if (isForeignKeyViolation(err) && runValues.monitorId != null) {
      logger.warn(
        "synthetic run's monitor deleted mid-open; nulling monitorId",
        { runId, monitorId: runValues.monitorId },
      );
      runValues.monitorId = null;
      try {
        await runOpenBatch();
      } catch (retryErr) {
        if (!isUniqueViolation(retryErr)) throw retryErr;
        const duplicate = await recoverDuplicate();
        if (!duplicate) throw retryErr;
        return duplicate;
      }
    } else if (isUniqueViolation(err)) {
      const duplicate = await recoverDuplicate();
      if (!duplicate) throw err;
      return duplicate;
    } else {
      throw err;
    }
  }

  await bumpTeamActivity(scope.teamId, nowSeconds);
  const summary: RunAggregateSummary = {
    totalTests: plannedTests.length,
    expectedTotalTests: runValues.expectedTotalTests ?? null,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    durationMs: 0,
    status: "running",
    completedAt: null,
  };
  await broadcastRunUpdate(runId, [], summary);

  const createdEvent: ProjectFeedEvent = {
    type: "run-created",
    run: {
      id: runId,
      origin: payload.run.origin ?? "ci",
      status: "running",
      passed: 0,
      failed: 0,
      flaky: 0,
      skipped: 0,
      totalTests: plannedTests.length,
      expectedTotalTests: runValues.expectedTotalTests ?? null,
      durationMs: 0,
      completedAt: null,
      createdAt: nowSeconds,
      branch: payload.run.branch ?? null,
      prNumber: payload.run.prNumber ?? null,
      commitSha: payload.run.commitSha ?? null,
      commitMessage: payload.run.commitMessage ?? null,
      environment: payload.run.environment ?? null,
      actor: payload.run.actor ?? null,
      ciProvider: payload.run.ciProvider ?? null,
      repo: payload.run.repo ?? null,
    },
  };
  await broadcastProjectRoom(scope.projectId, createdEvent);
  return { runId, duplicate: false };
}
