import { ulid } from "ulid";
import { and, asc, db, eq, inArray } from "void/db";
import { quarantinedTests } from "@schema";
import type { QuarantinedTest } from "@schema";
import {
  childByTestIdWhere,
  childProjectScopeWhere,
  type TenantScope,
} from "@/lib/scope";
import type { QuarantineMode } from "@/lib/quarantine-schemas";

/**
 * The D1 data layer for the flaky-test quarantine list — the deep module the
 * page mutations (session-authed, owner-gated), the page-badge join, and the
 * Bearer ingest route (`GET /api/runs/quarantine`) all speak to.
 *
 * Like `monitors-repo`, every query carries `projectId` for logical tenant
 * isolation — there is no DO boundary, so scoping each query by the branded
 * `TenantScope` projectId is what keeps a quarantine row from leaking across
 * projects. Ids are ULIDs and timestamps are epoch SECONDS, matching `monitors`.
 *
 * `loadQuarantineByTestId` is the one trusted-id reader: it scopes by a passed
 * `projectId` (already auth-checked by the caller's `TenantScope`) so the flaky
 * + tests page loaders can join quarantine state onto a list of testIds without
 * re-deriving a scope, mirroring `loadTagsByTestId` in `flaky.server.ts`.
 */

/** One quarantine entry as the reporter / page badge consume it. */
export interface QuarantineEntry {
  testId: string;
  mode: QuarantineMode;
  reason: string | null;
}

/**
 * All quarantine entries in the project, oldest first. The reporter pulls this
 * at `onBegin`; the projection is exactly the fields the wire contract carries.
 */
export async function listQuarantine(
  scope: TenantScope,
): Promise<QuarantineEntry[]> {
  const rows = await db
    .select({
      testId: quarantinedTests.testId,
      mode: quarantinedTests.mode,
      reason: quarantinedTests.reason,
    })
    .from(quarantinedTests)
    .where(childProjectScopeWhere(quarantinedTests.projectId, scope))
    .orderBy(asc(quarantinedTests.createdAt));
  return rows;
}

/** Quarantine a test, preserving original provenance on updates. */
export async function quarantineTest(
  scope: TenantScope,
  input: QuarantineEntry,
  createdBy: string,
  now: number,
): Promise<QuarantinedTest> {
  const row = {
    id: ulid(),
    projectId: scope.projectId,
    testId: input.testId,
    reason: input.reason,
    mode: input.mode,
    createdBy,
    createdAt: now,
  };
  const [persisted] = await db
    .insert(quarantinedTests)
    .values(row)
    .onConflictDoUpdate({
      target: [quarantinedTests.projectId, quarantinedTests.testId],
      set: {
        reason: input.reason,
        mode: input.mode,
      },
    })
    .returning();
  // onConflictDoUpdate always inserts or updates exactly one row; unreachable
  // in practice, kept for type honesty (`.returning()` types as an array).
  if (!persisted) {
    throw new Error(
      `quarantineTest: onConflictDoUpdate returned no row for (${scope.projectId}, ${input.testId})`,
    );
  }
  return persisted;
}

/**
 * Remove a test from the quarantine list. Scoped by `(projectId, testId)`; a
 * missing entry (or a cross-tenant testId) is a clean no-op.
 */
export async function unquarantineTest(
  scope: TenantScope,
  testId: string,
): Promise<void> {
  await db
    .delete(quarantinedTests)
    .where(childByTestIdWhere(quarantinedTests, scope, testId));
}

/**
 * Quarantine state for a set of testIds, for the flaky + tests-catalog page
 * badge join. Mirrors `loadTagsByTestId`: scoped by the passed (auth-checked)
 * `projectId` + an `inArray` over the page slice. Caller guards
 * `testIds.length > 0`.
 */
export async function loadQuarantineByTestId(
  projectId: string,
  testIds: readonly string[],
): Promise<QuarantineEntry[]> {
  return db
    .select({
      testId: quarantinedTests.testId,
      mode: quarantinedTests.mode,
      reason: quarantinedTests.reason,
    })
    .from(quarantinedTests)
    .where(
      and(
        eq(quarantinedTests.projectId, projectId),
        inArray(quarantinedTests.testId, [...testIds]),
      ),
    );
}
