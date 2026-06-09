import { and, db, eq } from "void/db";
import { projects, runs, teams } from "@schema";
import { makeTenantScope, type TenantScope } from "@/lib/scope";
import type { TerminalExecutionState } from "@/lib/monitors/types";

/**
 * Shared "link an execution to its run" helpers for the two `MonitorExecutor`
 * implementations. DB-bound (imports `void/db`) — integration-only, NOT unit
 * tested (the harness's `void/db` stub throws on use).
 *
 * Both executors guarantee the same invariant: for a browser execution there is
 * a `runs` row whose `idempotencyKey === execution.id`. The `SandboxExecutor`
 * gets it because the in-container reporter opens the run with
 * `WRIGHTFUL_IDEMPOTENCY_KEY = execution.id`; the `StubExecutor` gets it because
 * it calls `openRun` directly with that key. So both resolve the produced run —
 * and map its terminal status into a monitor `state` — through this one module,
 * instead of each re-deriving the `(projectId, idempotencyKey)` lookup and the
 * status mapping (which would be two places to drift).
 */

/**
 * Build a `TenantScope` for a monitor execution that never crossed a user
 * request. The scheduler wrote the monitor's `teamId` / `projectId` under a
 * branded insert, so the row is trusted; we recover the `teamSlug` /
 * `projectSlug` the ingest lib + reporter run URL need with one indexed join,
 * then launder through `makeTenantScope` (the single sanctioned brand boundary,
 * same as `tenantScopeForApiKey`). Throws if the project was deleted between
 * enqueue and execution — the caller maps that to an infra-error result.
 */
export async function tenantScopeForMonitor(monitor: {
  teamId: string;
  projectId: string;
}): Promise<TenantScope> {
  const rows = await db
    .select({ teamSlug: teams.slug, projectSlug: projects.slug })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .where(eq(projects.id, monitor.projectId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(
      `monitor project ${monitor.projectId} not found while resolving scope`,
    );
  }
  return makeTenantScope({
    teamId: monitor.teamId,
    projectId: monitor.projectId,
    teamSlug: row.teamSlug,
    projectSlug: row.projectSlug,
  });
}

/**
 * The run-status → monitor-execution-state mapping, per the LINKING design:
 *   passed                → "pass"
 *   failed | timedout      → "fail"
 *   interrupted | anything → "error"  (a run that never reached a clean
 *     pass/fail terminal is an infra/abort outcome, not an app-level "site
 *     down" we'd want to surface as a normal fail).
 *
 * Single owner of this table so the stub and sandbox executors can't disagree
 * about how a given run status reads on the monitor timeline.
 */
export function runStatusToExecutionState(
  status: string,
): TerminalExecutionState {
  switch (status) {
    case "passed":
      return "pass";
    case "failed":
    case "timedout":
      return "fail";
    default:
      return "error";
  }
}

/** The run identity an executor needs after a check finishes. */
export interface LinkedRun {
  id: string;
  status: string;
  durationMs: number;
}

/**
 * Resolve the run a synthetic execution produced, by its idempotency key
 * (`= execution.id`) within the project. Returns null when no run was opened —
 * e.g. the container died before the reporter's `onBegin` ever reached
 * `/api/runs`, which the caller treats as an infra error (the check did not
 * even start streaming).
 */
export async function findRunByIdempotencyKey(
  scope: TenantScope,
  idempotencyKey: string,
): Promise<LinkedRun | null> {
  const rows = await db
    .select({
      id: runs.id,
      status: runs.status,
      durationMs: runs.durationMs,
    })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, scope.projectId),
        eq(runs.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
