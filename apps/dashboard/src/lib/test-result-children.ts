import { asc, db, desc } from "void/db";
import { testAnnotations, testResultAttempts, testTags } from "@schema";
import { childByTestResultWhere, type TenantScope } from "@/lib/scope";

/**
 * Tags + annotations for a test result — the two small run-scoped child lists
 * every consumer wants. Factored out so `loadTestResultChildren` (MCP) and the
 * test-detail page loader share one projection without drifting on column shape.
 */
export async function loadTestTagsAndAnnotations(
  scope: TenantScope,
  testResultId: string,
) {
  const [tags, annotations] = await Promise.all([
    db
      .select({ tag: testTags.tag })
      .from(testTags)
      .where(childByTestResultWhere(testTags, scope, testResultId)),
    db
      .select({
        type: testAnnotations.type,
        description: testAnnotations.description,
      })
      .from(testAnnotations)
      .where(childByTestResultWhere(testAnnotations, scope, testResultId)),
  ]);
  return { tags, annotations };
}

/**
 * Lightweight per-attempt metadata: attempt/status/duration only. Stays eager
 * on the test-detail page (drives the attempt tab bar's dots + count) without
 * pulling the heavy error/stdout/stderr blobs into the initial SSR payload —
 * those live in `loadTestResultAttemptDetails`, which the page defers.
 */
export async function loadTestResultAttemptSummaries(
  scope: TenantScope,
  testResultId: string,
) {
  return db
    .select({
      attempt: testResultAttempts.attempt,
      status: testResultAttempts.status,
      durationMs: testResultAttempts.durationMs,
    })
    .from(testResultAttempts)
    .where(childByTestResultWhere(testResultAttempts, scope, testResultId))
    .orderBy(asc(testResultAttempts.attempt));
}

/**
 * Error message/stack for the highest-numbered attempt (the final try, the tab
 * the page shows by default). Kept eager (unlike `loadTestResultAttemptDetails`)
 * because its error alert is the page's above-the-fold content and must paint
 * immediately, not behind a Suspense boundary.
 */
export async function loadTestResultPrimaryAttemptDetail(
  scope: TenantScope,
  testResultId: string,
) {
  const rows = await db
    .select({
      attempt: testResultAttempts.attempt,
      errorMessage: testResultAttempts.errorMessage,
      errorStack: testResultAttempts.errorStack,
    })
    .from(testResultAttempts)
    .where(childByTestResultWhere(testResultAttempts, scope, testResultId))
    .orderBy(desc(testResultAttempts.attempt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The heavy per-attempt fields — error message/stack + captured stdout/stderr —
 * for every attempt. MCP `get_test_result` wants these eagerly (JSON-RPC has no
 * defer) via `loadTestResultChildren`; the test-detail page reads them through a
 * `defer()` so a chatty multi-retry test doesn't add hundreds of KB to the
 * initial payload for attempts the user isn't looking at.
 */
export async function loadTestResultAttemptDetails(
  scope: TenantScope,
  testResultId: string,
) {
  return db
    .select({
      attempt: testResultAttempts.attempt,
      errorMessage: testResultAttempts.errorMessage,
      errorStack: testResultAttempts.errorStack,
      stdout: testResultAttempts.stdout,
      stderr: testResultAttempts.stderr,
    })
    .from(testResultAttempts)
    .where(childByTestResultWhere(testResultAttempts, scope, testResultId))
    .orderBy(asc(testResultAttempts.attempt));
}

/**
 * Tags, annotations, and full per-attempt rows as one eager batch — the MCP
 * `get_test_result` shape (`src/lib/mcp/queries.ts`), which has nothing to
 * stream. The test-detail page does NOT use this: it composes the helpers above
 * with an eager/deferred split of its own, sharing their projections without
 * inheriting an all-eager shape that only makes sense for MCP.
 */
export async function loadTestResultChildren(
  scope: TenantScope,
  testResultId: string,
) {
  const [{ tags, annotations }, summaries, details] = await Promise.all([
    loadTestTagsAndAnnotations(scope, testResultId),
    loadTestResultAttemptSummaries(scope, testResultId),
    loadTestResultAttemptDetails(scope, testResultId),
  ]);
  const detailsByAttempt = new Map(details.map((d) => [d.attempt, d]));
  const attempts = summaries.map((s) => {
    const d = detailsByAttempt.get(s.attempt);
    return {
      attempt: s.attempt,
      status: s.status,
      durationMs: s.durationMs,
      errorMessage: d?.errorMessage ?? null,
      errorStack: d?.errorStack ?? null,
      stdout: d?.stdout ?? null,
      stderr: d?.stderr ?? null,
    };
  });
  return { tags, annotations, attempts };
}
