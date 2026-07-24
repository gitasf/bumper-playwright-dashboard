import { describe, expect, it } from "vite-plus/test";
import { githubAvatarUrl } from "@/lib/github-avatar";

/**
 * `runs.actor` holds a real GitHub login only on GitHub-provider runs; every
 * other provider stores its own username (or a bracketed bot), so the avatar
 * URL must gate on provider + login shape and otherwise fall back to null (the
 * caller then renders the colored-initial tile).
 */
describe("githubAvatarUrl", () => {
  it("builds the public avatar URL for a github-actions login", () => {
    expect(githubAvatarUrl("joefairburn", "github-actions")).toBe(
      "https://github.com/joefairburn.png?size=48",
    );
  });

  it("accepts the legacy 'github' provider (seeded runs)", () => {
    expect(githubAvatarUrl("octocat", "github")).toBe(
      "https://github.com/octocat.png?size=48",
    );
  });

  it("returns null for non-GitHub providers (login is not a GH handle)", () => {
    expect(githubAvatarUrl("some-user", "gitlab-ci")).toBeNull();
    expect(githubAvatarUrl("some-user", "circleci")).toBeNull();
    expect(githubAvatarUrl("some-user", "unknown")).toBeNull();
  });

  it("returns null for a missing actor or provider", () => {
    expect(githubAvatarUrl(null, "github-actions")).toBeNull();
    expect(githubAvatarUrl("", "github-actions")).toBeNull();
    expect(githubAvatarUrl("joefairburn", null)).toBeNull();
  });

  it("rejects bot actors and other non-login strings", () => {
    // "github-actions[bot]" / "dependabot[bot]" have no user avatar page.
    expect(githubAvatarUrl("github-actions[bot]", "github-actions")).toBeNull();
    expect(githubAvatarUrl("dependabot[bot]", "github-actions")).toBeNull();
    expect(githubAvatarUrl("a name with spaces", "github-actions")).toBeNull();
  });
});
