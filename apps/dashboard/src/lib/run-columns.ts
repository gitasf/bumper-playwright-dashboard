import { runs } from "@schema";

/**
 * The `runs` columns safe to serialize into SSR page props — every column EXCEPT
 * `idempotencyKey`.
 *
 * `idempotencyKey` is a WRITE CREDENTIAL, not display data: presenting it is what
 * re-arms an idle terminal run's write window (`reopenRunForWrites` /
 * `openRun`'s duplicate lookup — see `RUN_WRITE_GRACE_SECONDS` in
 * `@/lib/ingest`). The idle-run write-closure security rationale explicitly
 * assumes the key "never leaves the server", yet the run-detail, test-detail, and
 * runs-list loaders used a bare `db.select().from(runs)` that serialized the FULL
 * row — including `idempotencyKey` — into the browser page props (the runs-list
 * leaked a whole page of them). A bare `.select()` also silently re-leaks any
 * future secret column added to `runs`.
 *
 * Project THIS instead of `.select()` in any loader that returns a run row to the
 * client. Everything except the key is retained so no page component's `run.*`
 * read breaks; the reopen mechanism keeps working because the reporter derives
 * the SAME deterministic key from the CI build id (salting it server-side would
 * break re-stream / re-run recovery, so column projection — not hashing — is the
 * fix).
 */
export const RUN_PUBLIC_COLUMNS = {
  id: runs.id,
  teamId: runs.teamId,
  projectId: runs.projectId,
  ciProvider: runs.ciProvider,
  ciBuildId: runs.ciBuildId,
  branch: runs.branch,
  environment: runs.environment,
  commitSha: runs.commitSha,
  commitMessage: runs.commitMessage,
  prNumber: runs.prNumber,
  repo: runs.repo,
  actor: runs.actor,
  totalTests: runs.totalTests,
  expectedTotalTests: runs.expectedTotalTests,
  expectedShards: runs.expectedShards,
  passed: runs.passed,
  failed: runs.failed,
  flaky: runs.flaky,
  skipped: runs.skipped,
  durationMs: runs.durationMs,
  status: runs.status,
  reporterVersion: runs.reporterVersion,
  playwrightVersion: runs.playwrightVersion,
  createdAt: runs.createdAt,
  lastActivityAt: runs.lastActivityAt,
  completedAt: runs.completedAt,
  origin: runs.origin,
  monitorId: runs.monitorId,
  githubCheckRunId: runs.githubCheckRunId,
} as const;
