import { isGithubProvider } from "@/lib/pr-url";

/**
 * Public GitHub avatar URL for a login. `https://github.com/<login>.png` is
 * GitHub's unauthenticated avatar redirect (→ avatars.githubusercontent.com),
 * so it resolves for any account without a token or an API round-trip.
 *
 * Only GitHub runs carry a real GitHub login in `runs.actor`
 * (`GITHUB_TRIGGERING_ACTOR` / `GITHUB_ACTOR`). GitLab/CircleCI store *their*
 * own usernames, which would point at the wrong (or a 404) avatar here — so
 * this returns `null` for every other provider (via the shared
 * {@link isGithubProvider} gate that the deep-link builders use), letting the
 * caller fall back to the colored-initial tile.
 */
export function githubAvatarUrl(
  actor: string | null | undefined,
  ciProvider: string | null | undefined,
): string | null {
  if (!actor || !isGithubProvider(ciProvider ?? null)) return null;
  const login = actor.trim();
  // GitHub logins are [A-Za-z0-9-] only. Anything else — most notably bots such
  // as "github-actions[bot]" / "dependabot[bot]", whose "[bot]" suffix has no
  // user avatar page — falls back to the initial tile.
  if (!/^[a-zA-Z0-9-]+$/.test(login)) return null;
  return `https://github.com/${login}.png?size=48`;
}
