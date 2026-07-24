import type { Context } from "hono";
import { env } from "void/env";
import { validateApiKey } from "@/lib/api-key";
import { SUPPORTED_VERSIONS, WRIGHTFUL_VERSION_HEADER } from "@/lib/schemas";
import type { ApiKey } from "@schema";

/** An OAuth access token accepted on /api/mcp, resolved to its user. */
export interface McpTokenAuth {
  userId: string;
  clientId: string;
  scopes: string | null;
}

declare module "void" {
  interface CloudContextVariables {
    /**
     * Populated by `middleware/02.api-auth.ts` for the bearer-authenticated
     * /api/runs/* and /api/artifacts/{register,:id/upload} endpoints.
     */
    apiKey?: ApiKey;
    /**
     * Populated by `middleware/02.api-auth.ts` on /api/mcp when the Bearer
     * token is a Better Auth MCP OAuth access token (rather than a project
     * API key). Exactly one of `apiKey` / `mcpAuth` is set on an authed
     * /api/mcp request.
     */
    mcpAuth?: McpTokenAuth;
  }
}

/**
 * Validate the `Authorization: Bearer <key>` header. On success, stashes the
 * resolved row on `c.var.apiKey` and returns it. On failure, returns the 401
 * `Response` the caller must return as-is.
 *
 * Used by `middleware/02.api-auth.ts` (global middleware). Handlers should
 * read the row via `getApiKey(c)` rather than calling this directly.
 */
export async function requireApiKeyOrResponse(
  c: Context,
): Promise<ApiKey | Response> {
  const header = c.req.header("Authorization");
  const apiKey = await validateApiKey(c, header);
  if (!apiKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("apiKey", apiKey);
  return apiKey;
}

export function getApiKey(c: Context): ApiKey {
  const key = c.get("apiKey");
  if (!key) {
    throw new Error(
      "getApiKey called outside the ingest middleware scope — check middleware/02.api-auth.ts path matching",
    );
  }
  return key;
}

/**
 * The Better Auth MCP-plugin surface this module needs from the live auth
 * instance. Structural on purpose: void's middleware stashes its per-request
 * `betterAuth()` instance on `c.var.__voidAuth` (see `runVoidAuthMiddleware`
 * in void's better-auth-shared runtime) but exports no type for it, and we
 * only call this one endpoint.
 */
interface McpAuthApi {
  api: {
    getMcpSession: (args: {
      headers: Headers;
    }) => Promise<McpAccessTokenRow | null>;
  };
}

/** The `oauthAccessToken` row `getMcpSession` resolves a Bearer token to. */
interface McpAccessTokenRow {
  userId: string;
  clientId: string;
  scopes: string | null;
  accessTokenExpiresAt: Date | string | null;
}

/**
 * The `WWW-Authenticate` challenge that makes MCP-client OAuth work: on any
 * 401 from /api/mcp, spec-following clients (Claude Code, mcp-remote, …) read
 * `resource_metadata`, fetch the protected-resource document, discover the
 * authorization server, and start the browser flow. Root `/.well-known/*`
 * paths are rewritten onto the Better Auth plugin endpoints in `void.json`.
 */
export function mcpUnauthorized(c: Context): Response {
  // On direct Cloudflare deployments, the worker can observe the request URL
  // as http:// even though the public dashboard is served over HTTPS. OAuth
  // metadata must advertise the canonical external origin clients can reach.
  const origin = new URL(env.WRIGHTFUL_PUBLIC_URL).origin;
  return c.json({ error: "Unauthorized" }, 401, {
    "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
  });
}

/**
 * Bearer gate for /api/mcp — accepts EITHER credential the two MCP setup
 * paths produce:
 *
 *   1. A project API key (headless/CI agents; the reporter's key works as-is).
 *      Checked first: the prefix+hash lookup is one indexed SELECT, and a key
 *      can never be a valid OAuth token (different mint paths).
 *   2. A Better Auth MCP OAuth access token (interactive agents that ran the
 *      authorize/consent browser flow). Resolved via the plugin's
 *      `getMcpSession` against the SAME auth instance void mounted for this
 *      request, then expiry-checked HERE — the plugin endpoint returns the
 *      raw `oauthAccessToken` row without validating `accessTokenExpiresAt`
 *      (verified against better-auth 1.6.11 source), so skipping this check
 *      would honor expired tokens forever.
 *
 * On success stashes exactly one of `c.var.apiKey` / `c.var.mcpAuth`. On
 * failure returns the 401 WITH the `WWW-Authenticate` challenge — that header
 * is what triggers a client's OAuth flow, so every 401 on this surface must
 * carry it (including the no-header-at-all first contact).
 */
export async function requireMcpAuthOrResponse(
  c: Context,
): Promise<ApiKey | McpTokenAuth | Response> {
  const header = c.req.header("Authorization");
  const apiKey = await validateApiKey(c, header);
  if (apiKey) {
    c.set("apiKey", apiKey);
    return apiKey;
  }

  if (header?.startsWith("Bearer ")) {
    const auth = (c.var as Record<string, unknown>).__voidAuth as
      | McpAuthApi
      | undefined;
    const row = auth
      ? await auth.api.getMcpSession({ headers: c.req.raw.headers })
      : null;
    if (row && !isExpired(row.accessTokenExpiresAt)) {
      const mcpAuth: McpTokenAuth = {
        userId: row.userId,
        clientId: row.clientId,
        scopes: row.scopes,
      };
      c.set("mcpAuth", mcpAuth);
      return mcpAuth;
    }
  }

  return mcpUnauthorized(c);
}

function isExpired(expiresAt: Date | string | null): boolean {
  if (expiresAt === null) return false;
  const at = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  const ms = at.getTime();
  // An unparsable expiry fails CLOSED — treat as expired rather than eternal.
  if (Number.isNaN(ms)) return true;
  return ms <= Date.now();
}

/**
 * Reject unsupported protocol versions. The reporter sends
 * `X-Wrightful-Version: 3`; older versions get a 409 Conflict with an upgrade
 * hint. The accept-set and header name live in `@/lib/schemas` (the
 * cross-package wire-contract module); the reporter's emit-side
 * `PROTOCOL_VERSION` is asserted to be a member of `SUPPORTED_VERSIONS` by
 * `packages/reporter/src/__tests__/contract.test.ts`.
 */
export function negotiateVersionOrResponse(c: Context): Response | null {
  const v = c.req.header(WRIGHTFUL_VERSION_HEADER);
  // Require the header — every supported reporter sends it on every ingest
  // request (see packages/reporter client `this.headers`). Treating a missing
  // header as "fine" let an unversioned client bypass the gate entirely.
  if (!SUPPORTED_VERSIONS.has(v ?? "")) {
    return c.json(
      {
        error: v ? "Unsupported protocol version" : "Missing protocol version",
        supportedVersions: Array.from(SUPPORTED_VERSIONS),
        message: v
          ? `This dashboard speaks version 3 of the ingest protocol. Your reporter is using version ${v} — upgrade @wrightful/reporter to a release that supports v3.`
          : "This dashboard requires the X-Wrightful-Version header. Upgrade @wrightful/reporter to a release that supports v3.",
      },
      409,
    );
  }
  return null;
}
