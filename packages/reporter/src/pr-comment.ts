// Post a sticky summary comment to the GitHub PR that triggered the run.
//
// Only fires from GitHub Actions on a PR-triggered workflow, when a
// `GITHUB_TOKEN` (or `WRIGHTFUL_GITHUB_TOKEN`) is present. Cross-fork PRs
// receive a read-only token — those POSTs return 403; the caller logs and
// continues so a missing PR comment never fails the suite.
//
// Idempotent via a hidden HTML marker so re-runs of the same workflow
// update the existing comment instead of stacking duplicates.

const MARKER = "<!-- wrightful:pr-comment -->";
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

/**
 * Hand-kept copy of the dashboard's check-run `formatDuration`
 * (`apps/dashboard/src/lib/github-checks.ts`) — the reporter is a separately
 * published package and can't import the dashboard lib, but both render the
 * same summary table, so keep them in lockstep. Both round to whole seconds
 * before splitting into minutes/seconds so a remainder rounding up to 60
 * carries into the minutes place instead of rendering "1m 60s".
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remSeconds = totalSeconds % 60;
  return `${minutes}m ${remSeconds}s`;
}

export function buildCommentBody(summary: RunSummary): string {
  const runLink = summary.runUrl
    ? new URL(summary.runUrl, summary.dashboardUrl).toString()
    : summary.dashboardUrl;
  const lines: string[] = [
    MARKER,
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

/**
 * Find the most recent comment containing our marker. Only checks the most
 * recent page (per_page=100, sorted descending) — if a PR has >100 comments
 * after our last one we just post a new one rather than paginate forever.
 */
async function findExistingComment(
  repo: string,
  prNumber: number,
  token: string,
): Promise<number | null> {
  const url =
    `${GITHUB_API}/repos/${repo}/issues/${prNumber}/comments` +
    `?per_page=100&sort=created&direction=desc`;
  const response = await githubFetch(url, { method: "GET" }, token);
  if (!response.ok) return null;
  const comments = (await response.json().catch(() => [])) as GhComment[];
  for (const c of comments) {
    if (c.body && c.body.includes(MARKER)) return c.id;
  }
  return null;
}

export async function postPrComment(
  summary: RunSummary,
  token: string,
): Promise<PostPrCommentResult> {
  const body = buildCommentBody(summary);
  const existingId = await findExistingComment(
    summary.repo,
    summary.prNumber,
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
