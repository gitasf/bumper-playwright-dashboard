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
import { makeConfig, makeSuite } from "./fixtures.js";
import {
  CI_ENV_VARS,
  jsonResponse,
  makeFetch,
} from "./reporter-test-support.js";

describe("WrightfulReporter execution identity", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {};
    for (const key of CI_ENV_VARS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shares build, job, and selected-project identity across first-attempt native shards", async () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_RUN_ID = "42";
    process.env.GITHUB_JOB = "e2e";
    process.env.GITHUB_RUN_ATTEMPT = "1";

    const fetchMock = makeFetch([
      (url) =>
        url.endsWith("/api/runs")
          ? jsonResponse(200, { runId: "run_abc" })
          : undefined,
    ]);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const openKey = async (): Promise<string> => {
      const callsBefore = fetchMock.mock.calls.length;
      const reporter = new WrightfulReporter({
        url: "http://dash.example",
        token: "tok",
        flushIntervalMs: 5,
      });
      reporter.onBegin(
        makeConfig(null, { current: 1, total: 2 }, ["chromium", "firefox"]),
        makeSuite([]),
      );
      await reporter.onEnd({
        status: "passed",
        startTime: new Date(),
        duration: 0,
      } as FullResult);
      const openCall = fetchMock.mock.calls
        .slice(callsBefore)
        .find(([url]) => url.endsWith("/api/runs"));
      expect(openCall).toBeDefined();
      const rawBody = openCall![1].body;
      const body = (typeof rawBody === "string" ? JSON.parse(rawBody) : {}) as {
        idempotencyKey: string;
      };
      return body.idempotencyKey;
    };

    const first = await openKey();
    expect(await openKey()).toBe(first);
    expect(first).toContain("42-e2e-attempt-1-projects-");
  });

  it("fails closed instead of opening an incomplete GitHub native-shard rerun", async () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_RUN_ID = "42";
    process.env.GITHUB_JOB = "e2e";
    process.env.GITHUB_RUN_ATTEMPT = "2";
    const fetchMock = makeFetch([]);
    vi.stubGlobal("fetch", fetchMock);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const reporter = new WrightfulReporter({
      url: "http://dash.example",
      token: "tok",
    });
    reporter.onBegin(
      makeConfig(null, { current: 1, total: 2 }, ["chromium"]),
      makeSuite([]),
    );
    await reporter.onEnd({
      status: "passed",
      startTime: new Date(),
      duration: 0,
    } as FullResult);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      stderrSpy.mock.calls.some(([message]) =>
        String(message).includes("risk an incomplete dashboard run"),
      ),
    ).toBe(true);
  });

  it("separates GitLab non-sharded job retries by CI_JOB_ID", async () => {
    process.env.GITLAB_CI = "true";
    process.env.CI_PIPELINE_ID = "pipeline-42";
    process.env.CI_JOB_NAME = "e2e";
    const fetchMock = makeFetch([
      (url) =>
        url.endsWith("/api/runs")
          ? jsonResponse(200, { runId: "run_abc" })
          : undefined,
    ]);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const openKey = async (jobId: string): Promise<string> => {
      process.env.CI_JOB_ID = jobId;
      const reporter = new WrightfulReporter({
        url: "http://dash.example",
        token: "tok",
      });
      reporter.onBegin(makeConfig(), makeSuite([]));
      await reporter.onEnd({
        status: "passed",
        startTime: new Date(),
        duration: 0,
      } as FullResult);
      const call = fetchMock.mock.calls
        .slice()
        .reverse()
        .find(([url]) => url.endsWith("/api/runs"));
      const raw = call?.[1].body;
      expect(typeof raw).toBe("string");
      return (
        JSON.parse(typeof raw === "string" ? raw : "{}") as {
          idempotencyKey: string;
        }
      ).idempotencyKey;
    };

    const originalJob = await openKey("100");
    const retriedJob = await openKey("101");
    expect(originalJob).toContain("attempt-100");
    expect(retriedJob).toContain("attempt-101");
    expect(retriedJob).not.toBe(originalJob);
  });

  it("separates empty filtered project matrices, including their native shards", async () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_RUN_ID = "42";
    process.env.GITHUB_RUN_ATTEMPT = "1";
    process.env.GITHUB_JOB = "e2e";
    const fetchMock = makeFetch([
      (url) =>
        url.endsWith("/api/runs")
          ? jsonResponse(200, { runId: "run_abc" })
          : undefined,
    ]);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const openProject = async (
      projectName: string,
      shardIndex: number,
    ): Promise<string> => {
      const reporter = new WrightfulReporter({
        url: "http://dash.example",
        token: "tok",
      });
      reporter.onBegin(
        makeConfig(
          null,
          { current: shardIndex, total: 2 },
          ["chromium", "firefox"],
          ["node", "playwright", "test", "--project", projectName],
        ),
        makeSuite([]),
      );
      await reporter.onEnd({
        status: "passed",
        startTime: new Date(),
        duration: 0,
      } as FullResult);
      const call = fetchMock.mock.calls
        .slice()
        .reverse()
        .find(([url]) => url.endsWith("/api/runs"));
      const raw = call?.[1].body;
      return (
        typeof raw === "string"
          ? (JSON.parse(raw) as { idempotencyKey: string })
          : { idempotencyKey: "" }
      ).idempotencyKey;
    };

    const chromiumShardOne = await openProject("chromium", 1);
    expect(await openProject("chromium", 2)).toBe(chromiumShardOne);
    expect(await openProject("firefox", 1)).not.toBe(chromiumShardOne);
  });

  it("does not publish shard-local PR comments as aggregate summaries", async () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_RUN_ID = "42";
    process.env.GITHUB_JOB = "e2e";
    process.env.GITHUB_REPOSITORY = "acme/app";
    process.env.GITHUB_TOKEN = "token";
    process.env.GITHUB_REF = "refs/pull/7/merge";
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
      postPrComment: true,
    });
    reporter.onBegin(makeConfig(null, { current: 1, total: 2 }), makeSuite([]));
    await reporter.onEnd({
      status: "passed",
      startTime: new Date(),
      duration: 0,
    } as FullResult);

    expect(
      fetchMock.mock.calls.some(([url]) =>
        url.startsWith("https://api.github.com"),
      ),
    ).toBe(false);
    expect(
      stderrSpy.mock.calls.some(([message]) =>
        String(message).includes("PR comment skipped for a native shard"),
      ),
    ).toBe(true);
  });

  it("scopes local PR comments to the selected project and explicit matrix leg", async () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_RUN_ID = "42";
    process.env.GITHUB_JOB = "e2e";
    process.env.GITHUB_WORKFLOW_REF =
      "acme/app/.github/workflows/e2e.yml@refs/heads/main";
    process.env.GITHUB_REPOSITORY = "acme/app";
    process.env.GITHUB_TOKEN = "token";
    process.env.GITHUB_REF = "refs/pull/7/merge";
    const fetchMock = makeFetch([
      (url) =>
        url.endsWith("/api/runs")
          ? jsonResponse(200, {
              runId: "run_abc",
              runUrl: "/t/acme/p/app/runs/run_abc",
            })
          : undefined,
      (url, init) =>
        url.startsWith("https://api.github.com") && init.method === "GET"
          ? jsonResponse(200, [])
          : undefined,
      (url, init) =>
        url.startsWith("https://api.github.com") && init.method === "POST"
          ? jsonResponse(201, { id: 1 })
          : undefined,
    ]);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const postLeg = async (projectName: string, matrixKey: string) => {
      process.env.WRIGHTFUL_MATRIX_KEY = matrixKey;
      const reporter = new WrightfulReporter({
        url: "http://dash.example",
        token: "tok",
        postPrComment: true,
      });
      reporter.onBegin(
        makeConfig(
          null,
          null,
          ["chromium", "firefox"],
          ["node", "playwright", "test", `--project=${projectName}`],
        ),
        makeSuite([]),
      );
      await reporter.onEnd({
        status: "passed",
        startTime: new Date(),
        duration: 0,
      } as FullResult);
      const call = fetchMock.mock.calls
        .slice()
        .reverse()
        .find(
          ([url, init]) =>
            url.startsWith("https://api.github.com") && init.method === "POST",
        );
      expect(call).toBeDefined();
      const raw = call![1].body;
      const body = (
        typeof raw === "string" ? (JSON.parse(raw) as { body: string }) : null
      )?.body;
      return body?.match(/<!-- wrightful:pr-comment:[a-f0-9]+ -->/)?.[0];
    };

    const markers = [
      await postLeg("chromium", "linux"),
      await postLeg("firefox", "linux"),
      await postLeg("chromium", "mac"),
    ];
    expect(markers.every(Boolean)).toBe(true);
    expect(new Set(markers).size).toBe(3);
  });

  it("keeps project comments distinct when the dashboard omits runUrl", async () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_RUN_ID = "42";
    process.env.GITHUB_JOB = "e2e";
    process.env.GITHUB_REPOSITORY = "acme/app";
    process.env.GITHUB_TOKEN = "github-token";
    process.env.GITHUB_REF = "refs/pull/7/merge";
    const fetchMock = makeFetch([
      (url) =>
        url.endsWith("/api/runs")
          ? jsonResponse(200, { runId: "run_abc", runUrl: null })
          : undefined,
      (url, init) =>
        url.startsWith("https://api.github.com") && init.method === "GET"
          ? jsonResponse(200, [])
          : undefined,
      (url, init) =>
        url.startsWith("https://api.github.com") && init.method === "POST"
          ? jsonResponse(201, { id: 1 })
          : undefined,
    ]);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const postForProjectToken = async (token: string): Promise<string> => {
      const reporter = new WrightfulReporter({
        url: "http://dash.example",
        token,
        postPrComment: true,
      });
      reporter.onBegin(makeConfig(), makeSuite([]));
      await reporter.onEnd({
        status: "passed",
        startTime: new Date(),
        duration: 0,
      } as FullResult);
      const call = fetchMock.mock.calls
        .slice()
        .reverse()
        .find(
          ([url, init]) =>
            url.startsWith("https://api.github.com") && init.method === "POST",
        );
      const raw = call?.[1].body;
      expect(typeof raw).toBe("string");
      const body = JSON.parse(typeof raw === "string" ? raw : "{}") as {
        body: string;
      };
      expect(body.body).not.toContain(token);
      return body.body.match(/<!-- wrightful:pr-comment:[a-f0-9]+ -->/)![0];
    };

    const first = await postForProjectToken("wrf_project_one_secret");
    const second = await postForProjectToken("wrf_project_two_secret");
    expect(second).not.toBe(first);
  });
});
