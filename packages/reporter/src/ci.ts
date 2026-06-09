import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// CI environment detection. Reads standard env vars on GitHub Actions,
// GitLab CI, and CircleCI; falls back to a `CI=true` generic case. Commit
// message is read via `git log` because no CI env exposes it consistently.

export interface CIInfo {
  ciProvider: string | null;
  ciBuildId: string | null;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  prNumber: number | null;
  repo: string | null;
  actor: string | null;
}

function readGitCommitMessage(): string | null {
  try {
    const msg = execFileSync("git", ["log", "-1", "--pretty=%B"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return msg || null;
  } catch {
    return null;
  }
}

function githubPrNumber(): number | null {
  const ref = process.env.GITHUB_REF;
  if (!ref) return null;
  const match = ref.match(/^refs\/pull\/(\d+)\/merge$/);
  return match ? parseInt(match[1], 10) : null;
}

function circlePrNumber(): number | null {
  const num = process.env.CIRCLE_PR_NUMBER;
  if (num) return parseInt(num, 10);
  const url = process.env.CIRCLE_PULL_REQUEST;
  if (!url) return null;
  const match = url.match(/\/pull\/(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

export function detectCI(): CIInfo | null {
  if (process.env.GITHUB_ACTIONS === "true") {
    return {
      ciProvider: "github-actions",
      ciBuildId: process.env.GITHUB_RUN_ID ?? null,
      branch:
        process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || null,
      commitSha: process.env.GITHUB_SHA ?? null,
      commitMessage: readGitCommitMessage(),
      prNumber: githubPrNumber(),
      repo: process.env.GITHUB_REPOSITORY ?? null,
      actor:
        process.env.GITHUB_TRIGGERING_ACTOR || process.env.GITHUB_ACTOR || null,
    };
  }
  if (process.env.GITLAB_CI === "true") {
    return {
      ciProvider: "gitlab-ci",
      ciBuildId: process.env.CI_PIPELINE_ID ?? null,
      branch:
        process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME ||
        process.env.CI_COMMIT_BRANCH ||
        null,
      commitSha: process.env.CI_COMMIT_SHA ?? null,
      commitMessage: process.env.CI_COMMIT_MESSAGE || readGitCommitMessage(),
      prNumber: process.env.CI_MERGE_REQUEST_IID
        ? parseInt(process.env.CI_MERGE_REQUEST_IID, 10)
        : null,
      repo: process.env.CI_PROJECT_PATH ?? null,
      actor: process.env.GITLAB_USER_LOGIN ?? null,
    };
  }
  if (process.env.CIRCLECI === "true") {
    return {
      ciProvider: "circleci",
      ciBuildId: process.env.CIRCLE_WORKFLOW_ID ?? null,
      branch: process.env.CIRCLE_BRANCH ?? null,
      commitSha: process.env.CIRCLE_SHA1 ?? null,
      commitMessage: readGitCommitMessage(),
      prNumber: circlePrNumber(),
      repo:
        process.env.CIRCLE_PROJECT_USERNAME &&
        process.env.CIRCLE_PROJECT_REPONAME
          ? `${process.env.CIRCLE_PROJECT_USERNAME}/${process.env.CIRCLE_PROJECT_REPONAME}`
          : null,
      actor: process.env.CIRCLE_USERNAME ?? null,
    };
  }
  if (process.env.CI === "true") {
    return {
      ciProvider: "unknown",
      ciBuildId: null,
      branch: null,
      commitSha: null,
      commitMessage: readGitCommitMessage(),
      prNumber: null,
      repo: null,
      actor: null,
    };
  }
  return null;
}

/**
 * Resolve the run's idempotency key. Precedence:
 *   1. `WRIGHTFUL_IDEMPOTENCY_KEY` env override — set by the synthetic-monitor
 *      container to the pre-known `monitorExecutions.id`, so the opened run is
 *      addressable by `(projectId, idempotencyKey === execution.id)` and the
 *      executor can resolve `runId` back from the execution without a handshake.
 *   2. The CI build id (deterministic across re-runs of the same CI job, which
 *      is what lets a re-run recover the same run row).
 *   3. A random UUID for purely local runs.
 */
export function generateIdempotencyKey(ciBuildId: string | null | undefined) {
  return process.env.WRIGHTFUL_IDEMPOTENCY_KEY || ciBuildId || randomUUID();
}
