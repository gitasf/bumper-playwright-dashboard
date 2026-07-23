import { describe, it, expect } from "vite-plus/test";
import { checkRateLimit } from "@/lib/rate-limit";
import apiAuthMiddleware from "../../middleware/02.api-auth";
import rateLimitMiddleware from "../../middleware/03.rate-limit";

/**
 * Regression test for the rate limiter being wired up (middleware/03.rate-limit.ts).
 * The pre-launch MVP shipped with the limiter declared but never invoked; this
 * pins the allow/block/fail-open contract so it can't silently regress to dead
 * code again.
 */
function envWith(success: boolean) {
  return {
    API_RATE_LIMITER: {
      limit: (_input: { key: string }) => Promise.resolve({ success }),
    },
  };
}

describe("checkRateLimit", () => {
  it("fails open when the binding is absent (local dev / miniflare)", async () => {
    expect(await checkRateLimit({}, "API_RATE_LIMITER", "k")).toBe(true);
  });

  it("skips the limiter (allows) when the key is null", async () => {
    expect(await checkRateLimit(envWith(false), "API_RATE_LIMITER", null)).toBe(
      true,
    );
  });

  it("allows when the limiter reports the key under budget", async () => {
    expect(await checkRateLimit(envWith(true), "API_RATE_LIMITER", "k")).toBe(
      true,
    );
  });

  it("blocks (429) when the limiter reports the key over budget", async () => {
    expect(await checkRateLimit(envWith(false), "API_RATE_LIMITER", "k")).toBe(
      false,
    );
  });

  it("keys each request through to the limiter", async () => {
    const seen: string[] = [];
    const env = {
      API_RATE_LIMITER: {
        limit: (input: { key: string }) => {
          seen.push(input.key);
          return Promise.resolve({ success: true });
        },
      },
    };
    await checkRateLimit(env, "API_RATE_LIMITER", "tenant-123");
    expect(seen).toEqual(["tenant-123"]);
  });
});

function fakeContext(
  path: string,
  env: unknown,
  apiKey?: { id: string },
  mcpAuth?: { userId: string },
  ip?: string,
): never {
  return {
    req: {
      path,
      raw: new Request(`http://localhost${path}`, {
        headers: ip ? { "CF-Connecting-IP": ip } : undefined,
      }),
    },
    env,
    get: (k: string) =>
      k === "apiKey" ? apiKey : k === "mcpAuth" ? mcpAuth : undefined,
  } as never;
}

describe("03.rate-limit middleware", () => {
  it("returns a 429 on an ingest path when the limiter is over budget", async () => {
    const c = fakeContext("/api/runs/abc/results", envWith(false), {
      id: "key_1",
    });
    let nextCalled = false;
    const res = await rateLimitMiddleware(c, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(429);
  });

  it("calls next on an ingest path when under budget", async () => {
    const c = fakeContext("/api/runs/abc/results", envWith(true), {
      id: "key_1",
    });
    let nextCalled = false;
    await rateLimitMiddleware(c, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it("throttles the artifact-upload ingest path (shared isIngestRoute branch)", async () => {
    // Closes the CI gap: the artifact half of the ingest surface was never
    // driven through 03. Because 02 and 03 share `isIngestRoute`, asserting it
    // here pins the matcher for both gates.
    const c = fakeContext("/api/artifacts/art_1/upload", envWith(false), {
      id: "key_1",
    });
    let nextCalled = false;
    const res = await rateLimitMiddleware(c, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(429);
  });

  it("keys /api/mcp by the OAuth token's userId when no API key is stashed", async () => {
    // The query-surface branch resolves apiKey.id ?? mcpAuth.userId ?? IP.
    // OAuth-authed MCP requests carry no apiKey, so a user's agents must
    // share the user budget — not hide behind per-IP keys.
    const seen: string[] = [];
    const env = {
      QUERY_RATE_LIMITER: {
        limit: (input: { key: string }) => {
          seen.push(input.key);
          return Promise.resolve({ success: true });
        },
      },
    };
    await rateLimitMiddleware(
      fakeContext("/api/mcp", env, undefined, { userId: "user_42" }),
      async () => {},
    );
    expect(seen).toEqual(["user_42"]);
  });

  it("keys /api/mcp by apiKey.id when the request is key-authed (wins over mcpAuth)", async () => {
    const seen: string[] = [];
    const env = {
      QUERY_RATE_LIMITER: {
        limit: (input: { key: string }) => {
          seen.push(input.key);
          return Promise.resolve({ success: true });
        },
      },
    };
    await rateLimitMiddleware(
      fakeContext("/api/mcp", env, { id: "key_9" }, { userId: "user_42" }),
      async () => {},
    );
    expect(seen).toEqual(["key_9"]);
  });

  it("returns a 429 on /api/mcp for an over-budget OAuth user", async () => {
    const env = {
      QUERY_RATE_LIMITER: {
        limit: (_input: { key: string }) => Promise.resolve({ success: false }),
      },
    };
    let nextCalled = false;
    const res = await rateLimitMiddleware(
      fakeContext("/api/mcp", env, undefined, { userId: "user_42" }),
      async () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(false);
    expect((res as Response).status).toBe(429);
  });

  it("does not throttle unmatched (non-API) paths", async () => {
    const c = fakeContext("/t/team/p/proj", envWith(false));
    let nextCalled = false;
    await rateLimitMiddleware(c, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it("keys the artifact download by IP + artifactId, not the id alone", async () => {
    const seen: string[] = [];
    const env = {
      ARTIFACT_RATE_LIMITER: {
        limit: (input: { key: string }) => {
          seen.push(input.key);
          return Promise.resolve({ success: true });
        },
      },
    };
    await rateLimitMiddleware(
      fakeContext(
        "/api/artifacts/art_1/download",
        env,
        undefined,
        undefined,
        "203.0.113.9",
      ),
      async () => {},
    );
    expect(seen).toEqual(["203.0.113.9:art_1"]);
  });

  it("returns a 429 on an over-budget artifact download", async () => {
    const env = {
      ARTIFACT_RATE_LIMITER: {
        limit: (_input: { key: string }) => Promise.resolve({ success: false }),
      },
    };
    let nextCalled = false;
    const res = await rateLimitMiddleware(
      fakeContext("/api/artifacts/art_1/download", env),
      async () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(false);
    expect((res as Response).status).toBe(429);
  });

  it("throttles the session tenant API (incl. the CSV export) under QUERY, keyed by IP", async () => {
    // The /api/t/* family is cookie-authed — no Bearer key is ever stashed —
    // and previously fell through this middleware entirely, leaving the
    // expensive export/runs cursor walk (up to WRIGHTFUL_EXPORT_MAX_ROWS at
    // 500/page) unthrottled.
    const seen: string[] = [];
    const env = {
      QUERY_RATE_LIMITER: {
        limit: (input: { key: string }) => {
          seen.push(input.key);
          return Promise.resolve({ success: true });
        },
      },
    };
    await rateLimitMiddleware(
      fakeContext(
        "/api/t/acme/p/web/export/runs",
        env,
        undefined,
        undefined,
        "203.0.113.9",
      ),
      async () => {},
    );
    expect(seen).toEqual(["203.0.113.9"]);
  });

  it("returns a 429 on an over-budget tenant-API export request", async () => {
    const env = {
      QUERY_RATE_LIMITER: {
        limit: (_input: { key: string }) => Promise.resolve({ success: false }),
      },
    };
    let nextCalled = false;
    const res = await rateLimitMiddleware(
      fakeContext("/api/t/acme/p/web/export/runs", env),
      async () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(false);
    expect((res as Response).status).toBe(429);
  });
});

/**
 * The pre-auth IP backstop in 02.api-auth: failed-auth requests return from 02
 * before 03's per-key gate ever runs, so 02 must consume an IP-keyed budget
 * BEFORE the Bearer lookup — otherwise an unauthenticated client can spray
 * bogus keys at an unbounded rate, each attempt costing a D1 prefix SELECT.
 */
describe("02.api-auth pre-auth IP backstop", () => {
  function ingestEnvWith(success: boolean) {
    return {
      INGEST_IP_RATE_LIMITER: {
        limit: (_input: { key: string }) => Promise.resolve({ success }),
      },
    };
  }

  it("returns 429 on an ingest path when the IP budget is exhausted — before auth runs", async () => {
    // No apiKey stash, no Authorization header: if the middleware reached the
    // Bearer lookup it would hit the guarded void/db stub and throw. Returning
    // a clean 429 therefore also proves the check precedes auth.
    const c = fakeContext("/api/runs/abc/results", ingestEnvWith(false));
    let nextCalled = false;
    const res = await apiAuthMiddleware(c, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(429);
  });

  it("leaves non-ingest paths untouched even with an exhausted IP budget", async () => {
    const c = fakeContext("/api/auth/sign-in", ingestEnvWith(false));
    let nextCalled = false;
    await apiAuthMiddleware(c, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });
});
