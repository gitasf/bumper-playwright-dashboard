import { and, db, desc, eq, lt, or } from "void/db";
import { runs, testResults } from "@schema";
import { childByRunWhere, runByIdWhere, runScopeWhere } from "@/lib/scope";
import type { TenantScope } from "@/lib/scope";

/**
 * Run-to-run comparison (roadmap 2.4). A pure server-side set-diff over two
 * runs' `testResults`, keyed by the stable `testId`. **No schema changes** —
 * everything here reads existing columns.
 *
 * Three pieces:
 *   - `loadRunTestStatuses` — the projectId+runId-scoped read of one run's
 *     per-test outcomes (one row per testId).
 *   - `resolveBaseRun` — pick the natural baseline: the most recent PASSED run
 *     on the same branch, created before the head run.
 *   - `diffRuns` — 100% PURE classification of two status arrays into buckets.
 *
 * Logical tenancy: there is no DO boundary, so every query carries
 * `scope.projectId` (and the `runs` reads carry `(teamId, projectId)` via the
 * blessed `runByIdWhere` / `runScopeWhere`). A leaked runId can never read
 * another project's rows.
 */

// ─── Status taxonomy ─────────────────────────────────────────────────────────
//
// Per-test row statuses written by ingest are: `passed`, `failed`, `timedout`,
// `flaky`, `skipped`, `interrupted`, and `queued` (an in-flight placeholder for
// a planned-but-not-yet-run test). The diff classifies each testId from the
// vantage of "did this test get worse / better between base and head", which
// needs a coarse pass/fail/other verdict per row:
//
//   - FAILING  = `failed` | `timedout` | `interrupted`. These are the
//     non-passing terminal outcomes that should redden a run. (`interrupted` is
//     grouped with `flaky` for the UI counters, but for a run-to-run diff it is
//     a genuine non-pass — a test that didn't complete cleanly — so we count it
//     as failing here. Documented divergence from `@/lib/status`'s `groupKey`.)
//   - PASSING  = `passed`.
//   - FLAKY    = `flaky` status OR `retryCount > 0` (a test that ultimately
//     passed but only after a retry). A `flaky` row is treated as passing for
//     the failed/passed verdict (it ended green), but is surfaced separately in
//     `flakyDeltas` when its flaky-ness or retry count changed.
//   - OTHER    = `skipped` / `queued` / unknown — neither passing nor failing.
//     Treated as "absent of a real verdict": a test that goes passed→skipped is
//     NOT a newlyFailed, and skipped→passed is NOT a newlyPassed.
//
// Bucketing rules (a testId lands in at most ONE of the first three buckets,
// and may ALSO appear in flakyDeltas):
//   - newlyFailed   : passing/other/absent in base  → failing in head
//   - newlyPassed   : failing in base               → passing in head
//   - stillFailing  : failing in base               → failing in head
//   - flakyDeltas   : BOTH runs passed (verdict "passing") and the flaky-state
//                     OR retryCount changed. Restricted to passing↔passing so a
//                     failing/skipped row's retry count is never mislabeled as
//                     flaky (a skipped test never ran; a failing one is a status
//                     change, not flakiness).
//   - addedTests    : present in head, absent in base
//   - removedTests  : present in base, absent in head

const FAILING_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "timedout",
  "interrupted",
]);

/** Coarse verdict a row maps to for the diff. */
export type Verdict = "passing" | "failing" | "other";

/** One test's outcome within a single run. */
export interface RunTestStatus {
  testId: string;
  status: string;
  durationMs: number;
  retryCount: number;
}

/** A test that changed pass/fail state between base and head. */
export interface StatusChange {
  testId: string;
  baseStatus: string;
  headStatus: string;
  /**
   * `head.durationMs - base.durationMs`, or `null` when EITHER side didn't run
   * (an `other` verdict — skipped/queued — has `durationMs: 0`, so a delta there
   * would over-state a phantom regression, e.g. skipped→failed). Null renders as
   * "—" rather than a misleading number.
   */
  durationDeltaMs: number | null;
}

/** A test present in only one of the two runs. */
export interface PresenceChange {
  testId: string;
  status: string;
  durationMs: number;
}

/** A test whose flaky-ness or retry count changed (but not pass/fail state). */
export interface FlakyDelta {
  testId: string;
  baseStatus: string;
  headStatus: string;
  baseRetryCount: number;
  headRetryCount: number;
  /** True if the row's flaky verdict (status flaky OR retryCount>0) flipped. */
  flakyChanged: boolean;
}

export interface RunDiff {
  /** Passing/other/absent in base → failing in head. Most important. */
  newlyFailed: StatusChange[];
  /** Failing in base → passing in head. */
  newlyPassed: StatusChange[];
  /** Failing in both runs. */
  stillFailing: StatusChange[];
  /** Flaky-state / retryCount changes not already captured above. */
  flakyDeltas: FlakyDelta[];
  /** In head, absent from base. */
  addedTests: PresenceChange[];
  /** In base, absent from head. */
  removedTests: PresenceChange[];
}

/** Coarse pass/fail verdict for a single row. */
export function verdictOf(status: string): Verdict {
  if (FAILING_STATUSES.has(status)) return "failing";
  if (status === "passed" || status === "flaky") return "passing";
  return "other";
}

/** Whether a row reads as flaky: a `flaky` status OR any retry. */
function isFlakyRow(
  row: Pick<RunTestStatus, "status" | "retryCount">,
): boolean {
  return row.status === "flaky" || row.retryCount > 0;
}

/**
 * **PURE.** Classify two runs' per-test statuses into diff buckets. No DB, no
 * clock, no globals — deterministic in its two inputs, so the entire taxonomy
 * is a unit-test surface. Order within each bucket is stable: testIds are
 * emitted sorted, so a re-run over the same inputs yields byte-identical output.
 *
 * If a testId appears more than once in an input array (it shouldn't — the
 * loader returns one row per testId), the LAST occurrence wins, matching a
 * de-dupe Map.
 */
export function diffRuns(
  base: readonly RunTestStatus[],
  head: readonly RunTestStatus[],
): RunDiff {
  const baseById = new Map<string, RunTestStatus>();
  for (const row of base) baseById.set(row.testId, row);
  const headById = new Map<string, RunTestStatus>();
  for (const row of head) headById.set(row.testId, row);

  const diff: RunDiff = {
    newlyFailed: [],
    newlyPassed: [],
    stillFailing: [],
    flakyDeltas: [],
    addedTests: [],
    removedTests: [],
  };

  // Union of testIds, sorted for deterministic output.
  const allIds = new Set<string>();
  for (const id of baseById.keys()) allIds.add(id);
  for (const id of headById.keys()) allIds.add(id);
  const sortedIds = [...allIds].sort();

  for (const testId of sortedIds) {
    const baseRow = baseById.get(testId);
    const headRow = headById.get(testId);

    // Presence changes — a test in only one run.
    if (!baseRow && headRow) {
      diff.addedTests.push({
        testId,
        status: headRow.status,
        durationMs: headRow.durationMs,
      });
      continue;
    }
    if (baseRow && !headRow) {
      diff.removedTests.push({
        testId,
        status: baseRow.status,
        durationMs: baseRow.durationMs,
      });
      continue;
    }
    // Both present (the !baseRow/!headRow branches above `continue`).
    if (!baseRow || !headRow) continue;

    const baseVerdict = verdictOf(baseRow.status);
    const headVerdict = verdictOf(headRow.status);
    // A delta is only meaningful when BOTH rows actually ran; an `other`
    // verdict (skipped/queued) has durationMs 0, so e.g. skipped→failed would
    // otherwise read the head's full duration as a regression.
    const bothRan = baseVerdict !== "other" && headVerdict !== "other";
    const durationDeltaMs = bothRan
      ? headRow.durationMs - baseRow.durationMs
      : null;
    const change: StatusChange = {
      testId,
      baseStatus: baseRow.status,
      headStatus: headRow.status,
      durationDeltaMs,
    };

    let classifiedAsStatusChange = false;
    if (headVerdict === "failing") {
      if (baseVerdict === "failing") {
        diff.stillFailing.push(change);
      } else {
        // passing / other / (absent handled above) → failing
        diff.newlyFailed.push(change);
      }
      classifiedAsStatusChange = true;
    } else if (baseVerdict === "failing" && headVerdict === "passing") {
      diff.newlyPassed.push(change);
      classifiedAsStatusChange = true;
    }

    // Flaky deltas only make sense between two runs that BOTH actually ran and
    // PASSED (verdict "passing" = passed|flaky). A failing verdict on either
    // side is a status change (handled above); an "other" verdict
    // (skipped/queued) never ran, so a retryCount delta on it is noise — without
    // this guard, failed(rc2)→skipped(rc0) or skipped→skipped(rc1) would be
    // mislabeled as flaky changes in the UI. Requiring both verdicts == passing
    // closes both leaks while preserving real passed↔flaky / retry deltas.
    if (
      !classifiedAsStatusChange &&
      baseVerdict === "passing" &&
      headVerdict === "passing"
    ) {
      const baseFlaky = isFlakyRow(baseRow);
      const headFlaky = isFlakyRow(headRow);
      const flakyChanged = baseFlaky !== headFlaky;
      const retryChanged = baseRow.retryCount !== headRow.retryCount;
      if (flakyChanged || retryChanged) {
        diff.flakyDeltas.push({
          testId,
          baseStatus: baseRow.status,
          headStatus: headRow.status,
          baseRetryCount: baseRow.retryCount,
          headRetryCount: headRow.retryCount,
          flakyChanged,
        });
      }
    }
  }

  return diff;
}

/**
 * Load one run's per-test outcomes — `testId, status, durationMs, retryCount`,
 * one row per testId. Scoped by BOTH `projectId` AND `runId` (logical
 * tenancy — never just `runId`, or a leaked id could read another project's
 * rows). Served by `testResults_project_runId_idx`.
 */
export async function loadRunTestStatuses(
  scope: TenantScope,
  runId: string,
): Promise<RunTestStatus[]> {
  return db
    .select({
      testId: testResults.testId,
      status: testResults.status,
      durationMs: testResults.durationMs,
      retryCount: testResults.retryCount,
    })
    .from(testResults)
    .where(childByRunWhere(testResults, scope, runId));
}

/** The shape `resolveBaseRun` / the loader needs to describe a run. */
export interface DiffRunRef {
  id: string;
  status: string;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  createdAt: number;
}

/**
 * Resolve the natural baseline for a head run: the most recent run on the SAME
 * branch as `headRun` with status `passed`, created BEFORE the head run —
 * excluding the head run itself and any later runs. Returns `null` when there
 * is no suitable base (no prior passing run on the branch, or the head run has
 * no branch).
 *
 * Scoped by `(teamId, projectId)` via `runScopeWhere` — served by
 * `runs_project_branch_created_at_idx` `(projectId, branch, createdAt)`.
 *
 * `runs.createdAt` is epoch SECONDS, so two runs on the same branch can share a
 * createdAt (rapid CI re-fire / manual re-run < 1s apart). "Before head" is
 * therefore disambiguated by the ULID `id` (lexicographically time-ordered):
 *   - `createdAt < head.createdAt`, OR `createdAt == head.createdAt AND id <
 *     head.id` — admits a legitimate same-second prior run while still excluding
 *     the head itself (its own id is not `< id`), and
 *   - `ORDER BY createdAt DESC, id DESC` makes the pick deterministic when
 *     several candidates tie on the second.
 */
export async function resolveBaseRun(
  scope: TenantScope,
  headRun: Pick<DiffRunRef, "id" | "branch" | "createdAt">,
): Promise<DiffRunRef | null> {
  // No branch (null or empty/whitespace) → no "same branch" baseline. An empty
  // string must NOT fall through to `eq(branch, "")`, which would group every
  // branchless run together and pick an unrelated one as the base.
  const branch = headRun.branch?.trim();
  if (!branch) return null;

  const rows = await db
    .select({
      id: runs.id,
      status: runs.status,
      branch: runs.branch,
      commitSha: runs.commitSha,
      commitMessage: runs.commitMessage,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .where(
      and(
        runScopeWhere(scope),
        eq(runs.branch, branch),
        eq(runs.status, "passed"),
        or(
          lt(runs.createdAt, headRun.createdAt),
          and(eq(runs.createdAt, headRun.createdAt), lt(runs.id, headRun.id)),
        ),
      ),
    )
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Look a single run up by id within the tenant, returning the fields the diff
 * page / API need. Project-scoped via `runByIdWhere` (`(projectId, id)`).
 * Returns `null` when the run doesn't exist or belongs to another project.
 *
 * Used to (a) load the head run and (b) validate an explicit `?base=<runId>`
 * before diffing against it.
 */
export async function loadDiffRunRef(
  scope: TenantScope,
  runId: string,
): Promise<DiffRunRef | null> {
  const rows = await db
    .select({
      id: runs.id,
      status: runs.status,
      branch: runs.branch,
      commitSha: runs.commitSha,
      commitMessage: runs.commitMessage,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .where(runByIdWhere(scope, runId))
    .limit(1);

  return rows[0] ?? null;
}

/** The resolved head + base + diff that {@link resolveRunDiff} produces. */
export interface ResolvedRunDiff {
  head: DiffRunRef;
  base: DiffRunRef | null;
  diff: RunDiff | null;
}

/**
 * Decide WHICH two runs get diffed, then diff them — the orchestration the
 * run-diff page loader and the JSON API route both need. Previously open-coded
 * verbatim in both adapters; concentrating it here means the decision branches
 * below have one home (and one test surface) and can't drift between page and
 * API. The page loader keeps only its extra base-candidate selector query and
 * prop mapping; the API route keeps only its field projection.
 *
 * The decisions, in order:
 *  - Load the head (project-scoped via {@link loadDiffRunRef}); a missing or
 *    foreign id is the ONLY 404 case — returned as `{ notFound: true }`.
 *  - Pick the base: an explicit `baseParam` that is NOT the head itself is
 *    validated through the SAME project-scoped lookup, and a foreign/missing
 *    base **degrades to `null` (empty diff, not a 404)**; `baseParam === runId`
 *    (self-compare guard) yields no base; absent `baseParam` auto-resolves the
 *    natural baseline via {@link resolveBaseRun}.
 *  - Load both runs' per-test statuses in parallel (the base side is skipped
 *    when there is no base).
 *  - `diffRuns(base, head)` IN THAT ARGUMENT ORDER, or `null` when there is no
 *    base (the empty-state).
 */
export async function resolveRunDiff(
  scope: TenantScope,
  runId: string,
  opts: { baseParam?: string | null } = {},
): Promise<ResolvedRunDiff | { notFound: true }> {
  const targets = await resolveRunDiffTargets(scope, runId, opts);
  if ("notFound" in targets) return targets;
  const { head, base } = targets;
  const diff = await computeRunDiff(scope, runId, base);
  return { head, base, diff };
}

/** The head + base pair {@link resolveRunDiffTargets} resolves — before any
 *  per-test scan. */
export interface ResolvedRunDiffTargets {
  head: DiffRunRef;
  base: DiffRunRef | null;
}

/**
 * Decide WHICH two runs get diffed — the head (the sole 404 case) + the base —
 * WITHOUT running the per-test scans. Cheap: single-row indexed lookups only.
 * Split out of {@link resolveRunDiff} so the run-diff **page** loader can
 * resolve the gate + base eagerly (for the header/chips/selector) and DEFER the
 * heavy scans ({@link computeRunDiff}) behind a skeleton, while the JSON API
 * keeps calling the all-in-one `resolveRunDiff`. The base-selection branches
 * therefore still live in exactly one place and can't drift between callers.
 */
export async function resolveRunDiffTargets(
  scope: TenantScope,
  runId: string,
  opts: { baseParam?: string | null } = {},
): Promise<ResolvedRunDiffTargets | { notFound: true }> {
  const head = await loadDiffRunRef(scope, runId);
  if (!head) return { notFound: true };

  // An explicit `?base` is validated via the same project-scoped lookup as the
  // head (a foreign/missing id → no base, not a 404 — the page degrades to the
  // empty state). `base === head` (self-compare) yields no base. Otherwise
  // auto-resolve the natural baseline.
  const baseParam = opts.baseParam ?? null;
  let base: DiffRunRef | null = null;
  if (baseParam && baseParam !== runId) {
    base = await loadDiffRunRef(scope, baseParam);
  } else if (!baseParam) {
    base = await resolveBaseRun(scope, head);
  }
  return { head, base };
}

/**
 * Run the two per-test scans + the pure {@link diffRuns} for an already-resolved
 * base — the HEAVY half of the diff (each scan can be thousands of `testResults`
 * rows). Returns `null` when there is no base (the empty state). The page loader
 * defers this; {@link resolveRunDiff} awaits it inline.
 */
export async function computeRunDiff(
  scope: TenantScope,
  headRunId: string,
  base: DiffRunRef | null,
): Promise<RunDiff | null> {
  const [headStatuses, baseStatuses] = await Promise.all([
    loadRunTestStatuses(scope, headRunId),
    base ? loadRunTestStatuses(scope, base.id) : Promise.resolve([]),
  ]);
  return base ? diffRuns(baseStatuses, headStatuses) : null;
}
