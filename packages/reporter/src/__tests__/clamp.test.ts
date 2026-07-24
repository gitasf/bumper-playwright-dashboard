import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import type { FullResult, Suite, TestCase } from "@playwright/test/reporter";
import WrightfulReporter from "../index.js";
import { MAX_PLANNED_TESTS, MAX_RESULTS_PER_BATCH } from "../limits.js";
import { makeConfig, makeSuite } from "./fixtures.js";

const CI_ENV_VARS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_RUN_ID",
  "GITHUB_REF",
  "GITHUB_SHA",
  "GITHUB_REPOSITORY",
  "WRIGHTFUL_IDEMPOTENCY_KEY",
];

function tinyTest(i: number): TestCase {
  return {
    titlePath: () => ["t", String(i)],
    location: { file: "a.spec.ts", line: 1, column: 1 },
    repeatEachIndex: 0,
    tags: [],
    annotations: [],
    outcome: () => "skipped",
    parent: { project: () => ({ name: "chromium" }) },
  } as unknown as TestCase;
}

function bigSuite(n: number): Suite {
  const tests = Array.from({ length: n }, (_, i) => tinyTest(i));
  return { allTests: () => tests } as unknown as Suite;
}

describe("reporter client-side clamps", () => {
  let originalEnv: Record<string, string | undefined>;
  let stderr: string[];
  let baselineSignalListeners: Record<
    "SIGTERM" | "SIGINT",
    ReturnType<typeof process.listeners>
  >;

  beforeEach(() => {
    originalEnv = {};
    for (const k of CI_ENV_VARS) {
      originalEnv[k] = process.env[k];
      delete process.env[k];
    }
    baselineSignalListeners = {
      SIGTERM: process.listeners("SIGTERM"),
      SIGINT: process.listeners("SIGINT"),
    };
    stderr = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ runId: "r1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      for (const listener of process.listeners(signal)) {
        if (!baselineSignalListeners[signal].includes(listener)) {
          process.removeListener(signal, listener);
        }
      }
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("clamps an over-cap batchSize and warns loudly", () => {
    const reporter = new WrightfulReporter({
      url: "http://dash.example",
      token: "tok",
      batchSize: MAX_RESULTS_PER_BATCH + 5000,
    });
    reporter.onBegin(makeConfig(), makeSuite([]));

    const batcher = (
      reporter as unknown as { batcher: { options: { batchSize: number } } }
    ).batcher;
    expect(batcher.options.batchSize).toBe(MAX_RESULTS_PER_BATCH);
    expect(stderr.join("")).toMatch(/per-batch cap/);
  });

  it("keeps a sane batchSize unchanged", () => {
    const reporter = new WrightfulReporter({
      url: "http://dash.example",
      token: "tok",
      batchSize: 50,
    });
    reporter.onBegin(makeConfig(), makeSuite([]));
    const batcher = (
      reporter as unknown as { batcher: { options: { batchSize: number } } }
    ).batcher;
    expect(batcher.options.batchSize).toBe(50);
  });

  it("truncates an over-cap plannedTests array (keeps the run) and warns", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ runId: "r1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const reporter = new WrightfulReporter({
      url: "http://dash.example",
      token: "tok",
    });
    reporter.onBegin(makeConfig(), bigSuite(MAX_PLANNED_TESTS + 3));
    await reporter.onEnd({
      status: "passed",
      startTime: new Date(),
      duration: 0,
    } as FullResult);

    const openBodies = fetchMock.mock.calls
      .filter((c) => (c[0] as string).endsWith("/api/runs"))
      .map(
        (c) =>
          JSON.parse((c[1] as RequestInit).body as string) as {
            run: { plannedTests: unknown[]; expectedTotalTests: number };
          },
      );
    const body = openBodies.find(
      (b) => b.run.expectedTotalTests === MAX_PLANNED_TESTS + 3,
    );
    expect(body).toBeDefined();
    expect(body!.run.plannedTests).toHaveLength(MAX_PLANNED_TESTS);
    expect(body!.run.expectedTotalTests).toBe(MAX_PLANNED_TESTS + 3);
    expect(stderr.join("")).toMatch(/planned-test cap/);
  });
});
