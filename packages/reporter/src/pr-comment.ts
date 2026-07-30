// Post a sticky summary comment to the GitHub PR that triggered the run.
//
// Only fires from GitHub Actions on a PR-triggered workflow, when a
// `GITHUB_TOKEN` (or `WRIGHTFUL_GITHUB_TOKEN`) is present. Cross-fork PRs
// receive a read-only token — those POSTs return 403; the caller logs and
// continues so a missing PR comment never fails the suite.
//
// Idempotent via a scoped hidden HTML marker so re-runs of the same workflow
// leg update the existing comment without overwriting another project/matrix
// leg's independent summary.

import { createHash, createHmac } from "node:crypto";

const REQUEST_TIMEOUT_MS = 10_000;
const GITHUB_API = "https://api.github.com";

export interface RunSummary {
  status: "passed" | "failed" | "timedout" | "interrupted";
  durationMs: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  timedout: number;
  total: number;
  /** Path returned by /api/runs (e.g. /t/team/p/proj/runs/abc). May be null. */
  runUrl: string | null;
  /** Dashboard origin for resolving relative runUrl. */
  dashboardUrl: string;
  /** "owner/repo" from GITHUB_REPOSITORY. */
  repo: string;
  prNumber: number;
  environment: string | null;
  commitSha: string | null;
  /**
   * Stable workflow-leg identity. It excludes the CI run id/attempt so reruns
   * update in place, but includes job, project, and explicit matrix identity.
   */
  commentScope: string;
}

export interface PostPrCommentResult {
  status: "created" | "updated" | "skipped";
  reason?: string;
}

export function shouldPostPrComment(
  enabled: boolean,
  ci: {
    ciProvider: string | null;
    prNumber: number | null;
    repo: string | null;
  } | null,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; token: string } | { ok: false; reason: string } {
  if (!enabled) return { ok: false, reason: "postPrComment not enabled" };
  if (!ci) return { ok: false, reason: "no CI context detected" };
  if (ci.ciProvider !== "github-actions") {
    return {
      ok: false,
      reason: `provider ${ci.ciProvider} is not github-actions`,
    };
  }
  if (!ci.prNumber)
    return { ok: false, reason: "no PR number (not a PR workflow)" };
  if (!ci.repo) return { ok: false, reason: "GITHUB_REPOSITORY not set" };
  const token = env.WRIGHTFUL_GITHUB_TOKEN ?? env.GITHUB_TOKEN;
  if (!token) {
    return {
      ok: false,
      reason:
        "GITHUB_TOKEN not set — add `permissions: pull-requests: write` and pass it through",
    };
  }
  return { ok: true, token };
}

function statusEmoji(status: RunSummary["status"]): string {
  switch (status) {
    case "passed":
      return "✅";
    case "failed":
      return "❌";
    case "timedout":
      return "⏱️";
    case "interrupted":
      return "⚠️";
  }
}

export function buildCommentMarker(commentScope: string): string {
  const scopeHash = createHash("sha256")
    .update(commentScope)
    .digest("hex")
    .slice(0, 24);
  return `<!-- wrightful:pr-comment:${scopeHash} -->`;
}

/**
 * Derive a public-safe, credential-scoped project discriminator.
 *
 * API keys are project-scoped, so this keeps comments for two projects on the
 * same dashboard from sharing a marker when an older dashboard omits runUrl.
 * HMAC uses the credential as the key rather than placing it (or a plain hash
 * of it) in the comment scope; neither the raw token nor a reusable token hash
 * leaves the reporter process.
 */
export function projectCommentScope(
  token: string,
  dashboardUrl: string,
): string {
  return createHmac("sha256", token)
    .update(`wrightful-pr-comment-project:v1\0${dashboardUrl}`)
    .digest("hex")
    .slice(0, 24);
}

/**
 * Hand-kept copy of the dashboard's GitHub-surface `formatDuration`
 * (`apps/dashboard/src/lib/github-run-render.ts`) — the reporter is a
 * separately published package and can't import the dashboard lib, but both
 * render the same summary table, so keep them in lockstep.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  // Round to the displayed tenth BEFORE the sub-minute comparison, so 59.96s
  // carries into the minutes path instead of rendering as "60.0s".
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  // Round to whole seconds before splitting, so a leftover rounding up to 60
  // carries into the minutes place instead of rendering as "1m 60s".
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ${totalSeconds - minutes * 60}s`;
}

export function buildCommentBody(summary: RunSummary): string {
  const marker = buildCommentMarker(summary.commentScope);
  const runLink = summary.runUrl
    ? new URL(summary.runUrl, summary.dashboardUrl).toString()
    : summary.dashboardUrl;
  const lines: string[] = [
    marker,
    `### ${statusEmoji(summary.status)} Wrightful — ${summary.status}`,
    "",
    `| Passed | Failed | Flaky | Skipped | Duration |`,
    `| --- | --- | --- | --- | --- |`,
    `| ${summary.passed} | ${summary.failed + summary.timedout} | ${summary.flaky} | ${summary.skipped} | ${formatDuration(summary.durationMs)} |`,
    "",
    `[View run report →](${runLink})`,
  ];
  if (summary.environment) {
    lines.push("", `_Environment: \`${summary.environment}\`_`);
  }
  if (summary.commitSha) {
    lines.push(`_Commit: \`${summary.commitSha.slice(0, 7)}\`_`);
  }
  return lines.join("\n");
}

async function githubFetch(
  url: string,
  init: RequestInit,
  token: string,
): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
      "User-Agent": "wrightful-reporter",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

interface GhComment {
  id: number;
  body?: string;
}

function isGhComment(value: unknown): value is GhComment {
  if (typeof value !== "object" || value === null || !("id" in value)) {
    return false;
  }
  if (typeof value.id !== "number") return false;
  return !("body" in value) || typeof value.body === "string";
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Find the most recent comment containing our marker. Only checks the most
 * recent page (per_page=100, sorted descending) — if a PR has >100 comments
 * after our last one we just post a new one rather than paginate forever.
 */
async function findExistingComment(
  repo: string,
  prNumber: number,
  marker: string,
  token: string,
): Promise<number | null> {
  const url =
    `${GITHUB_API}/repos/${repo}/issues/${prNumber}/comments` +
    `?per_page=100&sort=created&direction=desc`;
  const response = await githubFetch(url, { method: "GET" }, token);
  if (!response.ok) return null;
  const comments: unknown = await response.json().catch(() => []);
  if (!isUnknownArray(comments)) return null;
  for (const comment of comments) {
    if (isGhComment(comment) && comment.body?.split(/\r?\n/).includes(marker)) {
      return comment.id;
    }
  }
  return null;
}

export async function postPrComment(
  summary: RunSummary,
  token: string,
): Promise<PostPrCommentResult> {
  const body = buildCommentBody(summary);
  const marker = buildCommentMarker(summary.commentScope);
  const existingId = await findExistingComment(
    summary.repo,
    summary.prNumber,
    marker,
    token,
  );

  if (existingId !== null) {
    const response = await githubFetch(
      `${GITHUB_API}/repos/${summary.repo}/issues/comments/${existingId}`,
      { method: "PATCH", body: JSON.stringify({ body }) },
      token,
    );
    if (!response.ok) {
      throw new Error(
        `GitHub PATCH /issues/comments/${existingId} failed: ${response.status} ${response.statusText}`,
      );
    }
    return { status: "updated" };
  }

  const response = await githubFetch(
    `${GITHUB_API}/repos/${summary.repo}/issues/${summary.prNumber}/comments`,
    { method: "POST", body: JSON.stringify({ body }) },
    token,
  );
  if (!response.ok) {
    throw new Error(
      `GitHub POST /issues/:n/comments failed: ${response.status} ${response.statusText}`,
    );
  }
  return { status: "created" };
}
