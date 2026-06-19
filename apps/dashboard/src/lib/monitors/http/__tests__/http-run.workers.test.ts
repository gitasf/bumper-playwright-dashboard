import { describe, expect, it, vi } from "vite-plus/test";
import { type HttpRunDeps, runHttpCheck } from "@/lib/monitors/http/http-run";
import type { HttpMonitorConfig } from "@/lib/monitors/monitor-schemas";
import type { Monitor, MonitorExecution } from "@/lib/monitors/types";

/**
 * `runHttpCheck` is the pure, DI'd http-check lifecycle. These pin the whole
 * outcome model with an injected fetch + clock: pass / degraded / fail-by-status
 * / fail-by-assertion / fail-by-threshold, the `shouldFail` inversion, redirect
 * policy passthrough, timeout vs network-throw (both → `fail`, never `error`),
 * the body byte-cap, and the invalid-config terminal error.
 */

const BASE_CONFIG: HttpMonitorConfig = {
  url: "https://example.com",
  followRedirects: true,
  shouldFail: false,
  degradedResponseTimeMs: 3000,
  maxResponseTimeMs: 5000,
  assertions: [],
};

function monitorWith(
  config: Partial<HttpMonitorConfig> | string | null,
): Monitor {
  const configText =
    typeof config === "string" || config === null
      ? config
      : JSON.stringify({ ...BASE_CONFIG, ...config });
  return {
    id: "m1",
    teamId: "team-1",
    projectId: "proj-1",
    name: "uptime",
    type: "http",
    enabled: 1,
    source: null,
    config: configText,
    intervalSeconds: 60,
    schedulingStrategy: "round_robin",
    retryConfig: null,
    nextRunAt: null,
    lastEnqueuedAt: null,
    lastRunAt: null,
    lastStatus: null,
    createdBy: "user-1",
    createdAt: 0,
    updatedAt: 0,
  } as Monitor;
}

const EXECUTION = {
  id: "ex-1",
  projectId: "proj-1",
  monitorId: "m1",
  scheduledFor: 0,
  state: "running",
  attempt: 0,
  createdAt: 0,
} as MonitorExecution;

/** A clock whose final-minus-first delta is `totalMs`. */
function clock(totalMs: number): () => number {
  const seq = [0, totalMs, totalMs, totalMs, totalMs];
  let i = 0;
  return () => seq[Math.min(i++, seq.length - 1)]!;
}

function jsonResponse(
  status: number,
  body = "",
  headers: Record<string, string> = {},
): Response {
  return new Response(body === "" ? null : body, { status, headers });
}

/**
 * A redirected Response — the `Response` constructor can't set `redirected`/
 * `url`, so build a structural stand-in carrying exactly what `runHttpCheck`
 * reads (status, redirected, url, headers, body).
 */
function redirectedResponse(finalUrl: string, status = 200): Response {
  return {
    status,
    redirected: true,
    url: finalUrl,
    headers: new Headers(),
    body: new Response("ok").body,
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- structural test stand-in
  } as unknown as Response;
}

interface RunOpts {
  config?: Partial<HttpMonitorConfig> | string | null;
  fetchImpl?: HttpRunDeps["fetchImpl"];
  totalMs?: number;
  maxBodyBytes?: number;
  makeSignal?: () => AbortSignal;
}

function run(opts: RunOpts) {
  const monitor =
    typeof opts.config === "string" || opts.config === null
      ? monitorWith(opts.config)
      : monitorWith(opts.config ?? {});
  return runHttpCheck(
    { monitor, execution: EXECUTION },
    {
      fetchImpl: opts.fetchImpl ?? (() => Promise.resolve(jsonResponse(200))),
      now: clock(opts.totalMs ?? 100),
      maxBodyBytes: opts.maxBodyBytes ?? 262_144,
      hardTimeoutMs: 30_000,
      makeSignal: opts.makeSignal ?? (() => new AbortController().signal),
    },
  );
}

describe("runHttpCheck — happy paths", () => {
  it("passes a fast 200 with no assertions", async () => {
    const r = await run({ totalMs: 80 });
    expect(r.state).toBe("pass");
    expect(r.statusCode).toBe(200);
    expect(r.infraError).toBe(false);
    expect(r.errorMessage).toBe(null);
    expect(r.durationMs).toBe(80);
    expect(r.resultDetail?.timings.totalMs).toBe(80);
  });

  it("marks a slow-but-OK response degraded", async () => {
    const r = await run({
      config: { degradedResponseTimeMs: 50, maxResponseTimeMs: 5000 },
      totalMs: 100,
    });
    expect(r.state).toBe("degraded");
    expect(r.statusCode).toBe(200);
    expect(r.errorMessage).toMatch(/slow response/i);
  });
});

describe("runHttpCheck — failures", () => {
  it("fails on a 4xx/5xx status", async () => {
    const r = await run({
      fetchImpl: () => Promise.resolve(jsonResponse(503)),
    });
    expect(r.state).toBe("fail");
    expect(r.statusCode).toBe(503);
    expect(r.errorMessage).toMatch(/HTTP 503/);
    expect(r.infraError).toBe(false);
  });

  it("fails when an assertion fails (and keeps statusCode)", async () => {
    const r = await run({
      config: {
        assertions: [
          { source: "STATUS_CODE", comparison: "EQUALS", target: "201" },
        ],
      },
    });
    expect(r.state).toBe("fail");
    expect(r.statusCode).toBe(200);
    expect(r.errorMessage).toMatch(/assertion failed/i);
    expect(r.resultDetail?.assertions[0]?.pass).toBe(false);
  });

  it("fails when over the max response time", async () => {
    const r = await run({
      config: { degradedResponseTimeMs: 50, maxResponseTimeMs: 100 },
      totalMs: 300,
    });
    expect(r.state).toBe("fail");
    expect(r.errorMessage).toMatch(/exceeded the 100ms limit/);
  });
});

describe("runHttpCheck — shouldFail inversion", () => {
  it("passes when a should-fail check gets a 5xx", async () => {
    const r = await run({
      config: { shouldFail: true },
      fetchImpl: () => Promise.resolve(jsonResponse(503)),
    });
    expect(r.state).toBe("pass");
    expect(r.statusCode).toBe(503);
  });

  it("fails when a should-fail check gets a 2xx", async () => {
    const r = await run({ config: { shouldFail: true } });
    expect(r.state).toBe("fail");
    expect(r.errorMessage).toMatch(/expected a failing/i);
  });
});

describe("runHttpCheck — redirect policy", () => {
  it("passes redirect:'follow' / 'manual' to fetch per config", async () => {
    const fetchImpl = vi.fn<HttpRunDeps["fetchImpl"]>(() =>
      Promise.resolve(jsonResponse(200)),
    );
    await run({ config: { followRedirects: true }, fetchImpl });
    expect(fetchImpl.mock.calls[0]![1]?.redirect).toBe("follow");

    fetchImpl.mockClear();
    await run({ config: { followRedirects: false }, fetchImpl });
    expect(fetchImpl.mock.calls[0]![1]?.redirect).toBe("manual");
  });
});

describe("runHttpCheck — redirect re-validation", () => {
  it("fails a check that redirects to a private/loopback host", async () => {
    const r = await run({
      config: { followRedirects: true },
      fetchImpl: () =>
        Promise.resolve(redirectedResponse("http://127.0.0.1/internal")),
    });
    expect(r.state).toBe("fail");
    expect(r.statusCode).toBe(null);
    expect(r.infraError).toBe(false);
    expect(r.errorMessage).toMatch(/disallowed URL/i);
    expect(r.resultDetail?.finalUrl).toBe("http://127.0.0.1/internal");
  });

  it("allows a redirect to another public host", async () => {
    const r = await run({
      config: { followRedirects: true },
      fetchImpl: () =>
        Promise.resolve(redirectedResponse("https://www.example.org/")),
    });
    expect(r.state).toBe("pass");
    expect(r.resultDetail?.redirected).toBe(true);
  });
});

describe("runHttpCheck — unreachable site", () => {
  it("records a timeout as a fail (not an infra error)", async () => {
    const r = await run({
      fetchImpl: () =>
        Promise.reject(new DOMException("aborted", "AbortError")),
      makeSignal: () => AbortSignal.abort(),
    });
    expect(r.state).toBe("fail");
    expect(r.statusCode).toBe(null);
    expect(r.infraError).toBe(false);
    expect(r.errorMessage).toMatch(/timed out/i);
  });

  it("records a network throw as a fail (not an infra error)", async () => {
    const r = await run({
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    expect(r.state).toBe("fail");
    expect(r.statusCode).toBe(null);
    expect(r.infraError).toBe(false);
    expect(r.errorMessage).toMatch(/request failed.*ECONNREFUSED/i);
  });
});

describe("runHttpCheck — body cap + excerpt", () => {
  it("truncates the body to the byte cap before evaluating", async () => {
    const r = await run({
      maxBodyBytes: 5,
      fetchImpl: () => Promise.resolve(jsonResponse(200, "abcdefghij")),
      config: {
        assertions: [
          { source: "TEXT_BODY", comparison: "EQUALS", target: "abcde" },
        ],
      },
    });
    // The assertion only passes if the body was capped to the first 5 bytes.
    expect(r.resultDetail?.assertions[0]?.pass).toBe(true);
    expect(r.state).toBe("pass");
  });

  it("keeps a body excerpt only when a body assertion failed", async () => {
    const r = await run({
      fetchImpl: () => Promise.resolve(jsonResponse(200, "hello world")),
      config: {
        assertions: [
          { source: "TEXT_BODY", comparison: "CONTAINS", target: "goodbye" },
        ],
      },
    });
    expect(r.state).toBe("fail");
    expect(r.resultDetail?.bodyExcerpt).toContain("hello world");
  });

  it("omits the excerpt on a healthy check", async () => {
    const r = await run({
      fetchImpl: () => Promise.resolve(jsonResponse(200, "hello world")),
    });
    expect(r.resultDetail?.bodyExcerpt).toBeUndefined();
  });
});

describe("runHttpCheck — invalid config", () => {
  it("settles terminally (error, not retried) when config is missing", async () => {
    const r = await run({ config: null });
    expect(r.state).toBe("error");
    expect(r.infraError).toBe(false);
    expect(r.errorMessage).toMatch(/no valid http config/i);
  });

  it("settles terminally when config JSON is malformed", async () => {
    const r = await run({ config: "{not json" });
    expect(r.state).toBe("error");
    expect(r.infraError).toBe(false);
  });
});
