import { ulid } from "ulid";
import { and, db, eq, inArray, sql } from "void/db";
import { projects, testOwners, testResults } from "@schema";
import type { TestOwner } from "@schema";
import { listTeamMembers } from "@/lib/auth-users";
import { matchOwners, parseCodeowners } from "@/lib/codeowners";
import { runBatch } from "@/lib/db/batch";
import { runRows } from "@/lib/runs/db";
import type { TenantScope } from "@/lib/scope";

/**
 * The Postgres data layer for test ownership (roadmap 2.3) — the deep module the
 * flaky page badge join and the owner-gated session mutations speak to.
 *
 * Like `quarantine-repo`, every query carries `projectId` for logical tenant
 * isolation — there is no DO boundary, so scoping each query by the branded
 * `TenantScope` projectId (or a passed, already-auth-checked projectId on the
 * trusted-id reader) is what keeps an ownership row from leaking across
 * projects. Ids are ULIDs; timestamps are epoch SECONDS, matching the rest of
 * the schema.
 *
 * Ownership is LAYERED: manual `testOwners` rows are the source of truth and
 * override the CODEOWNERS-derived set. `resolveTestOwners` computes the union
 * with that precedence (`mergeOwners` is the pure rule); the CODEOWNERS leg is
 * derived on the fly from `projects.codeownersFile` (matched against each
 * test's latest `file`), not persisted.
 */

/** One owner of a test, tagged with where the ownership came from. */
export interface OwnerEntry {
  owner: string;
  source: "manual" | "codeowners";
  /**
   * Display label: the team member's NAME when `owner` is a member email,
   * else the raw owner label. UI surfaces render this (never the email);
   * the opaque `owner` stays the stored identity/mutation key.
   */
  label?: string;
}

/**
 * The blessed single-test owner predicate within a tenant:
 * `(projectId, testId, owner)` — the unique index. Scopes by `projectId` so a
 * leaked testId can't be mutated outside its project. Brand load-bearing:
 * requires a `TenantScope`, so the project id is always auth-checked.
 */
function ownerRowWhere(scope: TenantScope, testId: string, owner: string) {
  return and(
    eq(testOwners.projectId, scope.projectId),
    eq(testOwners.testId, testId),
    eq(testOwners.owner, owner),
  );
}

/**
 * Manual-wins merge of the two ownership legs for ONE test. PURE — unit-tested
 * directly. When a test has ANY manual owner, the manual set is used VERBATIM
 * (CODEOWNERS is ignored for it); otherwise the CODEOWNERS-derived owners are
 * used. Manual owners are de-duplicated and order-preserving.
 */
export function mergeOwners(
  manual: readonly string[],
  codeowners: readonly string[],
): OwnerEntry[] {
  if (manual.length > 0) {
    const seen = new Set<string>();
    const out: OwnerEntry[] = [];
    for (const owner of manual) {
      if (seen.has(owner)) continue;
      seen.add(owner);
      out.push({ owner, source: "manual" });
    }
    return out;
  }
  const seen = new Set<string>();
  const out: OwnerEntry[] = [];
  for (const owner of codeowners) {
    if (seen.has(owner)) continue;
    seen.add(owner);
    out.push({ owner, source: "codeowners" });
  }
  return out;
}

/**
 * Resolve the owners of a set of testIds = the union of manual `testOwners`
 * rows (`source = "manual"`) and CODEOWNERS-derived owners (each test's latest
 * `file` matched against `projects.codeownersFile`), with MANUAL WINS per test.
 *
 * Three project-scoped reads, run in parallel: the manual rows, the project's
 * CODEOWNERS file, and the latest `file` per testId (so CODEOWNERS can match a
 * path). Returns a `Map<testId, OwnerEntry[]>` containing only testIds that
 * resolved to at least one owner. Caller guards `testIds.length > 0`.
 */
export async function resolveTestOwners(
  scope: TenantScope,
  testIds: readonly string[],
): Promise<Map<string, OwnerEntry[]>> {
  const result = new Map<string, OwnerEntry[]>();
  if (testIds.length === 0) return result;

  const ids = [...testIds];
  const [manualRows, projectRows, fileRows, teamMembers] = await Promise.all([
    db
      .select({ testId: testOwners.testId, owner: testOwners.owner })
      .from(testOwners)
      .where(
        and(
          eq(testOwners.projectId, scope.projectId),
          eq(testOwners.source, "manual"),
          inArray(testOwners.testId, ids),
        ),
      ),
    db
      .select({ codeownersFile: projects.codeownersFile })
      .from(projects)
      .where(eq(projects.id, scope.projectId))
      .limit(1),
    latestFilePerTestId(scope, ids),
    // Member email → name, so entries whose opaque label is a member email
    // carry the member's NAME as their display label (UI never shows emails).
    listTeamMembers(scope.teamId),
  ]);

  const nameByEmail = new Map<string, string>();
  for (const m of teamMembers) {
    nameByEmail.set(m.email, m.name);
  }

  const manualByTestId = new Map<string, string[]>();
  for (const row of manualRows) {
    const list = manualByTestId.get(row.testId) ?? [];
    list.push(row.owner);
    manualByTestId.set(row.testId, list);
  }

  const codeownersFile = projectRows[0]?.codeownersFile ?? null;
  const rules = codeownersFile ? parseCodeowners(codeownersFile) : [];

  for (const testId of testIds) {
    const manual = manualByTestId.get(testId) ?? [];
    const file = fileRows.get(testId);
    const derived = file && rules.length > 0 ? matchOwners(file, rules) : [];
    const merged = mergeOwners(manual, derived).map((entry) => ({
      ...entry,
      label: nameByEmail.get(entry.owner) ?? entry.owner,
    }));
    if (merged.length > 0) result.set(testId, merged);
  }
  return result;
}

/**
 * Latest `testResults.file` per testId within the project. CODEOWNERS matches a
 * file path, so the resolver needs each test's current file; we take the file
 * from the most recent result row per testId (a test's file is stable in
 * practice, but the latest is the right tie-break on a rename). Project-scoped
 * via the branded `TenantScope`.
 */
async function latestFilePerTestId(
  scope: TenantScope,
  testIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (testIds.length === 0) return out;
  // Latest `file` per testId. Postgres (unlike SQLite) rejects a bare
  // non-grouped column alongside an aggregate/GROUP BY, so use DISTINCT ON:
  // order by createdAt desc and keep the first (newest) row per testId.
  const rows = await runRows<{ testId: string; file: string }>(
    sql`
    select distinct on (${testResults.testId})
      ${testResults.testId} as "testId",
      ${testResults.file} as "file"
    from ${testResults}
    where ${testResults.projectId} = ${scope.projectId}
      and ${testResults.testId} in (${sql.join(
        testIds.map((id) => sql`${id}`),
        sql`, `,
      )})
    order by ${testResults.testId}, ${testResults.createdAt} desc
  `,
    { feature: "test-owners" },
  );
  for (const row of rows) {
    out.set(row.testId, row.file);
  }
  return out;
}

/**
 * Assign a manual owner to a test. Upserts on the unique
 * `(projectId, testId, owner)` so re-assigning the same owner is a no-op rather
 * than a constraint error. Returns the resulting row via `.returning()`; on the
 * no-op conflict path that comes back empty, so we read the existing row by its
 * unique key rather than fabricating one from the discarded insert values.
 */
export async function assignOwner(
  scope: TenantScope,
  input: { testId: string; owner: string },
  now: number,
): Promise<TestOwner> {
  const row = {
    id: ulid(),
    projectId: scope.projectId,
    testId: input.testId,
    owner: input.owner,
    source: "manual" as const,
    createdAt: now,
  };
  const [inserted] = await db
    .insert(testOwners)
    .values(row)
    .onConflictDoNothing({
      target: [testOwners.projectId, testOwners.testId, testOwners.owner],
    })
    .returning();
  if (inserted) return inserted;

  const [existing] = await db
    .select()
    .from(testOwners)
    .where(ownerRowWhere(scope, input.testId, input.owner))
    .limit(1);
  // onConflictDoNothing only returns empty when a conflicting row already
  // exists, so the fallback SELECT should always find it.
  if (!existing) {
    throw new Error(
      `assignOwner: row missing after onConflictDoNothing for (${scope.projectId}, ${input.testId}, ${input.owner})`,
    );
  }
  return existing;
}

/**
 * Replace a test's manual owner set wholesale. The assign popover posts the
 * full desired selection, so this is delete-then-insert of the manual rows for
 * `(projectId, testId)` inside one transaction (`runBatch`) — a failed insert
 * can't leave the test half-cleared. CODEOWNERS-derived owners are untouched
 * (they're never persisted); an empty `owners` clears every manual row, which
 * un-shadows the CODEOWNERS leg per `mergeOwners`. Input is de-duplicated,
 * order-preserving.
 */
export async function setManualOwners(
  scope: TenantScope,
  testId: string,
  owners: readonly string[],
  now: number,
): Promise<void> {
  const unique = [...new Set(owners)];
  await runBatch((tx) => [
    tx
      .delete(testOwners)
      .where(
        and(
          eq(testOwners.projectId, scope.projectId),
          eq(testOwners.testId, testId),
          eq(testOwners.source, "manual"),
        ),
      ),
    ...(unique.length > 0
      ? [
          tx.insert(testOwners).values(
            unique.map((owner) => ({
              id: ulid(),
              projectId: scope.projectId,
              testId,
              owner,
              source: "manual" as const,
              createdAt: now,
            })),
          ),
        ]
      : []),
  ]);
}

/**
 * Remove a manual owner from a test. Scoped by `(projectId, testId, owner)`; a
 * missing row (or a cross-tenant testId) is a clean no-op.
 */
export async function removeOwner(
  scope: TenantScope,
  testId: string,
  owner: string,
): Promise<void> {
  await db.delete(testOwners).where(ownerRowWhere(scope, testId, owner));
}

/**
 * Set (or clear) the project's CODEOWNERS file. The single home for the
 * `projects.codeownersFile` write, spoken to by BOTH live writers: the manual
 * paste action (project settings → `updateCodeowners`) and the ingest upsert
 * (`maybeUpdateCodeowners`, reached from `openRun` when the reporter sends a
 * CODEOWNERS). Project-scoped via the branded `TenantScope`.
 *
 * Concentrates the two policies the two writers used to hold divergently:
 *
 *  - NORMALIZE: the incoming value is trimmed and an empty/whitespace-only
 *    result becomes a `null` clear (so a blank paste clears the file).
 *  - UNCHANGED-GUARD: the current value is read first; when the normalized next
 *    value equals it, BOTH the write and the `codeownersUpdatedAt` bump are
 *    skipped. `codeownersUpdatedAt` surfaces as "Last updated" in settings, so
 *    it must move only on a REAL edit — not on every CI run for a stable repo
 *    file (which would also churn a pointless write per run open).
 *
 * Each caller keeps only its own error mapping around this call.
 */
export async function setCodeownersFile(
  scope: TenantScope,
  codeownersFile: string | null,
  now: number,
): Promise<void> {
  const trimmed = codeownersFile?.trim() ?? "";
  const next = trimmed.length > 0 ? trimmed : null;

  const [row] = await db
    .select({ file: projects.codeownersFile })
    .from(projects)
    .where(eq(projects.id, scope.projectId))
    .limit(1);
  // Unchanged → skip the write entirely (and the `codeownersUpdatedAt` bump).
  if ((row?.file ?? null) === next) return;

  await db
    .update(projects)
    .set({ codeownersFile: next, codeownersUpdatedAt: now })
    .where(eq(projects.id, scope.projectId));
}
