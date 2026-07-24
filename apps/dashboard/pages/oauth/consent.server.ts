import { defineHandler, type InferProps } from "void";
import { getSession } from "void/auth";
import { sql } from "void/db";
import { runRow } from "@/lib/runs/db";

export type Props = InferProps<typeof loader>;

/**
 * OAuth consent screen loader — the `consentPage` Better Auth's mcp plugin
 * redirects to during an MCP client's authorization (auth.ts registers it;
 * `middleware/02.api-auth.ts` forces `prompt=consent` so EVERY grant lands
 * here). The pending grant itself travels out-of-band in the signed
 * `oidc_consent_prompt` cookie; the query only carries display context
 * (`client_id`, `scope`) for the approval copy.
 *
 * `oauthApplication` is a Better Auth-owned table (not in `db/schema.ts`),
 * so the client's display name is a raw-SQL read — the same idiom as the
 * other cross-auth-boundary joins. An unknown client renders a generic name
 * rather than 404ing: the consent POST re-validates the code server-side, so
 * this page is presentation only.
 */
export const loader = defineHandler(async (c) => {
  const session = getSession();
  if (!session) {
    // The authorize flow normally guarantees a session (it redirects to
    // /login first). A direct unauthenticated hit just goes to login; the
    // flow, if one is pending, resumes from the plugin's login-prompt cookie.
    return c.redirect("/login");
  }

  const url = new URL(c.req.url);
  const clientId = url.searchParams.get("client_id");
  const scope = url.searchParams.get("scope") ?? "";

  const client = clientId
    ? await runRow<{ name: string | null }>(
        sql`select "name" from "oauthApplication" where "clientId" = ${clientId} limit 1`,
      )
    : undefined;

  return {
    clientName: client?.name ?? null,
    scopes: scope.split(" ").filter((s) => s.length > 0),
    userEmail: session.user.email,
  };
});
