import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  AuthError,
  backoffDelay,
  isRetryableStatus,
  RegisterArtifactsError,
  StreamClient,
} from "../client.js";
import type { OpenRunPayload } from "../types.js";

// Mock node:fs openAsBlob so uploadArtifact tests don't touch the filesystem.
vi.mock("node:fs", async () => {
  return {
    openAsBlob: async (_path: string, opts?: { type?: string }) => {
      return new Blob([new Uint8Array([1, 2, 3])], {
        type: opts?.type ?? "application/octet-stream",
      });
    },
  };
});

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/**
 * Register a no-op rejection handler on the promise before `runAllTimersAsync`
 * drains the microtask queue. Prevents Node from briefly seeing the rejection
 * as "unhandled" (which vitest surfaces as a test-run error). The original
 * promise still carries its rejection for `expect(...).rejects` to assert on.
 */
function silence<T>(p: Promise<T>): Promise<T> {
  p.catch(() => undefined);
  return p;
}

function emptyResponse(
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(null, { status, headers });
}

const runPayload: OpenRunPayload = {
  idempotencyKey: "key-1",
  run: {
    ciProvider: null,
    ciBuildId: null,
    branch: null,
    environment: null,
    commitSha: null,
    commitMessage: null,
    prNumber: null,
    repo: null,
    actor: null,
    reporterVersion: "0.0.0-dev",
    playwrightVersion: "1.59.0",
    expectedTotalTests: 0,
    plannedTests: [],
  },
};

/**
 * Fake timers are only needed for retry/backoff tests — the production code
 * calls `sleep(...)` (setTimeout) between failed attempts. Happy-path,
 * single-attempt, and 4xx-without-retry tests resolve synchronously and run
 * on real timers. The `retries` nested describe under each method, plus the
 * "network errors" describe, opt in.
 */
function useFakeTimersForRetries(): void {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

describe("StreamClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("openRun", () => {
    it("posts to /api/runs with auth headers and returns runId + runUrl", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(200, { runId: "run_1", runUrl: "/t/a/p/b/runs/run_1" }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const client = new StreamClient("http://dash.example", "tok-1");
      const result = await client.openRun(runPayload);

      expect(result).toEqual({ runId: "run_1", runUrl: "/t/a/p/b/runs/run_1" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://dash.example/api/runs");
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer tok-1");
      expect(init.headers["X-Wrightful-Version"]).toBe("3");
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(init.body)).toEqual(runPayload);
    });

    it("strips a trailing slash from the base URL so it can't build //api/runs", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(200, { runId: "run_1", runUrl: null }),
        );
      vi.stubGlobal("fetch", fetchMock);

      // A WRIGHTFUL_URL with a trailing slash previously yielded a double slash,
      // which 404s on the dashboard and silently drops the whole run.
      const client = new StreamClient("http://dash.example/", "tok-1");
      await client.openRun(runPayload);

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("http://dash.example/api/runs");
    });

    it("throws when the 200 response is missing runId", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));
      vi.stubGlobal("fetch", fetchMock);

      const client = new StreamClient("http://dash.example", "tok");
      await expect(client.openRun(runPayload)).rejects.toThrow(
        /openRun failed/,
      );
    });

    it("throws AuthError on 401 without retry", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(401, { error: "nope" }));
      vi.stubGlobal("fetch", fetchMock);

      const client = new StreamClient("http://dash.example", "tok");
      await expect(client.openRun(runPayload)).rejects.toBeInstanceOf(
        AuthError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("throws AuthError on 403 without retry", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(403, { error: "forbidden" }));
      vi.stubGlobal("fetch", fetchMock);

      const client = new StreamClient("http://dash.example", "tok");
      await expect(client.openRun(runPayload)).rejects.toBeInstanceOf(
        AuthError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    describe("retries", () => {
      useFakeTimersForRetries();

      it("retries on 500 and resolves when a retry succeeds", async () => {
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(jsonResponse(500, { error: "boom" }))
          .mockResolvedValueOnce(jsonResponse(200, { runId: "run_2" }));
        vi.stubGlobal("fetch", fetchMock);

        const client = new StreamClient("http://dash.example", "tok");
        const promise = client.openRun(runPayload);
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result.runId).toBe("run_2");
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      it("retries on 429", async () => {
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(
            jsonResponse(429, { error: "slow down" }, { "Retry-After": "1" }),
          )
          .mockResolvedValueOnce(jsonResponse(200, { runId: "run_3" }));
        vi.stubGlobal("fetch", fetchMock);

        const client = new StreamClient("http://dash.example", "tok");
        const promise = client.openRun(runPayload);
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result.runId).toBe("run_3");
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      it("gives up after maxRetries on persistent 5xx", async () => {
        const fetchMock = vi
          .fn()
          .mockResolvedValue(jsonResponse(500, { error: "boom" }));
        vi.stubGlobal("fetch", fetchMock);

        const client = new StreamClient("http://dash.example", "tok");
        const promise = silence(client.openRun(runPayload));
        await vi.runAllTimersAsync();
        await expect(promise).rejects.toThrow(/openRun failed \(500\)/);
        // Default maxRetries=2 means 3 total attempts.
        expect(fetchMock).toHaveBeenCalledTimes(3);
      });
    });
  });

  describe("appendResults", () => {
    it("returns the server's clientKey → testResultId mapping", async () => {
      const mapping = [{ clientKey: "a", testResultId: "tr_1" }];
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, { results: mapping }));
      vi.stubGlobal("fetch", fetchMock);

      const client = new StreamClient("http://dash.example", "tok");
      const result = await client.appendResults("run_1", []);

      expect(result).toEqual(mapping);
      expect(fetchMock.mock.calls[0][0]).toBe(
        "http://dash.example/api/runs/run_1/results",
      );
    });

    it("returns an empty array when the server omits results[]", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));
      vi.stubGlobal("fetch", fetchMock);

      const client = new StreamClient("http://dash.example", "tok");
      const result = await client.appendResults("run_1", []);
      expect(result).toEqual([]);
    });

    it("throws (no retry) on non-auth 4xx", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(400, { error: "validation failed" }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const client = new StreamClient("http://dash.example", "tok");
      await expect(client.appendResults("run_1", [])).rejects.toThrow(
        /appendResults failed \(400\)/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("surfaces AuthError on 401", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(401, { error: "nope" }));
      vi.stubGlobal("fetch", fetchMock);

      const client = new StreamClient("http://dash.example", "tok");
      await expect(client.appendResults("run_1", [])).rejects.toBeInstanceOf(
        AuthError,
      );
    });
  });

  describe("completeRun", () => {
    it("posts status and duration to /complete", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(emptyResponse(200));
      vi.stubGlobal("fetch", fetchMock);

      const client = new StreamClient("http://dash.example", "tok");
      await client.completeRun("run_1", "passed", 1234);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://dash.example/api/runs/run_1/complete");
      expect(JSON.parse(init.body)).toEqual({
        status: "passed",
        durationMs: 1234,
      });
    });

    it("omits completedAt from the body unless one is supplied", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(emptyResponse(200));
      vi.stubGlobal("fetch", fetchMock);

      const client = new StreamClient("http://dash.example", "tok");
      await client.completeRun("run_1", "passed", 10, { maxRetries: 0 });

      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(init.body)).not.toHaveProperty("completedAt");
    });

    it("forwards an optional completedAt backdate (history seeder path)", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(emptyResponse(200));
      vi.stubGlobal("fetch", fetchMock);

      const client = new StreamClient("http://dash.example", "tok");
      await client.completeRun("run_1", "passed", 1234, {
        completedAt: 1_600_000_000,
      });

      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({
        status: "passed",
        durationMs: 1234,
        completedAt: 1_600_000_000,
      });
    });

    it("respects a caller-supplied maxRetries=0 (single attempt)", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse(500, { error: "boom" }));
      vi.stubGlobal("fetch", fetchMock);

      const client = new StreamClient("http://dash.example", "tok");
      await expect(
        client.completeRun("run_1", "interrupted", 1000, {
          maxRetries: 0,
          timeoutMs: 500,
        }),
      ).rejects.toThrow(/completeRun failed/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    describe("retries", () => {
      useFakeTimersForRetries();

      it("retries up to 6 total attempts by default (maxRetries=5)", async () => {
        const fetchMock = vi
          .fn()
          .mockResolvedValue(jsonResponse(500, { error: "boom" }));
        vi.stubGlobal("fetch", fetchMock);

        const client = new StreamClient("http://dash.example", "tok");
        const promise = silence(client.completeRun("run_1", "failed", 0));
        await vi.runAllTimersAsync();
        await expect(promise).rejects.toThrow(/completeRun failed/);
        expect(fetchMock).toHaveBeenCalledTimes(6);
      });
    });
  });

  describe("registerArtifacts", () => {
    it("posts to /api/artifacts/register and returns uploads[]", async () => {
      const uploads = [
        {
          artifactId: "a_1",
          uploadUrl: "https://r2.example/sig",
          r2Key: "runs/r/t",
        },
      ];
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, { uploads }));
      vi.stubGlobal("fetch", fetchMock);

      const client = new StreamClient("http://dash.example", "tok");
      const result = await client.registerArtifacts("run_1", []);

      expect(result).toEqual(uploads);
      expect(fetchMock.mock.calls[0][0]).toBe(
        "http://dash.example/api/artifacts/register",
      );
    });

    it("throws a RegisterArtifactsError carrying status + maxBytes on 413", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(413, { error: "too big", maxBytes: 1024 }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const client = new StreamClient("http://dash.example", "tok");
      const error = await client
        .registerArtifacts("run_1", [])
        .then(() => null)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(RegisterArtifactsError);
      const typed = error as RegisterArtifactsError;
      expect(typed.status).toBe(413);
      expect(typed.maxBytes).toBe(1024);
    });

    it("leaves maxBytes null when the error body omits it", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(400, { error: "bad" }));
      vi.stubGlobal("fetch", fetchMock);

      const client = new StreamClient("http://dash.example", "tok");
      const error = await client
        .registerArtifacts("run_1", [])
        .then(() => null)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(RegisterArtifactsError);
      expect((error as RegisterArtifactsError).maxBytes).toBeNull();
    });
  });

  describe("uploadArtifact", () => {
    it("omits the Authorization header for cross-origin (hypothetical presigned) URLs", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(emptyResponse(200));
      vi.stubGlobal("fetch", fetchMock);

      const client = new StreamClient("http://dash.example", "tok");
      await client.uploadArtifact(
        "https://r2.cloudflarestorage.com/bucket/key?sig=abc",
        "/tmp/file.png",
        "image/png",
      );

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://r2.cloudflarestorage.com/bucket/key?sig=abc");
      expect(init.method).toBe("PUT");
      expect(init.headers.Authorization).toBeUndefined();
      expect(init.headers["X-Wrightful-Version"]).toBe("3");
      expect(init.headers["Content-Length"]).toBe("3");
    });

    it("includes the Authorization header when uploading back to the dashboard host", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(emptyResponse(200));
      vi.stubGlobal("fetch", fetchMock);

      const client = new StreamClient("http://dash.example", "tok");
      await client.uploadArtifact(
        "http://dash.example/api/artifacts/a_1/upload",
        "/tmp/file.png",
        "image/png",
      );

      const init = fetchMock.mock.calls[0][1];
      expect(init.headers.Authorization).toBe("Bearer tok");
    });

    it("resolves a relative uploadUrl against the dashboard baseUrl and keeps auth", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(emptyResponse(200));
      vi.stubGlobal("fetch", fetchMock);

      const client = new StreamClient("http://dash.example", "tok");
      await client.uploadArtifact(
        "/api/artifacts/a_1/upload",
        "/tmp/file.png",
        "image/png",
      );

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://dash.example/api/artifacts/a_1/upload");
      expect(init.headers.Authorization).toBe("Bearer tok");
    });

    it("throws on 4xx without retry", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(emptyResponse(403));
      vi.stubGlobal("fetch", fetchMock);

      const client = new StreamClient("http://dash.example", "tok");
      await expect(
        client.uploadArtifact(
          "https://r2.example/key",
          "/tmp/file.png",
          "image/png",
        ),
      ).rejects.toThrow(/artifact PUT failed: 403/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    describe("retries", () => {
      useFakeTimersForRetries();

      it("retries on 5xx", async () => {
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(emptyResponse(502))
          .mockResolvedValueOnce(emptyResponse(200));
        vi.stubGlobal("fetch", fetchMock);

        const client = new StreamClient("http://dash.example", "tok");
        const promise = client.uploadArtifact(
          "https://r2.example/key",
          "/tmp/file.png",
          "image/png",
        );
        await vi.runAllTimersAsync();
        await promise;
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      it("gives up after maxRetries on persistent 5xx", async () => {
        const fetchMock = vi.fn().mockResolvedValue(emptyResponse(500));
        vi.stubGlobal("fetch", fetchMock);

        const client = new StreamClient("http://dash.example", "tok");
        const promise = silence(
          client.uploadArtifact(
            "https://r2.example/key",
            "/tmp/file.png",
            "image/png",
          ),
        );
        await vi.runAllTimersAsync();
        await expect(promise).rejects.toThrow(/artifact PUT failed: 500/);
        // Default maxRetries=2 means 3 total attempts.
        expect(fetchMock).toHaveBeenCalledTimes(3);
      });
    });
  });

  describe("network errors", () => {
    useFakeTimersForRetries();

    it("retries on a thrown network error", async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(jsonResponse(200, { runId: "run_1" }));
      vi.stubGlobal("fetch", fetchMock);

      const client = new StreamClient("http://dash.example", "tok");
      const promise = client.openRun(runPayload);
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result.runId).toBe("run_1");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("re-throws the network error after retries are exhausted", async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValue(new TypeError("fetch failed"));
      vi.stubGlobal("fetch", fetchMock);

      const client = new StreamClient("http://dash.example", "tok");
      const promise = silence(client.openRun(runPayload));
      await vi.runAllTimersAsync();
      await expect(promise).rejects.toThrow(/fetch failed/);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});

/**
 * The shared retry policy that fetchWithRetry and uploadArtifact both consume.
 * These are the pure decide-and-wait halves, exercised directly so the rule
 * (which status is retryable, how long to wait) is pinned in one place rather
 * than only reachable by replaying a method against a stubbed fetch.
 */
describe("retry policy", () => {
  describe("isRetryableStatus", () => {
    it("retries 5xx", () => {
      expect(isRetryableStatus(500)).toBe(true);
      expect(isRetryableStatus(502)).toBe(true);
      expect(isRetryableStatus(599)).toBe(true);
    });

    it("retries 429 specifically", () => {
      expect(isRetryableStatus(429)).toBe(true);
    });

    it("does not retry other 4xx (auth/validation are terminal)", () => {
      expect(isRetryableStatus(400)).toBe(false);
      expect(isRetryableStatus(401)).toBe(false);
      expect(isRetryableStatus(403)).toBe(false);
      expect(isRetryableStatus(404)).toBe(false);
    });

    it("does not retry 2xx/3xx", () => {
      expect(isRetryableStatus(200)).toBe(false);
      expect(isRetryableStatus(204)).toBe(false);
      expect(isRetryableStatus(304)).toBe(false);
    });
  });

  describe("backoffDelay", () => {
    it("uses exponential 2^attempt * 500 when no Retry-After", () => {
      const noHeader = new Response(null, { status: 500 });
      expect(backoffDelay(noHeader, 0)).toBe(500);
      expect(backoffDelay(noHeader, 1)).toBe(1000);
      expect(backoffDelay(noHeader, 2)).toBe(2000);
    });

    it("falls back to exponential backoff for a network throw (null response)", () => {
      expect(backoffDelay(null, 0)).toBe(500);
      expect(backoffDelay(null, 3)).toBe(4000);
    });

    it("honours a Retry-After header (seconds) over the backoff curve", () => {
      const withRetryAfter = new Response(null, {
        status: 429,
        headers: { "Retry-After": "2" },
      });
      // 2s wins over the 2^attempt*500 = 500ms the attempt would otherwise use.
      expect(backoffDelay(withRetryAfter, 0)).toBe(2000);
    });

    it("clamps a huge Retry-After to the 30s ceiling", () => {
      const huge = new Response(null, {
        status: 429,
        headers: { "Retry-After": "86400" },
      });
      expect(backoffDelay(huge, 0)).toBe(30_000);
    });

    it("falls back to exponential for an HTTP-date Retry-After (parses to NaN)", () => {
      const dateForm = new Response(null, {
        status: 429,
        headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" },
      });
      // Before the guard this was setTimeout(NaN) → zero backoff.
      expect(backoffDelay(dateForm, 0)).toBe(500);
      expect(backoffDelay(dateForm, 2)).toBe(2000);
    });

    it("falls back to exponential for a negative Retry-After", () => {
      const negative = new Response(null, {
        status: 429,
        headers: { "Retry-After": "-5" },
      });
      expect(backoffDelay(negative, 1)).toBe(1000);
    });

    it("clamps the exponential curve itself to the 30s ceiling", () => {
      expect(backoffDelay(null, 10)).toBe(30_000);
    });
  });
});
