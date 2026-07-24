import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * Guards MCP OAuth discovery at the origin root. void 0.10.4 does not apply the
 * `void.json` `routing.rewrites` in the deployed worker, so
 * `middleware/00.oauth-discovery.ts` rewrites the four RFC 9728 `.well-known`
 * paths onto Better Auth's `/api/auth/.well-known/*` handlers in-worker. If this
 * regressed, an MCP client's `WWW-Authenticate` challenge would resolve to a
 * 404 and the whole OAuth flow would never start — a failure `vp dev` hides
 * because it simulates the edge rewrite this replaces.
 */

vi.mock("void", () => ({
  defineMiddleware: (fn: unknown) => fn,
}));

const discoveryMiddleware = (
  await import("../../middleware/00.oauth-discovery")
).default as (c: unknown, next: () => Promise<void>) => Promise<unknown>;
const { resolveDiscoveryRewrite } =
  await import("../../middleware/00.oauth-discovery");

// Minimal Hono-context stand-in: the middleware only reads `req.path` and calls
// `c.rewrite(target)`, which void resolves to the target handler's Response.
function ctx(path: string) {
  const rewrite = vi.fn(
    async (target: string) =>
      new Response(`served:${target}`, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  return { ctx: { req: { path }, rewrite }, rewrite };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveDiscoveryRewrite mapping", () => {
  it.each([
    [
      "/.well-known/oauth-protected-resource",
      "/api/auth/.well-known/oauth-protected-resource",
    ],
    [
      "/.well-known/oauth-protected-resource/api/mcp",
      "/api/auth/.well-known/oauth-protected-resource",
    ],
    [
      "/.well-known/oauth-authorization-server",
      "/api/auth/.well-known/oauth-authorization-server",
    ],
    [
      "/.well-known/oauth-authorization-server/api/mcp",
      "/api/auth/.well-known/oauth-authorization-server",
    ],
  ])("maps %s onto the Better Auth handler", (path, target) => {
    expect(resolveDiscoveryRewrite(path)).toBe(target);
  });

  it.each([
    "/api/mcp",
    "/api/auth/.well-known/oauth-protected-resource", // the target — must not remap (no loop)
    "/.well-known/openid-configuration",
    "/",
  ])("returns null for non-discovery path %s", (path) => {
    expect(resolveDiscoveryRewrite(path)).toBeNull();
  });
});

describe("00.oauth-discovery middleware", () => {
  it("rewrites a root discovery path in-worker and returns the target's response", async () => {
    const { ctx: c, rewrite } = ctx("/.well-known/oauth-protected-resource");
    const next = vi.fn(async () => {});

    const res = (await discoveryMiddleware(c, next)) as Response;

    expect(rewrite).toHaveBeenCalledWith(
      "/api/auth/.well-known/oauth-protected-resource",
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      "served:/api/auth/.well-known/oauth-protected-resource",
    );
  });

  it("passes non-discovery requests through untouched", async () => {
    const { ctx: c, rewrite } = ctx("/api/mcp");
    const next = vi.fn(async () => {});

    await discoveryMiddleware(c, next);

    expect(rewrite).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});
