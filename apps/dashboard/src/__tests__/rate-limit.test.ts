import { describe, it, expect } from "vite-plus/test";
import { checkRateLimit } from "@/lib/rate-limit";
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
): never {
  return {
    req: { path, raw: new Request(`http://localhost${path}`) },
    env,
    get: (k: string) => (k === "apiKey" ? apiKey : undefined),
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

  it("does not throttle unmatched (non-API) paths", async () => {
    const c = fakeContext("/t/team/p/proj", envWith(false));
    let nextCalled = false;
    await rateLimitMiddleware(c, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });
});
