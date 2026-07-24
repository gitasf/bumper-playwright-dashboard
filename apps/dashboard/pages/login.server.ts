import { defineHandler, type InferProps } from "void";
import { env } from "void/env";
import { getSession } from "void/auth";
import { githubOAuthEnabled, openSignupAllowed } from "@/lib/config";
import { nextFromUrl } from "@/lib/safe-next-path";

export type Props = InferProps<typeof loader>;

/**
 * Login page loader. Bounces authenticated users to their post-login
 * destination (the `next` param, e.g. an `/invite/:token` link they opened
 * while signed out — otherwise `/`) so they don't see the sign-in form again.
 * Surfaces the runtime feature flags (GitHub OAuth wired? open signup allowed?)
 * needed to render the page, plus the validated `next` the page threads into
 * both the email redirect and the GitHub OAuth `callbackURL`.
 */
export const loader = defineHandler(async (c) => {
  const next = nextFromUrl(c.req.url);
  const session = getSession();
  if (session) {
    return c.redirect(next);
  }
  return {
    githubEnabled: githubOAuthEnabled(env),
    signupAllowed: openSignupAllowed(env.ALLOW_OPEN_SIGNUP),
    // Password reset needs an email sender; hide the entry link without one.
    resetEnabled: Boolean(env.EMAIL_FROM),
    next,
  };
});
