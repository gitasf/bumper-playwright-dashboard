import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/lib/api-key", () => ({
  validateApiKey: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("void/env", () => ({
  env: { WRIGHTFUL_PUBLIC_URL: "https://wrightful.test" },
}));

import { Hono } from "hono";
import { validateApiKey } from "@/lib/api-key";
import { requireMcpAuthOrResponse, type McpTokenAuth } from "@/lib/api-auth";
import type { ApiKey } from "@schema";

/**
 * The OAuth leg of `requireMcpAuthOrResponse` — specifically the expiry check
 * we run OURSELVES because better-auth's `getMcpSession` returns the raw
 * `oauthAccessToken` row without validating `accessTokenExpiresAt` (verified
 * against 1.6.11 source). Nothing else guards this: if the check were dropped
 * in a refactor, expired tokens would be honored forever and no other test
 * would fail. Exercised through a real Hono app so `c.var` / `c.json` behave
 * exactly as they do under the middleware.
 */

interface TokenRow {
  userId: string;
  clientId: string;
  scopes: string | null;
  accessTokenExpiresAt: Date | string | null;
}

const PUBLIC_ORIGIN = "https://wrightful.test";
const REQUEST_ORIGIN = "http://wrightful.test";

function tokenRow(expiresAt: TokenRow["accessTokenExpiresAt"]): TokenRow {
  return {
    userId: "user_1",
    clientId: "client_1",
    scopes: "openid",
    accessTokenExpiresAt: expiresAt,
  };
}

/**
 * Run one request through the gate. `row` is what the stubbed
 * `getMcpSession` resolves the Bearer token to (null = unknown token).
 */
async function gate(
  row: TokenRow | null,
  opts: { header?: string; withAuthInstance?: boolean } = {},
): Promise<{ res: Response; sessionCalls: number; grantedUserId?: string }> {
  const { header = "Bearer some-oauth-token", withAuthInstance = true } = opts;
  let sessionCalls = 0;
  let grantedUserId: string | undefined;

  // `mcpAuth` is declared on void's CloudContextVariables; a bare test app
  // needs the same variable declared to read the stash back out.
  const app = new Hono<{ Variables: { mcpAuth?: McpTokenAuth } }>();
  app.use(async (c, next) => {
    if (withAuthInstance) {
      // void's auth middleware stashes the live betterAuth() instance here;
      // requireMcpAuthOrResponse reads it structurally.
      c.set(
        "__voidAuth" as never,
        {
          api: {
            getMcpSession: () => {
              sessionCalls++;
              return Promise.resolve(row);
            },
          },
        } as never,
      );
    }
    await next();
  });
  app.post("/api/mcp", async (c) => {
    const result = await requireMcpAuthOrResponse(c);
    if (result instanceof Response) return result;
    grantedUserId = c.get("mcpAuth")?.userId;
    return c.json({ ok: true });
  });

  const headers = new Headers();
  if (header) headers.set("Authorization", header);
  const res = await app.request(`${REQUEST_ORIGIN}/api/mcp`, {
    method: "POST",
    headers,
  });
  return { res, sessionCalls, grantedUserId };
}

describe("requireMcpAuthOrResponse — OAuth token expiry", () => {
  it("accepts a token with a future expiry and stashes mcpAuth", async () => {
    const { res, grantedUserId } = await gate(
      tokenRow(new Date(Date.now() + 60_000)),
    );
    expect(res.status).toBe(200);
    expect(grantedUserId).toBe("user_1");
  });

  it("rejects a token whose expiry has passed (the plugin does NOT check this)", async () => {
    const { res } = await gate(tokenRow(new Date(Date.now() - 1_000)));
    expect(res.status).toBe(401);
  });

  it("coerces a string expiry (driver-dependent row shape) — past rejects, future passes", async () => {
    const past = await gate(
      tokenRow(new Date(Date.now() - 1_000).toISOString()),
    );
    expect(past.res.status).toBe(401);
    const future = await gate(
      tokenRow(new Date(Date.now() + 60_000).toISOString()),
    );
    expect(future.res.status).toBe(200);
  });

  it("fails CLOSED on an unparsable expiry rather than treating it as eternal", async () => {
    const { res } = await gate(tokenRow("not-a-date"));
    expect(res.status).toBe(401);
  });

  it("treats a null expiry as non-expiring (token minted without a TTL)", async () => {
    const { res } = await gate(tokenRow(null));
    expect(res.status).toBe(200);
  });
});

describe("requireMcpAuthOrResponse — credential resolution", () => {
  it("rejects an unknown token (getMcpSession → null)", async () => {
    const { res } = await gate(null);
    expect(res.status).toBe(401);
  });

  it("never consults the OAuth session for a non-Bearer Authorization header", async () => {
    const { res, sessionCalls } = await gate(tokenRow(null), {
      header: "Basic dXNlcjpwYXNz",
    });
    expect(res.status).toBe(401);
    expect(sessionCalls).toBe(0);
  });

  it("fails closed when void's auth instance is missing from the context", async () => {
    const { res } = await gate(tokenRow(null), { withAuthInstance: false });
    expect(res.status).toBe(401);
  });

  it("carries the WWW-Authenticate resource_metadata challenge on EVERY 401", async () => {
    // This header is what triggers an MCP client's OAuth flow — a 401
    // without it strands the client instead of bouncing it into authorize.
    for (const row of [null, tokenRow(new Date(Date.now() - 1_000))]) {
      const { res } = await gate(row);
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe(
        `Bearer resource_metadata="${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource"`,
      );
    }
  });

  it("prefers a valid project API key and skips the OAuth lookup entirely", async () => {
    vi.mocked(validateApiKey).mockResolvedValueOnce({
      id: "key_1",
    } as ApiKey);
    const { res, sessionCalls, grantedUserId } = await gate(tokenRow(null));
    expect(res.status).toBe(200);
    expect(sessionCalls).toBe(0);
    expect(grantedUserId).toBeUndefined();
  });
});
