import { defineHandler } from "void";
import { StreamableHTTPTransport } from "@hono/mcp";
import type { Context } from "hono";
import { mcpUnauthorized } from "@/lib/api-auth";
import { buildMcpServer, type McpAuthz } from "@/lib/mcp/server";
import { tenantScopeForApiKey } from "@/lib/scope";

/**
 * /api/mcp — the Wrightful MCP server endpoint (Model Context Protocol,
 * Streamable HTTP transport).
 *
 * TWO ways for an agent to connect:
 *
 *   1. OAuth (interactive agents — Claude Code, Cursor, …). Add the server
 *      with no credentials; the first 401 carries a `WWW-Authenticate:
 *      Bearer resource_metadata=…` challenge, the client discovers the
 *      Better Auth authorization server via the root `/.well-known/*`
 *      documents (rewritten onto `/api/auth/.well-known/*` in-worker by
 *      `middleware/00.oauth-discovery.ts`, with a redundant `void.json`
 *      `routing.rewrites` edge mapping), dynamically registers, and runs
 *      the browser authorize → login → consent flow. The resulting access
 *      token is USER-scoped: tools take team/project slugs, membership-checked
 *      per call (`McpAuthz` kind "user").
 *
 *        claude mcp add --transport http wrightful https://<dashboard>/api/mcp
 *
 *   2. A project API key (headless/CI). Same Bearer header the reporter and
 *      `/api/v1/*` use; the server is hard-bound to the key's project
 *      (`McpAuthz` kind "project").
 *
 *        claude mcp add --transport http wrightful https://<dashboard>/api/mcp \
 *          --header "Authorization: Bearer <key>"
 *
 * `middleware/02.api-auth.ts` (via `isMcpRoute` / `requireMcpAuthOrResponse`)
 * validates whichever credential is present and stashes `apiKey` OR `mcpAuth`;
 * `middleware/03.rate-limit.ts` throttles per key/user under
 * `QUERY_RATE_LIMITER`. There is no `X-Wrightful-Version` handshake; MCP
 * negotiates its own protocol version inside JSON-RPC.
 *
 * STATELESS mode: a fresh `McpServer` + transport per request, no
 * `Mcp-Session-Id` minted (`sessionIdGenerator: undefined`) and plain JSON
 * responses (`enableJsonResponse`) instead of a hanging SSE stream. This is
 * the shape that fits Workers — an isolate can't promise a later request
 * lands on the same instance, and every tool is a self-contained read, so
 * there is no per-session state worth keeping. GET (the server-push SSE
 * channel) and DELETE (session termination) are meaningless without sessions,
 * so this route answers them with the spec's 405 ITSELF — `@hono/mcp`'s
 * transport would instead hold a GET open as an eternal keepalive-pinged SSE
 * stream that a stateless server never writes to (one dangling Workers
 * request per curious client). Guarded by the e2e 405 test.
 *
 * The tool surface itself lives in `src/lib/mcp/server.ts` — this handler is
 * auth-shape resolution + transport only, mirroring the ingest routes'
 * "routes are translation, libs are the module" convention.
 */
async function handleMcp(c: Context): Promise<Response> {
  const authz = await resolveAuthz(c);
  if (authz instanceof Response) return authz;
  const server = buildMcpServer(authz);
  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(c);
  // handleRequest returns undefined when it already wrote via the context
  // (not the case for POST-with-JSON, but keep the type honest).
  return response ?? c.res;
}

async function resolveAuthz(c: Context): Promise<McpAuthz | Response> {
  const apiKey = c.get("apiKey");
  if (apiKey) {
    return { kind: "project", scope: await tenantScopeForApiKey(apiKey) };
  }
  const mcpAuth = c.get("mcpAuth");
  if (mcpAuth) {
    return { kind: "user", userId: mcpAuth.userId };
  }
  // Unreachable when the middleware is wired (it 401s first) — but if the
  // predicate and this route ever drift, fail closed with the same
  // WWW-Authenticate challenge rather than serving an unscoped server.
  return mcpUnauthorized(c);
}

function methodNotAllowed(c: Context): Response {
  return c.json(
    {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "Method not allowed: this server is stateless (no SSE channel, no sessions) — use POST.",
      },
      id: null,
    },
    405,
    { Allow: "POST" },
  );
}

export const POST = defineHandler(handleMcp);
export const GET = defineHandler(methodNotAllowed);
export const DELETE = defineHandler(methodNotAllowed);
