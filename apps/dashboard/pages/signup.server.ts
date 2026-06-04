import { defineHandler, type InferProps } from "void";
import { env } from "void/env";
import { getSession } from "void/auth";
import { githubOAuthEnabled, openSignupAllowed } from "@/lib/config";

export type Props = InferProps<typeof loader>;

/**
 * Signup page loader. Only reachable when `ALLOW_OPEN_SIGNUP` is enabled —
 * otherwise it bounces to `/login`, so the route can't be used to self-register
 * on instances that mean to be invite-only (the email+password sign-up API is
 * gated by Better Auth config, this guards the UI surface to match). Already
 * authenticated users go to `/`.
 */
export const loader = defineHandler(async (c) => {
  const session = getSession();
  if (session) {
    return c.redirect("/");
  }
  if (!openSignupAllowed(env.ALLOW_OPEN_SIGNUP)) {
    return c.redirect("/login");
  }
  return { githubEnabled: githubOAuthEnabled(env) };
});
