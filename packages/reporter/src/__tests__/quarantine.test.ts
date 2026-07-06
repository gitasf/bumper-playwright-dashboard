import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { StreamClient } from "../client.js";
import { applyQuarantine, fetchQuarantine } from "../quarantine.js";
import type { QuarantineMap } from "../quarantine.js";
import type { TestResultPayload } from "../types.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A minimal failed result payload for the demotion tests. */
function makePayload(
  overrides: Partial<TestResultPayload> = {},
): TestResultPayload {
  return {
    clientKey: "t1",
    testId: "t1",
    title: "flaky test",
    file: "a.spec.ts",
    projectName: null,
    status: "failed",
    durationMs: 50,
    retryCount: 0,
    errorMessage: "boom",
    errorStack: "stack",
    workerIndex: 0,
    shardIndex: null,
    tags: [],
    annotations: [],
    attempts: [
      {
        attempt: 0,
        status: "failed",
        durationMs: 50,
        errorMessage: "boom",
        errorStack: "stack",
      },
    ],
    ...overrides,
  };
}

describe("fetchQuarantine", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("indexes a 200 response by testId", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        tests: [
          { testId: "t1", mode: "skip", reason: "flaky" },
          { testId: "t2", mode: "soft", reason: null },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new StreamClient("http://dash.example", "tok");
    const map = await fetchQuarantine(client);

    expect(map.size).toBe(2);
    expect(map.get("t1")).toEqual({
      testId: "t1",
      mode: "skip",
      reason: "flaky",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://dash.example/api/runs/quarantine");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(init.headers["X-Wrightful-Version"]).toBe("3");
  });

  it("returns an empty map on a 404 (older dashboard, no quarantine route)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { error: "not found" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new StreamClient("http://dash.example", "tok");
    const map = await fetchQuarantine(client);

    expect(map.size).toBe(0);
  });

  it("returns an empty map on a network error (never throws)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new StreamClient("http://dash.example", "tok");
    await expect(fetchQuarantine(client)).resolves.toBeInstanceOf(Map);
    const map = await fetchQuarantine(client);
    expect(map.size).toBe(0);
  });

  it("drops malformed entries (bad mode / missing testId)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        tests: [
          { testId: "ok", mode: "skip", reason: null },
          { testId: "bad-mode", mode: "nope", reason: null },
          { mode: "skip", reason: null },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new StreamClient("http://dash.example", "tok");
    const map = await fetchQuarantine(client);

    expect([...map.keys()]).toEqual(["ok"]);
  });

  it("returns an empty map when the body is missing the tests array", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { nope: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new StreamClient("http://dash.example", "tok");
    const map = await fetchQuarantine(client);
    expect(map.size).toBe(0);
  });
});

describe("applyQuarantine", () => {
  const quarantined: QuarantineMap = new Map([
    ["t1", { testId: "t1", mode: "skip", reason: "known flaky" }],
    ["t-noreason", { testId: "t-noreason", mode: "skip", reason: null }],
  ]);

  it("demotes a quarantined failed test to skipped + adds a quarantined annotation", () => {
    const result = applyQuarantine(
      makePayload({ status: "failed" }),
      quarantined,
    );

    expect(result.status).toBe("skipped");
    expect(result.annotations).toContainEqual({
      type: "quarantined",
      description: "known flaky",
    });
    // Original failure detail is preserved for the dashboard.
    expect(result.errorMessage).toBe("boom");
    expect(result.attempts[0]?.status).toBe("failed");
  });

  it("demotes a quarantined flaky test to skipped", () => {
    const result = applyQuarantine(
      makePayload({ status: "flaky" }),
      quarantined,
    );
    expect(result.status).toBe("skipped");
  });

  it("demotes a quarantined timedout test to skipped", () => {
    const result = applyQuarantine(
      makePayload({ status: "timedout" }),
      quarantined,
    );
    expect(result.status).toBe("skipped");
  });

  it("falls back to a generic description when reason is null", () => {
    const result = applyQuarantine(
      makePayload({ testId: "t-noreason", status: "failed" }),
      quarantined,
    );
    expect(result.annotations).toContainEqual({
      type: "quarantined",
      description: "quarantined",
    });
  });

  it("leaves a NON-quarantined failed test unchanged (same reference)", () => {
    const payload = makePayload({ testId: "other", status: "failed" });
    const result = applyQuarantine(payload, quarantined);
    expect(result).toBe(payload);
    expect(result.status).toBe("failed");
  });

  it("leaves a quarantined PASSED test unchanged (nothing to suppress)", () => {
    const payload = makePayload({ testId: "t1", status: "passed" });
    const result = applyQuarantine(payload, quarantined);
    expect(result).toBe(payload);
    expect(result.status).toBe("passed");
  });

  it("preserves existing annotations when demoting", () => {
    const payload = makePayload({
      status: "failed",
      annotations: [{ type: "issue", description: "JIRA-123" }],
    });
    const result = applyQuarantine(payload, quarantined);
    expect(result.annotations).toEqual([
      { type: "issue", description: "JIRA-123" },
      { type: "quarantined", description: "known flaky" },
    ]);
  });
});
