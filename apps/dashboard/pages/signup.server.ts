import { defineHandler, type InferProps } from "void";
import { env } from "void/env";
import { getSession } from "void/auth";
import { githubOAuthEnabled, openSignupAllowed } from "@/lib/config";
import { hrefWithNext, nextFromUrl } from "@/lib/safe-next-path";

export type Props = InferProps<typeof loader>;

/**
 * Signup page loader. Only reachable when `ALLOW_OPEN_SIGNUP` is enabled —
 * otherwise it bounces to `/login`, so the route can't be used to self-register
 * on instances that mean to be invite-only (the email+password sign-up API is
 * gated by Better Auth config, this guards the UI surface to match). Already
 * authenticated users go to their post-signup destination (`next`, e.g. an
 * `/invite/:token` link — otherwise `/`). The `next` param is preserved through
 * both the authenticated bounce and the invite-only `/login` bounce so an
 * invited user who lands here never loses the link they were headed to.
 */
export const loader = defineHandler(async (c) => {
  const next = nextFromUrl(c.req.url);
  const session = getSession();
  if (session) {
    return c.redirect(next);
  }
  if (!openSignupAllowed(env.ALLOW_OPEN_SIGNUP)) {
    return c.redirect(hrefWithNext("/login", next));
  }
  // When a sender is configured, signup requires email verification (see
  // auth.ts `emailConfigured`) — `signUp.email` then returns without a session
  // and the page shows a "check your inbox" state instead of routing to `/`.
  return {
    githubEnabled: githubOAuthEnabled(env),
    verifyEmail: Boolean(env.EMAIL_FROM),
    next,
  };
});
