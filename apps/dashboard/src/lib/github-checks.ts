import { and, db, eq } from "void/db";
import { env } from "void/env";
import { logger } from "void/log";
import { githubInstallations, projects, runs, teams } from "@schema";
import { githubAppEnabled } from "@/lib/config";
import {
  githubFetch,
  mintInstallationToken,
  parseRepoOwner,
} from "@/lib/github-app";

/**
 * Post a GitHub **check run** summarizing a completed run, so a PR's merge gate
 * reflects the test outcome. Dashboard-side (not reporter-side) because:
 *   - a check run needs an *installation* token (only a GitHub App mints one),
 *     which — unlike a CI `GITHUB_TOKEN` — works on fork PRs;
 *   - the dashboard owns the authoritative post-`completeRun` aggregates + the
 *     canonical run URL;
 *   - runs finalized by the watchdog/synthetic path never reach reporter
 *     `onEnd`, but still flow through `maybePostGithubCheck`.
 *
 * The reporter's `postPrComment` stays as the no-App fallback for self-hosters.
 */

export type CheckConclusion = "success" | "failure" | "neutral";

interface RunCheckSummary {
  status: string;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  totalTests: number;
  durationMs: number;
}

/**
 * Map a terminal run status to a check-run conclusion. PURE — the merge-gate
 * decision, unit-tested directly. `failed`/`timedout`/`interrupted` fail the
 * check (interrupted = incomplete, don't merge); `passed` succeeds even with
 * flaky retries (every test ultimately passed; the output notes the flake
 * count); anything unrecognized is `neutral` (non-blocking).
 */
export function statusToConclusion(status: string): CheckConclusion {
  switch (status) {
    case "passed":
      return "success";
    case "failed":
    case "timedout":
    case "interrupted":
      return "failure";
    default:
      return "neutral";
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

/** The check-run `output` (title + markdown summary). PURE. */
export function buildCheckRunOutput(
  summary: RunCheckSummary,
  detailsUrl: string,
): { title: string; summary: string } {
  const failed = summary.failed;
  const title =
    statusToConclusion(summary.status) === "success"
      ? `${summary.passed} passed${summary.flaky > 0 ? `, ${summary.flaky} flaky` : ""}`
      : `${failed} failed, ${summary.passed} passed`;
  const body = [
    `| Passed | Failed | Flaky | Skipped | Duration |`,
    `| --- | --- | --- | --- | --- |`,
    `| ${summary.passed} | ${summary.failed} | ${summary.flaky} | ${summary.skipped} | ${formatDuration(summary.durationMs)} |`,
    "",
    `[View run report →](${detailsUrl})`,
  ].join("\n");
  return { title, summary: body };
}

/** POST a new check run, or PATCH the existing one. Returns its id. */
async function postCheckRun(
  token: string,
  repo: string,
  headSha: string,
  conclusion: CheckConclusion,
  detailsUrl: string,
  output: { title: string; summary: string },
  existingCheckRunId: number | null,
): Promise<number | null> {
  const body = {
    name: "Wrightful",
    head_sha: headSha,
    status: "completed",
    conclusion,
    details_url: detailsUrl,
    output,
  };
  const path = existingCheckRunId
    ? `/repos/${repo}/check-runs/${existingCheckRunId}`
    : `/repos/${repo}/check-runs`;
  const response = await githubFetch(
    path,
    {
      method: existingCheckRunId ? "PATCH" : "POST",
      body: JSON.stringify(body),
    },
    token,
  );
  if (!response.ok) {
    throw new Error(
      `GitHub check-run ${existingCheckRunId ? "PATCH" : "POST"} failed: ${response.status} ${response.statusText}`,
    );
  }
  const json = (await response.json().catch(() => ({}))) as { id?: number };
  return json.id ?? null;
}

/**
 * Best-effort: post/update the GitHub check run for a completed run. Reads
 * everything it needs by `runId` (so both `completeRun` and `finalizeStaleRun`
 * call it the same way), and NEVER throws — a GitHub outage must not fail
 * ingest. No-ops cheaply (no DB read) when the App isn't configured, the run
 * has no repo/commit, or no installation OWNED BY THE RUN'S TEAM matches the
 * repo owner.
 *
 * The installation lookup is scoped to `run.teamId` (not the repo-owner string
 * alone) on purpose: `run.repo` is attacker-controlled ingest input, so a
 * by-owner-only lookup would be a cross-tenant confused deputy — any tenant
 * could name another org's repo and make us mint THAT org's installation token
 * to post a (merge-gating) check run on their repositories. Requiring the
 * installation to belong to the run's own team means a team can only post checks
 * for an org IT has connected.
 */
export async function maybePostGithubCheck(runId: string): Promise<void> {
  if (!githubAppEnabled(env)) return;
  try {
    const rows = await db
      .select({
        teamId: runs.teamId,
        repo: runs.repo,
        commitSha: runs.commitSha,
        teamSlug: teams.slug,
        projectSlug: projects.slug,
        status: runs.status,
        passed: runs.passed,
        failed: runs.failed,
        flaky: runs.flaky,
        skipped: runs.skipped,
        totalTests: runs.totalTests,
        durationMs: runs.durationMs,
        githubCheckRunId: runs.githubCheckRunId,
      })
      .from(runs)
      .innerJoin(teams, eq(teams.id, runs.teamId))
      .innerJoin(projects, eq(projects.id, runs.projectId))
      .where(eq(runs.id, runId))
      .limit(1);
    const run = rows[0];
    if (!run?.repo || !run.commitSha) return;

    const owner = parseRepoOwner(run.repo);
    if (!owner) return;

    const installRows = await db
      .select({ installationId: githubInstallations.installationId })
      .from(githubInstallations)
      // Scope to the run's own team: a run may only drive the installation its
      // team connected, never one resolved purely from the attacker-supplied
      // `repo` owner. (accountLogin is globally unique, so this is still a point
      // seek; the team predicate is the authorization boundary.)
      .where(
        and(
          eq(githubInstallations.teamId, run.teamId),
          eq(githubInstallations.accountLogin, owner),
        ),
      )
      .limit(1);
    const installationId = installRows[0]?.installationId;
    if (!installationId) return;

    const token = await mintInstallationToken(installationId);

    const detailsUrl = `${env.WRIGHTFUL_PUBLIC_URL}/t/${run.teamSlug}/p/${run.projectSlug}/runs/${runId}`;
    const checkRunId = await postCheckRun(
      token,
      run.repo,
      run.commitSha,
      statusToConclusion(run.status),
      detailsUrl,
      buildCheckRunOutput(run, detailsUrl),
      run.githubCheckRunId,
    );

    // Persist the id so a re-complete PATCHes instead of POSTing a duplicate.
    if (checkRunId && checkRunId !== run.githubCheckRunId) {
      await db
        .update(runs)
        .set({ githubCheckRunId: checkRunId })
        .where(eq(runs.id, runId));
    }
  } catch (err) {
    logger.error("github check-run post failed", {
      runId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
