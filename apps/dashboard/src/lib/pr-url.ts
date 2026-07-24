/**
 * Two ciProvider values mean GitHub: `"github-actions"` (the reporter's CI
 * detection) and the legacy/generic `"github"` (emitted by the seed generator
 * — `scripts/seed/generator.mjs` — and accepted by the pre-refactor run-detail
 * pills). The single home for that check, so all three link builders below
 * stay in agreement and seeded runs keep their deep links.
 */
export function isGithubProvider(ciProvider: string | null): boolean {
  return ciProvider === "github" || ciProvider === "github-actions";
}

export function prUrl(
  ciProvider: string | null,
  repo: string | null,
  prNumber: number | null,
): string | null {
  if (!repo || prNumber == null) return null;
  if (isGithubProvider(ciProvider)) {
    return `https://github.com/${repo}/pull/${prNumber}`;
  }
  if (ciProvider === "gitlab-ci") {
    return `https://gitlab.com/${repo}/-/merge_requests/${prNumber}`;
  }
  return null;
}

export function commitUrl(
  ciProvider: string | null,
  repo: string | null,
  sha: string | null,
): string | null {
  if (!repo || !sha) return null;
  if (isGithubProvider(ciProvider)) {
    return `https://github.com/${repo}/commit/${sha}`;
  }
  if (ciProvider === "gitlab-ci") {
    return `https://gitlab.com/${repo}/-/commit/${sha}`;
  }
  return null;
}

export function branchUrl(
  ciProvider: string | null,
  repo: string | null,
  branch: string | null,
): string | null {
  if (!repo || !branch) return null;
  if (isGithubProvider(ciProvider)) {
    return `https://github.com/${repo}/tree/${encodeURIComponent(branch)}`;
  }
  if (ciProvider === "gitlab-ci") {
    return `https://gitlab.com/${repo}/-/tree/${encodeURIComponent(branch)}`;
  }
  return null;
}
