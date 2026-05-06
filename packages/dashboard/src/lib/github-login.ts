import { getControlDb } from "@/control";

/**
 * Fetch the user's GitHub login (handle) and persist it on their `account`
 * row. Called from Better Auth's post-OAuth hooks so directed invites
 * addressed to a GitHub login can resolve once the invitee signs in.
 *
 * Best-effort: a transient GitHub error must not break sign-in. Email-keyed
 * invites still resolve from `user.email`, so a missing login degrades
 * gracefully — the next sign-in re-runs the hook and backfills.
 */
export async function captureGithubLogin(
  userId: string,
  accessToken: string | null | undefined,
): Promise<void> {
  if (!accessToken) return;
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "wrightful-dashboard",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) return;
  const body = (await res.json()) as { login?: unknown };
  if (typeof body.login !== "string" || body.login === "") return;
  const login = body.login.toLowerCase();
  await getControlDb()
    .updateTable("account")
    .set({ githubLogin: login })
    .where("userId", "=", userId)
    .where("providerId", "=", "github")
    .execute();
}
