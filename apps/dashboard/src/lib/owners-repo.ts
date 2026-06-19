import { ulid } from "ulid";
import { and, db, eq, inArray, sql } from "void/db";
import { projects, testOwners, testResults } from "@schema";
import type { TestOwner } from "@schema";
import { matchOwners, parseCodeowners } from "@/lib/codeowners";
import { runRows } from "@/lib/db-run";
import type { TenantScope } from "@/lib/scope";

/**
 * The D1 data layer for test ownership (roadmap 2.3) — the deep module the
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
  const [manualRows, projectRows, fileRows] = await Promise.all([
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
  ]);

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
    const merged = mergeOwners(manual, derived);
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
  const rows = await runRows<{ testId: string; file: string }>(sql`
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
  `);
  for (const row of rows) {
    out.set(row.testId, row.file);
  }
  return out;
}

/**
 * Assign a manual owner to a test. Upserts on the unique
 * `(projectId, testId, owner)` so re-assigning the same owner is a no-op rather
 * than a constraint error. Returns the resulting row.
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
  await db
    .insert(testOwners)
    .values(row)
    .onConflictDoNothing({
      target: [testOwners.projectId, testOwners.testId, testOwners.owner],
    });
  return row as TestOwner;
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
 * Set (or clear) the project's CODEOWNERS file, stamping `codeownersUpdatedAt`.
 * Used by both the manual paste action (project settings) and the ingest upsert
 * (`openRun` when the reporter sends a CODEOWNERS). Project-scoped.
 */
export async function setCodeownersFile(
  scope: TenantScope,
  codeownersFile: string | null,
  now: number,
): Promise<void> {
  await db
    .update(projects)
    .set({ codeownersFile, codeownersUpdatedAt: now })
    .where(eq(projects.id, scope.projectId));
}
