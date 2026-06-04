import { defineHandler, type InferProps } from "void";
import { env } from "void/env";
import { getSession } from "void/auth";
import { githubOAuthEnabled, openSignupAllowed } from "@/lib/config";

export type Props = InferProps<typeof loader>;

/**
 * Login page loader. Bounces authenticated users back to `/` so they don't
 * see the sign-in form again. Surfaces the runtime feature flags
 * (GitHub OAuth wired? open signup allowed?) needed to render the page.
 */
export const loader = defineHandler(async (c) => {
  const session = getSession();
  if (session) {
    return c.redirect("/");
  }
  return {
    githubEnabled: githubOAuthEnabled(env),
    signupAllowed: openSignupAllowed(env.ALLOW_OPEN_SIGNUP),
  };
});
