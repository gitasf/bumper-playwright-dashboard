import {
  describe,
  it,
  expect,
  vi,
  afterEach,
  beforeEach,
} from "vite-plus/test";
import type { FullResult } from "@playwright/test/reporter";
import WrightfulReporter from "../index.js";
import { makeConfig, makeSuite, makeTest } from "./fixtures.js";

// Block CI auto-detection so the OpenRunPayload shape is deterministic.
const CI_ENV_VARS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "GITHUB_RUN_ID",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_HEAD_REF",
  "GITHUB_SHA",
  "GITHUB_REPOSITORY",
  "GITHUB_ACTOR",
  "GITHUB_TRIGGERING_ACTOR",
];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeFetch(): {
  calls: FetchCall[];
  fn: (url: string, init: RequestInit) => Promise<Response>;
} {
  const calls: FetchCall[] = [];
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/api/runs")) {
      return jsonResponse(200, { runId: "run_abc" });
    }
    if (url.includes("/results")) {
      return jsonResponse(200, { results: [] });
    }
    if (url.endsWith("/complete")) {
      return jsonResponse(200, {});
    }
    return jsonResponse(200, {});
  };
  return { calls, fn };
}

describe("WrightfulReporter signal handling", () => {
  let originalEnv: Record<string, string | undefined>;
  let exitMock: ReturnType<typeof vi.fn>;
  let killMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalEnv = {};
    for (const k of CI_ENV_VARS) {
      originalEnv[k] = process.env[k];
      delete process.env[k];
    }
    delete process.env.WRIGHTFUL_URL;
    delete process.env.WRIGHTFUL_TOKEN;

    // The signal handler never calls process.exit — Playwright owns the exit
    // code. We spy on it so a regression that reintroduces the call can't kill
    // the test runner, and assert it is NOT invoked.
    exitMock = vi.fn() as never;
    vi.spyOn(process, "exit").mockImplementation(exitMock);
    // On SIGTERM the handler RE-RAISES the signal (`process.kill(pid, SIGTERM)`)
    // to pass it through to the default terminate once the best-effort /complete
    // settles — Playwright <=1.61 doesn't watch SIGTERM. Mock process.kill so
    // that real signal never actually kills this worker, and assert the
    // pass-through happened.
    killMock = vi.fn() as never;
    vi.spyOn(process, "kill").mockImplementation(killMock as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("installs SIGTERM and SIGINT handlers on onBegin", () => {
    const { fn } = makeFetch();
    vi.stubGlobal("fetch", vi.fn(fn));

    const beforeTerm = process.listenerCount("SIGTERM");
    const beforeInt = process.listenerCount("SIGINT");

    const reporter = new WrightfulReporter({
      url: "http://dash.example",
      token: "tok",
      flushIntervalMs: 5,
    });
    reporter.onBegin(makeConfig(), makeSuite([]));

    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);
  });

  it("on SIGTERM, fires a best-effort /complete with status='interrupted' then re-raises SIGTERM (no process.exit)", async () => {
    const { calls, fn } = makeFetch();
    vi.stubGlobal("fetch", vi.fn(fn));

    const reporter = new WrightfulReporter({
      url: "http://dash.example",
      token: "tok",
      flushIntervalMs: 5,
    });
    reporter.onBegin(
      makeConfig(),
      makeSuite([makeTest({ outcome: "expected" })]),
    );

    // Wait for openRun to resolve and runId to be set.
    await new Promise((r) => setTimeout(r, 20));

    process.emit("SIGTERM" as NodeJS.Signals, "SIGTERM" as NodeJS.Signals);

    // Allow the async handler to flush.
    await new Promise((r) => setTimeout(r, 50));

    const completeCall = calls.find((c) => c.url.endsWith("/complete"));
    expect(completeCall).toBeDefined();
    const rawBody = completeCall!.init.body;
    const body = JSON.parse(typeof rawBody === "string" ? rawBody : "");
    expect(body.status).toBe("interrupted");
    expect(typeof body.durationMs).toBe("number");

    // We never call process.exit (Playwright owns the exit code) — instead we
    // RE-RAISE SIGTERM so the default terminate runs (Playwright <=1.61 ignores
    // SIGTERM, and installing our listener otherwise suppresses the default).
    expect(exitMock).not.toHaveBeenCalled();
    expect(killMock).toHaveBeenCalledWith(process.pid, "SIGTERM");
  });

  it("on SIGINT, fires best-effort /complete and lets Playwright own termination (no process.exit, no re-raise)", async () => {
    const { calls, fn } = makeFetch();
    vi.stubGlobal("fetch", vi.fn(fn));

    const reporter = new WrightfulReporter({
      url: "http://dash.example",
      token: "tok",
      flushIntervalMs: 5,
    });
    reporter.onBegin(
      makeConfig(),
      makeSuite([makeTest({ outcome: "expected" })]),
    );
    await new Promise((r) => setTimeout(r, 20));

    process.emit("SIGINT" as NodeJS.Signals, "SIGINT" as NodeJS.Signals);
    await new Promise((r) => setTimeout(r, 50));

    expect(calls.find((c) => c.url.endsWith("/complete"))).toBeDefined();
    expect(exitMock).not.toHaveBeenCalled();
    // SIGINT defers to Playwright's own handler — we must NOT re-raise it.
    expect(killMock).not.toHaveBeenCalled();
  });

  it("ignores subsequent signals once shutdown is in flight (single-shot)", async () => {
    const { calls, fn } = makeFetch();
    vi.stubGlobal("fetch", vi.fn(fn));

    const reporter = new WrightfulReporter({
      url: "http://dash.example",
      token: "tok",
      flushIntervalMs: 5,
    });
    reporter.onBegin(makeConfig(), makeSuite([]));
    await new Promise((r) => setTimeout(r, 20));

    process.emit("SIGTERM" as NodeJS.Signals, "SIGTERM" as NodeJS.Signals);
    process.emit("SIGTERM" as NodeJS.Signals, "SIGTERM" as NodeJS.Signals);
    process.emit("SIGINT" as NodeJS.Signals, "SIGINT" as NodeJS.Signals);
    await new Promise((r) => setTimeout(r, 50));

    const completeCalls = calls.filter((c) => c.url.endsWith("/complete"));
    expect(completeCalls).toHaveLength(1);
    // Single-shot guard fires /complete once; we never call process.exit.
    expect(exitMock).not.toHaveBeenCalled();
  });

  it("swallows errors from the shutdown /complete without crashing", async () => {
    let openCalled = false;
    const fetchFn = async (url: string) => {
      if (url.endsWith("/api/runs") && !openCalled) {
        openCalled = true;
        return jsonResponse(200, { runId: "run_abc" });
      }
      if (url.endsWith("/complete")) {
        // Simulate the dashboard being unreachable mid-shutdown.
        throw new TypeError("fetch failed");
      }
      return jsonResponse(200, {});
    };
    vi.stubGlobal("fetch", vi.fn(fetchFn));

    const reporter = new WrightfulReporter({
      url: "http://dash.example",
      token: "tok",
      flushIntervalMs: 5,
    });
    reporter.onBegin(makeConfig(), makeSuite([]));
    await new Promise((r) => setTimeout(r, 20));

    process.emit("SIGTERM" as NodeJS.Signals, "SIGTERM" as NodeJS.Signals);
    await new Promise((r) => setTimeout(r, 50));

    // Even though /complete threw, the handler resolves cleanly and does not
    // call process.exit (Playwright owns termination).
    expect(exitMock).not.toHaveBeenCalled();
  });

  it("onEnd is a no-op once shutdown has fired (avoids double-complete)", async () => {
    const { calls, fn } = makeFetch();
    vi.stubGlobal("fetch", vi.fn(fn));

    const reporter = new WrightfulReporter({
      url: "http://dash.example",
      token: "tok",
      flushIntervalMs: 5,
    });
    reporter.onBegin(makeConfig(), makeSuite([]));
    await new Promise((r) => setTimeout(r, 20));

    process.emit("SIGTERM" as NodeJS.Signals, "SIGTERM" as NodeJS.Signals);
    await new Promise((r) => setTimeout(r, 50));

    const beforeEndCount = calls.filter((c) =>
      c.url.endsWith("/complete"),
    ).length;

    await reporter.onEnd({
      status: "passed",
      startTime: new Date(),
      duration: 0,
    } as FullResult);

    const afterEndCount = calls.filter((c) =>
      c.url.endsWith("/complete"),
    ).length;
    expect(afterEndCount).toBe(beforeEndCount);
  });

  it("does nothing when streaming is disabled (no client / no runId)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // No URL/token → reporter never creates a client.
    const reporter = new WrightfulReporter({});
    reporter.onBegin(makeConfig(), makeSuite([]));

    // The disabled-path early-returns before installing handlers, so emitting
    // SIGTERM should not call process.exit (no handler installed by us).
    process.emit("SIGTERM" as NodeJS.Signals, "SIGTERM" as NodeJS.Signals);
    await new Promise((r) => setTimeout(r, 20));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a short timeout for the shutdown /complete (does not retry)", async () => {
    let openCalled = false;
    const completeStarts: number[] = [];
    const completeState: { rejector: ((err: Error) => void) | null } = {
      rejector: null,
    };

    const fetchFn = async (url: string) => {
      if (url.endsWith("/api/runs") && !openCalled) {
        openCalled = true;
        return jsonResponse(200, { runId: "run_abc" });
      }
      if (url.endsWith("/complete")) {
        completeStarts.push(Date.now());
        // Hang until the handler's timeout aborts the request — exercise
        // the maxRetries:0 + timeoutMs:3000 path.
        return new Promise<Response>((_, reject) => {
          completeState.rejector = reject;
        });
      }
      return jsonResponse(200, {});
    };
    vi.stubGlobal("fetch", vi.fn(fetchFn));

    const reporter = new WrightfulReporter({
      url: "http://dash.example",
      token: "tok",
      flushIntervalMs: 5,
    });
    reporter.onBegin(makeConfig(), makeSuite([]));
    await new Promise((r) => setTimeout(r, 20));

    process.emit("SIGTERM" as NodeJS.Signals, "SIGTERM" as NodeJS.Signals);
    await new Promise((r) => setTimeout(r, 50));

    // One attempt, no retries.
    expect(completeStarts).toHaveLength(1);

    // Unblock the pending request so the test can clean up.
    completeState.rejector?.(new Error("aborted by test"));
    await new Promise((r) => setTimeout(r, 20));
  });
});
