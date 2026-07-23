import { defineMiddleware } from "void";

/**
 * Serve the MCP OAuth discovery documents at the origin root — IN-WORKER.
 *
 * An MCP client (Claude Code, Cursor, VS Code, …) that hits `/api/mcp`
 * unauthenticated gets a `WWW-Authenticate: Bearer resource_metadata=
 * "<origin>/.well-known/oauth-protected-resource"` challenge (RFC 9728, see
 * `mcpUnauthorized` in `src/lib/api-auth.ts`). To complete the OAuth 2.1 flow
 * it must fetch that root URL — and the sibling
 * `/.well-known/oauth-authorization-server` — to discover the Better Auth
 * authorization server before it can dynamically register and run
 * authorize → consent → token. Better Auth's `mcp` plugin serves the real
 * documents under `/api/auth/.well-known/*`; these root paths must map onto
 * them. RFC 9728 also defines path-suffixed variants
 * (`…/oauth-protected-resource/api/mcp`); the bare and suffixed forms resolve
 * to the same document.
 *
 * `void.json` declares the equivalent mapping under `routing.rewrites`, but
 * those are EDGE rules and are NOT honored by the deployed Cloudflare worker
 * (void 0.10.4): verified against dash.wrightful.dev, the root paths reach the
 * Hono router unrewritten and 404 to the not-found page, while the
 * `/api/auth/.well-known/*` targets return 200. `vp dev` simulates the edge
 * rewrite, so the e2e OAuth dance passed there while production discovery was
 * broken. Doing the rewrite here with `c.rewrite()` (the same in-worker
 * mechanism `00.errors.ts` uses for /not-found and /oops) makes discovery work
 * regardless of whether the edge layer honors `void.json`, and — unlike the
 * edge rule — it runs in the actual worker so the workers test lane covers it.
 * The `void.json` rewrites are kept as a redundant edge path in case a future
 * void release starts applying them; keep the two mappings in sync.
 *
 * Runs at `00.*` (before `01.context.ts`) so an unauthenticated discovery fetch
 * short-circuits before the tenant-bundle DB read, and inside `00.errors.ts`'s
 * gate. The rewrite target (`/api/auth/.well-known/*`) is not itself a mapped
 * key, so the re-dispatch cannot loop.
 */
const DISCOVERY_REWRITES: Readonly<Record<string, string>> = {
  "/.well-known/oauth-authorization-server":
    "/api/auth/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/api/mcp":
    "/api/auth/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource":
    "/api/auth/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/api/mcp":
    "/api/auth/.well-known/oauth-protected-resource",
};

/**
 * The `/api/auth/.well-known/*` handler a root discovery path maps onto, or
 * `null` when the path is not an OAuth discovery document. Exported for the
 * mapping test.
 */
export function resolveDiscoveryRewrite(path: string): string | null {
  return DISCOVERY_REWRITES[path] ?? null;
}

export default defineMiddleware(async (c, next) => {
  const target = resolveDiscoveryRewrite(c.req.path);
  if (target) return c.rewrite(target);
  await next();
});
