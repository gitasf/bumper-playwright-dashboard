import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import type { FullResult } from "@playwright/test/reporter";
import WrightfulReporter from "../index.js";
import { makeConfig, makeResult, makeSuite, makeTest } from "./fixtures.js";
import {
  CI_ENV_VARS,
  jsonResponse,
  makeFetch,
} from "./reporter-test-support.js";

describe("WrightfulReporter lifecycle", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {};
    for (const k of CI_ENV_VARS) {
      originalEnv[k] = process.env[k];
      delete process.env[k];
    }
    delete process.env.WRIGHTFUL_URL;
    delete process.env.WRIGHTFUL_TOKEN;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // The reporter installs SIGTERM/SIGINT handlers at onBegin; remove them
    // so they don't fire (and call process.exit) when vitest tears the
    // worker process down.
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("drives openRun → appendResults → completeRun with correct wire shape", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchMock = makeFetch([
      (url) => {
        if (url.endsWith("/api/runs")) {
          return jsonResponse(200, { runId: "run_abc" });
        }
        return undefined;
      },
      (url) => {
        if (url.includes("/results")) {
          // Match the two tests we'll stream: one passed, one flaky.
          return jsonResponse(200, {
            results: [
              { clientKey: "pass", testResultId: "tr_1" },
              { clientKey: "flaky", testResultId: "tr_2" },
              { clientKey: "fail", testResultId: "tr_3" },
            ],
          });
        }
        return undefined;
      },
      (url) => {
        if (url.endsWith("/complete")) {
          return jsonResponse(200, {});
        }
        return undefined;
      },
    ]);
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const response = await fetchMock(url, init);
      calls.push({
        url,
        body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      });
      return response;
    });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(
      // No-op: we assert on this later.
      () => true,
    );

    const passingTest = makeTest({
      id: "pass",
      outcome: "expected",
      title: "passes cleanly",
      file: "smoke.spec.ts",
    });
    const flakyTest = makeTest({
      id: "flaky",
      outcome: "flaky",
      title: "recovers on retry",
      file: "smoke.spec.ts",
      retries: 2,
    });
    const failingTest = makeTest({
      id: "fail",
      outcome: "unexpected",
      title: "fails hard",
      file: "smoke.spec.ts",
    });

    const reporter = new WrightfulReporter({
      url: "http://dash.example",
      token: "tok-e2e",
      flushIntervalMs: 5,
    });

    reporter.onBegin(
      makeConfig(),
      makeSuite([passingTest, flakyTest, failingTest]),
    );

    reporter.onTestEnd(
      passingTest,
      makeResult({ status: "passed", duration: 10, retry: 0 }),
    );
    reporter.onTestEnd(
      flakyTest,
      makeResult({
        status: "failed",
        duration: 12,
        retry: 0,
        errorMessage: "flake",
      }),
    );
    reporter.onTestEnd(
      flakyTest,
      makeResult({ status: "passed", duration: 8, retry: 1 }),
    );
    reporter.onTestEnd(
      failingTest,
      makeResult({
        status: "failed",
        duration: 20,
        retry: 0,
        errorMessage: "bang",
      }),
    );

    await reporter.onEnd({
      status: "failed",
      startTime: new Date(),
      duration: 0,
    } as FullResult);

    const openRun = calls.find((c) => c.url.endsWith("/api/runs"));
    const appendCalls = calls.filter((c) => c.url.includes("/results"));
    const complete = calls.find((c) => c.url.endsWith("/complete"));

    expect(openRun).toBeDefined();
    const openBody = openRun!.body as {
      idempotencyKey: string;
      run: {
        expectedTotalTests: number;
        plannedTests: Array<{ title: string }>;
        reporterVersion: string;
        playwrightVersion: string;
      };
    };
    expect(openBody.idempotencyKey).toMatch(/.+/);
    expect(openBody.run.expectedTotalTests).toBe(3);
    expect(openBody.run.plannedTests).toHaveLength(3);
    expect(openBody.run.playwrightVersion).toBe("1.59.0");
    expect(openBody.run.reporterVersion).toMatch(/.+/);

    // Every emitted test should appear in some append call. The wire
    // `clientKey` is a SHA hash, not our test id — key lookups use `title`.
    type StreamedResult = {
      title: string;
      status: string;
      retryCount: number;
      errorMessage: string | null;
      attempts: Array<{ status: string }>;
    };
    const streamed = appendCalls.flatMap(
      (c) => (c.body as { results: StreamedResult[] }).results,
    );
    const byTitle = new Map(streamed.map((r) => [r.title, r]));
    expect(byTitle.get("passes cleanly")).toMatchObject({ status: "passed" });
    expect(byTitle.get("recovers on retry")).toMatchObject({
      status: "flaky",
      retryCount: 1,
    });
    expect(byTitle.get("fails hard")).toMatchObject({
      status: "failed",
      errorMessage: "bang",
    });
    const flakyPayload = byTitle.get("recovers on retry");
    expect(flakyPayload).toBeDefined();
    expect(flakyPayload!.attempts.map((a) => a.status)).toEqual([
      "failed",
      "passed",
    ]);

    expect(complete).toBeDefined();
    expect(complete!.body).toMatchObject({ status: "failed" });

    expect(stderrSpy).toHaveBeenCalled();
    // Summary line at end-of-suite includes the streamed count.
    const summaryLine = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("streamed"));
    expect(summaryLine).toMatch(/streamed 3\/3 test\(s\)/);
  });

  it("does not throw when the dashboard is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const t = makeTest({ id: "pass", outcome: "expected" });
    const reporter = new WrightfulReporter({
      url: "http://unreachable.example",
      token: "tok",
      flushIntervalMs: 5,
    });

    reporter.onBegin(makeConfig(), makeSuite([t]));
    reporter.onTestEnd(
      t,
      makeResult({ status: "passed", duration: 1, retry: 0 }),
    );

    // Must not reject.
    await expect(
      reporter.onEnd({
        status: "passed",
        startTime: new Date(),
        duration: 0,
      } as FullResult),
    ).resolves.toBeUndefined();
  });

  it("disables streaming quietly when URL or token is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const reporter = new WrightfulReporter({ url: "http://dash.example" });
    reporter.onBegin(makeConfig(), makeSuite([]));
    await reporter.onEnd({
      status: "passed",
      startTime: new Date(),
      duration: 0,
    } as FullResult);

    expect(fetchMock).not.toHaveBeenCalled();
    const msg = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("streaming disabled"));
    expect(msg).toBeDefined();
  });

  it("disables streaming after a mid-run AuthError (warns once, drops later batches) but still completes the run", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/runs")) {
        return jsonResponse(200, { runId: "run_abc" });
      }
      if (url.includes("/results")) {
        // e.g. a transient proxy/WAF hiccup — auth itself may still be valid.
        return jsonResponse(401, { error: "key revoked" });
      }
      return jsonResponse(200, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const a = makeTest({ id: "a", outcome: "expected", title: "a" });
    const b = makeTest({ id: "b", outcome: "expected", title: "b" });
    const reporter = new WrightfulReporter({
      url: "http://dash.example",
      token: "tok",
      batchSize: 1,
      flushIntervalMs: 5,
    });
    reporter.onBegin(makeConfig(), makeSuite([a, b]));

    reporter.onTestEnd(
      a,
      makeResult({ status: "passed", duration: 1, retry: 0 }),
    );
    // Let the first flush hit the 401 and disable streaming.
    await new Promise((r) => setTimeout(r, 50));
    reporter.onTestEnd(
      b,
      makeResult({ status: "passed", duration: 1, retry: 0 }),
    );

    await reporter.onEnd({
      status: "passed",
      startTime: new Date(),
      duration: 0,
    } as FullResult);

    const urls = fetchMock.mock.calls.map((c) => c[0]);
    // Only the first batch POSTs; the second is dropped without a request.
    expect(urls.filter((u) => u.includes("/results"))).toHaveLength(1);
    // The client survives: /complete is still attempted exactly once so the
    // run doesn't sit at status='running' until the watchdog interrupts it.
    expect(urls.filter((u) => u.endsWith("/complete"))).toHaveLength(1);
    const authWarns = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("WRIGHTFUL_TOKEN"));
    expect(authWarns).toHaveLength(1);
  });

  it("makes exactly one /complete attempt (no retry storm) when auth is genuinely revoked", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/runs")) {
        return jsonResponse(200, { runId: "run_abc" });
      }
      // Everything after open is rejected — the key is gone.
      return jsonResponse(401, { error: "key revoked" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const t = makeTest({ id: "t", outcome: "expected" });
    const reporter = new WrightfulReporter({
      url: "http://dash.example",
      token: "tok",
      flushIntervalMs: 5,
    });
    reporter.onBegin(makeConfig(), makeSuite([t]));
    reporter.onTestEnd(
      t,
      makeResult({ status: "passed", duration: 1, retry: 0 }),
    );

    await expect(
      reporter.onEnd({
        status: "passed",
        startTime: new Date(),
        duration: 0,
      } as FullResult),
    ).resolves.toBeUndefined();

    const urls = fetchMock.mock.calls.map((c) => c[0]);
    // One attempt, no retries (4xx is never retried), failure caught + warned.
    expect(urls.filter((u) => u.endsWith("/complete"))).toHaveLength(1);
    const completeWarn = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("completeRun failed"));
    expect(completeWarn).toBeDefined();
  });

  it("onEnd returns within the shutdown budget and still calls /complete when flushes hang", async () => {
    const pendingResults: Array<(r: Response) => void> = [];
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith("/api/runs")) {
        return Promise.resolve(jsonResponse(200, { runId: "run_abc" }));
      }
      if (url.includes("/results")) {
        // Hang until released — simulates a wedged dashboard.
        return new Promise<Response>((resolve) => pendingResults.push(resolve));
      }
      return Promise.resolve(jsonResponse(200, {}));
    });
    vi.stubGlobal("fetch", fetchMock);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const t = makeTest({ id: "t", outcome: "expected" });
    const reporter = new WrightfulReporter({
      url: "http://dash.example",
      token: "tok",
      flushIntervalMs: 5,
      shutdownTimeoutMs: 300,
    });
    reporter.onBegin(makeConfig(), makeSuite([t]));
    reporter.onTestEnd(
      t,
      makeResult({ status: "passed", duration: 1, retry: 0 }),
    );

    const started = Date.now();
    await reporter.onEnd({
      status: "passed",
      startTime: new Date(),
      duration: 0,
    } as FullResult);

    // Bounded by the 300ms budget (generous margin for CI scheduling).
    expect(Date.now() - started).toBeLessThan(5_000);
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls.find((u) => u.endsWith("/complete"))).toBeDefined();
    const budgetWarn = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("shutdown budget"));
    expect(budgetWarn).toMatch(/abandoned \d+ in-flight/);

    // Release the wedged request so nothing leaks past the test.
    for (const resolve of pendingResults) {
      resolve(jsonResponse(200, { results: [] }));
    }
    await new Promise((r) => setTimeout(r, 10));
  });

  it("still starts the batcher drain when hung artifact uploads exhaust the drain budget (buffered batch POSTs, /complete fires)", async () => {
    // Pins the onEnd restructure: a hung artifact stage must not prevent the
    // drain from ever being INVOKED — fully-buffered result batches are handed
    // to fetch regardless, and only the awaiting is budget-bounded (the drain
    // keeps running unawaited; it may settle after onEnd returns).
    const tmpDir = mkdtempSync(join(process.cwd(), "wrightful-test-"));
    const attachmentPath = join(tmpDir, "shot.png");
    writeFileSync(attachmentPath, "png-bytes");

    try {
      const fetchMock = vi.fn((url: string, init: RequestInit) => {
        if (url.endsWith("/api/runs")) {
          return Promise.resolve(jsonResponse(200, { runId: "run_abc" }));
        }
        if (url.includes("/results")) {
          // Echo a mapping for every streamed result so artifact uploads fire.
          const body = JSON.parse(
            typeof init.body === "string" ? init.body : "",
          ) as {
            results: Array<{ clientKey: string }>;
          };
          return Promise.resolve(
            jsonResponse(200, {
              results: body.results.map((r) => ({
                clientKey: r.clientKey,
                testResultId: `tr_${r.clientKey}`,
              })),
            }),
          );
        }
        if (url.includes("/artifacts/register")) {
          // Wedge the artifact stage forever.
          return new Promise<Response>(() => {});
        }
        return Promise.resolve(jsonResponse(200, {}));
      });
      vi.stubGlobal("fetch", fetchMock);
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);

      const failing = makeTest({
        id: "f",
        outcome: "unexpected",
        title: "fails with artifact",
      });
      const passing = makeTest({
        id: "p",
        outcome: "expected",
        title: "passes early",
      });
      const buffered = makeTest({
        id: "late",
        outcome: "expected",
        title: "buffered late",
      });
      const reporter = new WrightfulReporter({
        url: "http://dash.example",
        token: "tok",
        batchSize: 2,
        // Huge interval so a partial batch can only ever flush via drain.
        flushIntervalMs: 60_000,
        shutdownTimeoutMs: 300,
      });
      reporter.onBegin(makeConfig(), makeSuite([failing, passing, buffered]));

      // First two tests fill a batch of 2 → flush fires → the failing test's
      // artifact register wedges, leaving a never-settling tracked task.
      reporter.onTestEnd(
        failing,
        makeResult({
          status: "failed",
          duration: 1,
          retry: 0,
          errorMessage: "x",
          attachments: [
            {
              name: "shot.png",
              contentType: "image/png",
              path: attachmentPath,
            },
          ],
        }),
      );
      reporter.onTestEnd(
        passing,
        makeResult({ status: "passed", duration: 1, retry: 0 }),
      );
      await vi.waitFor(() => {
        expect(
          fetchMock.mock.calls.some(([u]) => u.includes("/artifacts/register")),
        ).toBe(true);
      });

      // Enqueued but never flushed before onEnd: 1 < batchSize and the batch
      // timer is 60s out — only the drain can hand this batch to fetch.
      reporter.onTestEnd(
        buffered,
        makeResult({ status: "passed", duration: 1, retry: 0 }),
      );

      const started = Date.now();
      await reporter.onEnd({
        status: "failed",
        startTime: new Date(),
        duration: 0,
      } as FullResult);
      expect(Date.now() - started).toBeLessThan(5_000);

      // The drain runs unawaited — give its POST a beat to land.
      await vi.waitFor(() => {
        const resultsBodies = fetchMock.mock.calls
          .filter(([u]) => u.includes("/results"))
          .map(
            ([, init]) =>
              JSON.parse(typeof init.body === "string" ? init.body : "") as {
                results: Array<{ title: string }>;
              },
          );
        const streamedTitles = resultsBodies.flatMap((b) =>
          b.results.map((r) => r.title),
        );
        expect(streamedTitles).toContain("buffered late");
      });

      const urls = fetchMock.mock.calls.map((c) => c[0]);
      expect(urls.find((u) => u.endsWith("/complete"))).toBeDefined();
      const budgetWarn = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .find((s) => s.includes("shutdown budget"));
      expect(budgetWarn).toMatch(/abandoned \d+ in-flight/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("swallows a throwing enqueue (poisoned test object) without rejecting onEnd", async () => {
    const fetchMock = makeFetch([
      (url) =>
        url.endsWith("/api/runs")
          ? jsonResponse(200, { runId: "run_abc" })
          : undefined,
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const evil = makeTest({ id: "boom", outcome: "expected", title: "evil" });
    (evil as unknown as { titlePath: () => string[] }).titlePath = () => {
      throw new Error("titlePath exploded");
    };

    const reporter = new WrightfulReporter({
      url: "http://dash.example",
      token: "tok",
      flushIntervalMs: 5,
    });
    reporter.onBegin(makeConfig(), makeSuite([]));
    reporter.onTestEnd(
      evil,
      makeResult({ status: "passed", duration: 1, retry: 0 }),
    );

    await expect(
      reporter.onEnd({
        status: "passed",
        startTime: new Date(),
        duration: 0,
      } as FullResult),
    ).resolves.toBeUndefined();

    const msg = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('failed to enqueue result for "evil"'));
    expect(msg).toContain("titlePath exploded");
  });

  it("sends WRIGHTFUL_IDEMPOTENCY_KEY verbatim on the wire, undecorated", async () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_RUN_ID = "42";
    process.env.GITHUB_JOB = "e2e";
    process.env.WRIGHTFUL_IDEMPOTENCY_KEY = "01EXEC0000000000000000000";

    const fetchMock = makeFetch([
      (url) =>
        url.endsWith("/api/runs")
          ? jsonResponse(200, { runId: "run_abc" })
          : undefined,
    ]);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const reporter = new WrightfulReporter({
      url: "http://dash.example",
      token: "tok",
      flushIntervalMs: 5,
    });
    reporter.onBegin(makeConfig(null, { current: 1, total: 2 }), makeSuite([]));
    await reporter.onEnd({
      status: "passed",
      startTime: new Date(),
      duration: 0,
    } as FullResult);

    const openCall = fetchMock.mock.calls.find(([url]) =>
      url.endsWith("/api/runs"),
    );
    expect(openCall).toBeDefined();
    const rawBody = openCall![1].body;
    const body = (typeof rawBody === "string" ? JSON.parse(rawBody) : {}) as {
      idempotencyKey: string;
    };
    expect(body.idempotencyKey).toBe("01EXEC0000000000000000000");
  });

  it("warns the gate reason when postPrComment is enabled but cannot fire", async () => {
    const fetchMock = makeFetch([
      (url) =>
        url.endsWith("/api/runs")
          ? jsonResponse(200, { runId: "run_abc" })
          : undefined,
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const reporter = new WrightfulReporter({
      url: "http://dash.example",
      token: "tok",
      flushIntervalMs: 5,
      postPrComment: true,
    });
    reporter.onBegin(makeConfig(), makeSuite([]));
    await reporter.onEnd({
      status: "passed",
      startTime: new Date(),
      duration: 0,
    } as FullResult);

    const msg = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("PR comment skipped"));
    expect(msg).toContain("no CI context detected");
  });

  it("warns once per run (not per file) when attachments resolve outside the allowed root", async () => {
    const fetchMock = makeFetch([
      (url) =>
        url.endsWith("/api/runs")
          ? jsonResponse(200, { runId: "run_abc" })
          : undefined,
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const outside = [
      "/definitely-not-under-cwd/one.png",
      "/definitely-not-under-cwd/two.png",
    ];
    const failing = makeTest({ id: "f", outcome: "unexpected" });
    const reporter = new WrightfulReporter({
      url: "http://dash.example",
      token: "tok",
      flushIntervalMs: 5,
    });
    reporter.onBegin(makeConfig(), makeSuite([failing]));
    reporter.onTestEnd(
      failing,
      makeResult({
        status: "failed",
        duration: 1,
        retry: 0,
        errorMessage: "x",
        attachments: outside.map((path) => ({
          name: "screenshot.png",
          contentType: "image/png",
          path,
        })),
      }),
    );
    await reporter.onEnd({
      status: "failed",
      startTime: new Date(),
      duration: 0,
    } as FullResult);

    const rootWarns = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("allowed root"));
    expect(rootWarns).toHaveLength(1);
    expect(rootWarns[0]).toContain(outside[0]);
  });

  it("prunes settled tasks from artifactTasks instead of retaining one per finished test for the life of the run", async () => {
    const fetchMock = makeFetch([
      (url) =>
        url.endsWith("/api/runs")
          ? jsonResponse(200, { runId: "run_abc" })
          : undefined,
      (url) =>
        url.includes("/results")
          ? jsonResponse(200, { results: [] })
          : undefined,
    ]);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const tests = Array.from({ length: 25 }, (_, i) =>
      makeTest({ id: `t${i}`, outcome: "expected", title: `test ${i}` }),
    );
    const reporter = new WrightfulReporter({
      url: "http://dash.example",
      token: "tok",
      flushIntervalMs: 5,
    });
    reporter.onBegin(makeConfig(), makeSuite(tests));

    for (const t of tests) {
      reporter.onTestEnd(
        t,
        makeResult({ status: "passed", duration: 1, retry: 0 }),
      );
    }

    // Give every onTestEnd-tracked task (quarantine await → batcher enqueue)
    // time to settle without waiting for onEnd's own drain.
    await new Promise((r) => setTimeout(r, 30));

    const tracked = (
      reporter as unknown as { artifactTasks: Set<Promise<void>> }
    ).artifactTasks;
    // Each settled task removes itself, so the set stays well below one entry
    // per finished test rather than growing for the whole run.
    expect(tracked.size).toBeLessThan(tests.length);

    await reporter.onEnd({
      status: "passed",
      startTime: new Date(),
      duration: 0,
    } as FullResult);
  });
});
