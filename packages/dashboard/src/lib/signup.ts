import { env } from "cloudflare:workers";
import { parseBooleanEnv } from "@/lib/env-parse";

/**
 * Email verification is disabled (no mailer wired up yet) so leaving signup
 * open means anyone on the public internet can create an account. Self-hosters
 * who don't want that must set `ALLOW_OPEN_SIGNUP=1` explicitly. Both the API
 * edge gate (`/api/auth/sign-up/email`) and the dashboard's signup UI read
 * this single helper so the two can never drift.
 */
export function isOpenSignupAllowed(): boolean {
  return parseBooleanEnv(env.ALLOW_OPEN_SIGNUP);
}
