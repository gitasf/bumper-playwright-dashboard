import { describe, expect, it } from "vite-plus/test";
import { branchUrl, commitUrl, prUrl } from "@/lib/pr-url";

/**
 * External deep-link builders for the run-metadata pills (branch / commit /
 * PR). One block per provider plus the unknown-provider and missing-input
 * fallbacks — these are the only place CI-provider URL shapes live, so the
 * exact strings are pinned.
 */

describe("prUrl", () => {
  it("builds a GitHub pull URL for github-actions", () => {
    expect(prUrl("github-actions", "acme/web", 42)).toBe(
      "https://github.com/acme/web/pull/42",
    );
  });

  it("accepts the legacy 'github' provider (seed generator emits it)", () => {
    // scripts/seed/generator.mjs stamps ciProvider: "github"; the run-detail
    // pills accepted both values before the shared helpers existed.
    expect(prUrl("github", "acme/web", 42)).toBe(
      "https://github.com/acme/web/pull/42",
    );
  });

  it("builds a GitLab merge-request URL for gitlab-ci", () => {
    expect(prUrl("gitlab-ci", "acme/web", 42)).toBe(
      "https://gitlab.com/acme/web/-/merge_requests/42",
    );
  });

  it("returns null for an unknown provider", () => {
    expect(prUrl("circleci", "acme/web", 42)).toBeNull();
    expect(prUrl(null, "acme/web", 42)).toBeNull();
  });

  it("returns null when repo or prNumber is missing", () => {
    expect(prUrl("github-actions", null, 42)).toBeNull();
    expect(prUrl("github-actions", "acme/web", null)).toBeNull();
  });
});

describe("commitUrl", () => {
  it("builds a GitHub commit URL for github-actions", () => {
    expect(commitUrl("github-actions", "acme/web", "abc1234")).toBe(
      "https://github.com/acme/web/commit/abc1234",
    );
  });

  it("accepts the legacy 'github' provider (seed generator emits it)", () => {
    expect(commitUrl("github", "acme/web", "abc1234")).toBe(
      "https://github.com/acme/web/commit/abc1234",
    );
  });

  it("builds a GitLab commit URL for gitlab-ci", () => {
    expect(commitUrl("gitlab-ci", "acme/web", "abc1234")).toBe(
      "https://gitlab.com/acme/web/-/commit/abc1234",
    );
  });

  it("returns null for an unknown provider", () => {
    expect(commitUrl("circleci", "acme/web", "abc1234")).toBeNull();
    expect(commitUrl(null, "acme/web", "abc1234")).toBeNull();
  });

  it("returns null when repo or sha is missing", () => {
    expect(commitUrl("github-actions", null, "abc1234")).toBeNull();
    expect(commitUrl("github-actions", "acme/web", null)).toBeNull();
  });
});

describe("branchUrl", () => {
  it("builds a GitHub tree URL for github-actions", () => {
    expect(branchUrl("github-actions", "acme/web", "main")).toBe(
      "https://github.com/acme/web/tree/main",
    );
  });

  it("accepts the legacy 'github' provider (seed generator emits it)", () => {
    expect(branchUrl("github", "acme/web", "main")).toBe(
      "https://github.com/acme/web/tree/main",
    );
  });

  it("builds a GitLab tree URL for gitlab-ci", () => {
    expect(branchUrl("gitlab-ci", "acme/web", "main")).toBe(
      "https://gitlab.com/acme/web/-/tree/main",
    );
  });

  it("URL-encodes branch names with slashes and special characters", () => {
    expect(branchUrl("github-actions", "acme/web", "feat/x#1")).toBe(
      "https://github.com/acme/web/tree/feat%2Fx%231",
    );
    expect(branchUrl("gitlab-ci", "acme/web", "feat/x")).toBe(
      "https://gitlab.com/acme/web/-/tree/feat%2Fx",
    );
  });

  it("returns null for an unknown provider", () => {
    expect(branchUrl("circleci", "acme/web", "main")).toBeNull();
    expect(branchUrl(null, "acme/web", "main")).toBeNull();
  });

  it("returns null when repo or branch is missing", () => {
    expect(branchUrl("github-actions", null, "main")).toBeNull();
    expect(branchUrl("github-actions", "acme/web", null)).toBeNull();
  });
});
