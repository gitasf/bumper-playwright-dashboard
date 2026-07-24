import { and, db, eq, isNull, lt, or } from "void/db";
import { logger } from "void/log";
import { runs } from "@schema";
import { changedRows } from "@/lib/db/batch";
import type { GithubRunContext } from "@/lib/github-run-context";
import {
  runHeadline,
  runSummaryTable,
  statusToConclusion,
} from "@/lib/github-run-render";
import { githubWriteId, postWithClaimedSlot } from "@/lib/github-surface-post";

/**
 * TTL (seconds) for a `githubCheckClaimedAt` claim (see {@link claimCheckRunSlot}).
 * Must exceed the two sequential GitHub calls a POST makes (mint-token +
 * check-run, ~20s at `REQUEST_TIMEOUT_MS` = 10s each) so a claim never expires
 * mid-POST. 120s leaves wide margin.
 */
const CHECK_CLAIM_TTL_SECONDS = 120;

/**
 * Post a GitHub **check run** summarizing a completed run, so a PR's merge gate
 * reflects the test outcome. Dashboard-side (not reporter-side) because:
 *   - a check run needs an *installation* token (only a GitHub App mints one),
 *     which — unlike a CI `GITHUB_TOKEN` — works on fork PRs;
 *   - the dashboard owns the authoritative post-`completeRun` aggregates + the
 *     canonical run URL;
 *   - runs finalized by the watchdog/synthetic path never reach reporter
 *     `onEnd`, but still flow through `postGithubRunSurfaces`.
 *
 * The reporter's `postPrComment` stays as the no-App fallback for self-hosters.
 */

interface RunCheckSummary {
  status: string;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  totalTests: number;
  durationMs: number;
}

/** The check-run `output` (title + markdown summary). PURE. */
export function buildCheckRunOutput(
  summary: RunCheckSummary,
  detailsUrl: string,
): { title: string; summary: string } {
  const body = [
    ...runSummaryTable(summary),
    "",
    `[View run report →](${detailsUrl})`,
  ].join("\n");
  return { title: runHeadline(summary), summary: body };
}

/**
 * Build the `/repos/:owner/:repo/check-runs[/:id]` path, percent-encoding each
 * `repo` segment. `repo` is attacker-controlled ingest input (`run.repo`), so
 * encoding stops reserved chars (`?`, `#`, `%`, …) from reinterpreting the
 * request — e.g. a `?` starting a query string and truncating the path before
 * `/check-runs`. PURE.
 */
export function buildCheckRunPath(
  repo: string,
  existingCheckRunId: number | null,
): string {
  const encodedRepo = repo.split("/").map(encodeURIComponent).join("/");
  return existingCheckRunId
    ? `/repos/${encodedRepo}/check-runs/${existingCheckRunId}`
    : `/repos/${encodedRepo}/check-runs`;
}

/**
 * Atomically claim the "post a check run" slot for `runId` by writing
 * `nowSeconds` into `githubCheckClaimedAt`, but only if `githubCheckRunId` is
 * still null AND the claim column is null or holds an expired claim (left by a
 * poster that crashed before persisting a real id). Makes concurrent
 * `completeRun` + `finalizeStaleRun` race-safe: only one caller's `UPDATE`
 * matches, so only one POSTs; the loser sees `changedRows === 0` and backs off.
 *
 * `projectId` is ANDed in alongside `runs.id` per the `runByIdWhere` convention
 * (`@/lib/scope.ts`) but doesn't affect the race — `runs.id` is a unique ULID,
 * so the extra predicate only narrows to the same row or zero, never widens.
 *
 * Returns the claim token (`nowSeconds`), or null if the slot is already held.
 */
async function claimCheckRunSlot(
  runId: string,
  projectId: string,
  nowSeconds: number,
): Promise<number | null> {
  const result = await db
    .update(runs)
    .set({ githubCheckClaimedAt: nowSeconds })
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.projectId, projectId),
        isNull(runs.githubCheckRunId),
        or(
          isNull(runs.githubCheckClaimedAt),
          lt(runs.githubCheckClaimedAt, nowSeconds - CHECK_CLAIM_TTL_SECONDS),
        ),
      ),
    );
  return changedRows(result) === 1 ? nowSeconds : null;
}

/**
 * Post/update the GitHub check run for a resolved {@link GithubRunContext}.
 * Best-effort: NEVER throws — it logs and swallows its own errors, so a
 * GitHub outage neither fails ingest nor suppresses the sibling PR-comment
 * surface (see `postGithubRunSurfaces`). No-ops when the run has no commit
 * sha (a check run needs a `head_sha` to attach to).
 */
export async function postCheckRunSurface(
  context: GithubRunContext,
): Promise<void> {
  const { runId, projectId, repo, commitSha } = context;
  try {
    if (!repo || !commitSha) return;

    const byRunId = and(eq(runs.id, runId), eq(runs.projectId, projectId));
    await postWithClaimedSlot(
      "check-run",
      runId,
      context.githubCheckRunId,
      {
        claim: (nowSeconds) => claimCheckRunSlot(runId, projectId, nowSeconds),
        readId: async () => {
          const rows = await db
            .select({ githubCheckRunId: runs.githubCheckRunId })
            .from(runs)
            .where(byRunId)
            .limit(1);
          return rows[0]?.githubCheckRunId ?? null;
        },
        release: async (claim) => {
          await db
            .update(runs)
            .set({ githubCheckClaimedAt: null })
            .where(and(byRunId, eq(runs.githubCheckClaimedAt, claim)));
        },
        persist: async (id, claim, existingId) => {
          // A PATCH echoing the id we already hold needs no write.
          if (id === existingId) return;
          await db
            .update(runs)
            .set({ githubCheckRunId: id, githubCheckClaimedAt: null })
            .where(
              claim !== null
                ? and(byRunId, eq(runs.githubCheckClaimedAt, claim))
                : byRunId,
            );
        },
      },
      (existingId) =>
        githubWriteId(
          buildCheckRunPath(repo, existingId),
          existingId ? "PATCH" : "POST",
          {
            name: "Wrightful",
            head_sha: commitSha,
            status: "completed",
            conclusion: statusToConclusion(context.status),
            details_url: context.runUrl,
            output: buildCheckRunOutput(context, context.runUrl),
          },
          context.token,
          "check-run",
        ),
    );
  } catch (err) {
    logger.error("github check-run post failed", {
      runId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
