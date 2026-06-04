import { defineHandler, type InferProps } from "void";
import { requireAuth } from "void/auth";
import { getUserAuthProfile } from "@/lib/auth-users";
import { githubOAuthEnabled } from "@/lib/config";

export type Props = InferProps<typeof loader>;

/**
 * Settings → Profile loader. Returns the signed-in user's identity, whether
 * they have a password (some users sign in only via OAuth), and any GitHub
 * link with its login + connected-at timestamp.
 *
 * The void-owned `account` table reads and their storage quirks (number-OR-ISO
 * `createdAt`, `credential`/`github` provider-id semantics) live behind
 * `getUserAuthProfile` in `@/lib/auth-users` — this loader is a pure
 * projection of the session user + that profile.
 */
export const loader = defineHandler(async (c) => {
  const sessionUser = requireAuth(c);

  const { hasPassword, github } = await getUserAuthProfile(sessionUser.id);

  const githubEnabled = githubOAuthEnabled(process.env);

  return {
    user: {
      id: sessionUser.id,
      name: sessionUser.name,
      email: sessionUser.email,
      image: sessionUser.image ?? null,
    },
    hasPassword,
    githubAccount: github,
    githubEnabled,
  };
});
