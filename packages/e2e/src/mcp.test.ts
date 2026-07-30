import { beforeAll, describe, expect, it } from "vite-plus/test";

import {
  API_KEY,
  DASHBOARD_URL,
  PROJECT_SLUG,
  SEEDED_BRANCH,
  SEEDED_COMMIT_SHA,
  TEAM_SLUG,
  assertSeededReportExists,
  readSeededTestResult,
} from "./e2e-context";

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

describe("MCP endpoint E2E", () => {
  beforeAll(assertSeededReportExists);

  let rpcId = 0;
  async function mcpRpc(
    method: string,
    params: Record<string, unknown> = {},
    init: { key?: string | null } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const key = init.key === undefined ? API_KEY : init.key;
    if (key) headers.Authorization = `Bearer ${key}`;
    return fetch(`${DASHBOARD_URL}/api/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method,
        params,
      }),
    });
  }

  async function rpcResult<T>(res: Response): Promise<T> {
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      error?: { message?: string };
      result?: T;
    };
    expect(body.error, JSON.stringify(body.error)).toBeUndefined();
    if (body.result === undefined) throw new Error("missing rpc result");
    return body.result;
  }

  function toolJson<T>(result: ToolResult): T {
    expect(result.isError ?? false).toBe(false);
    const text = result.content.find(
      (content) => content.type === "text",
    )?.text;
    if (!text) throw new Error("tool returned no text content");
    return JSON.parse(text) as T;
  }

  it("rejects a missing or bad API key with 401", async () => {
    expect((await mcpRpc("initialize", {}, { key: null })).status).toBe(401);
    expect(
      (await mcpRpc("initialize", {}, { key: "wrf_bad_key" })).status,
    ).toBe(401);
  });

  it("answers initialize with the wrightful server info", async () => {
    const result = await rpcResult<{
      serverInfo: { name: string };
      capabilities: { tools?: unknown };
    }>(
      await mcpRpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "e2e", version: "0.0.0" },
      }),
    );
    expect(result.serverInfo.name).toBe("wrightful");
    expect(result.capabilities.tools).toBeDefined();
  });

  it("lists the read tools", async () => {
    const result = await rpcResult<{ tools: { name: string }[] }>(
      await mcpRpc("tools/list"),
    );
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "diagnose_flaky_tests",
      "get_artifact",
      "get_run",
      "get_test_history",
      "get_test_result",
      "list_flaky_tests",
      "list_runs",
      "list_tests",
    ]);
  });

  it("walks run to tests to test detail over seeded data", async () => {
    const listRuns = await rpcResult<ToolResult>(
      await mcpRpc("tools/call", {
        name: "list_runs",
        arguments: { limit: 5, commit: SEEDED_COMMIT_SHA },
      }),
    );
    const runsPage = toolJson<{ runs: { id: string; url: string }[] }>(
      listRuns,
    );
    expect(runsPage.runs.length).toBeGreaterThan(0);
    const runId = runsPage.runs[0].id;
    expect(runsPage.runs[0].url).toContain(
      `/t/${TEAM_SLUG}/p/${PROJECT_SLUG}/runs/${runId}`,
    );

    const listTests = await rpcResult<ToolResult>(
      await mcpRpc("tools/call", {
        name: "list_tests",
        arguments: { run_id: runId },
      }),
    );
    const testsPage = toolJson<{ tests: { id: string; title: string }[] }>(
      listTests,
    );
    expect(testsPage.tests.length).toBeGreaterThan(0);

    const detail = toolJson<{
      id: string;
      status: string;
      attempts: unknown[];
      artifacts: unknown[];
    }>(
      await rpcResult<ToolResult>(
        await mcpRpc("tools/call", {
          name: "get_test_result",
          arguments: { test_result_id: testsPage.tests[0].id },
        }),
      ),
    );
    expect(detail.id).toBe(testsPage.tests[0].id);
    expect(Array.isArray(detail.attempts)).toBe(true);
    expect(Array.isArray(detail.artifacts)).toBe(true);
  });

  it("ranks the seeded flaky test and links its latest flaky result", async () => {
    const page = toolJson<{
      totalFlakyTests: number;
      flakyTests: {
        title: string;
        flakyCount: number;
        flakeRatePct: number;
        lastFlakyTestResultId: string | null;
      }[];
    }>(
      await rpcResult<ToolResult>(
        await mcpRpc("tools/call", {
          name: "list_flaky_tests",
          arguments: { days: 1 },
        }),
      ),
    );
    expect(page.totalFlakyTests).toBeGreaterThan(0);
    const flaky = page.flakyTests.find((test) =>
      test.title.includes("flaky by design"),
    );
    expect(flaky, "the seeded flaky demo test must rank").toBeTruthy();
    expect(flaky!.flakyCount).toBeGreaterThan(0);
    expect(flaky!.flakeRatePct).toBeGreaterThan(0);
    expect(flaky!.lastFlakyTestResultId).toBeTruthy();

    const detail = toolJson<{
      status: string;
      attempts: { attempt: number; status: string }[];
    }>(
      await rpcResult<ToolResult>(
        await mcpRpc("tools/call", {
          name: "get_test_result",
          arguments: { test_result_id: flaky!.lastFlakyTestResultId },
        }),
      ),
    );
    expect(detail.status).toBe("flaky");
    expect(detail.attempts.length).toBeGreaterThanOrEqual(2);
    expect(detail.attempts.some((attempt) => attempt.status !== "passed")).toBe(
      true,
    );
    expect(detail.attempts.at(-1)?.status).toBe("passed");
  });

  it("filters list_runs by the seeded commit SHA prefix", async () => {
    const hit = toolJson<{ runs: { commitSha: string | null }[] }>(
      await rpcResult<ToolResult>(
        await mcpRpc("tools/call", {
          name: "list_runs",
          arguments: { commit: SEEDED_COMMIT_SHA.slice(0, 12) },
        }),
      ),
    );
    expect(hit.runs.length).toBeGreaterThan(0);
    for (const run of hit.runs) {
      expect(run.commitSha).toBe(SEEDED_COMMIT_SHA);
    }

    const miss = toolJson<{ runs: unknown[] }>(
      await rpcResult<ToolResult>(
        await mcpRpc("tools/call", {
          name: "list_runs",
          arguments: { commit: "deadbeef" },
        }),
      ),
    );
    expect(miss.runs).toHaveLength(0);
  });

  it("scopes list_flaky_tests to a branch", async () => {
    const onBranch = toolJson<{
      totalFlakyTests: number;
      flakyTests: { title: string }[];
    }>(
      await rpcResult<ToolResult>(
        await mcpRpc("tools/call", {
          name: "list_flaky_tests",
          arguments: { days: 1, branch: SEEDED_BRANCH },
        }),
      ),
    );
    expect(
      onBranch.flakyTests.some((test) =>
        test.title.includes("flaky by design"),
      ),
    ).toBe(true);

    const offBranch = toolJson<{ totalFlakyTests: number }>(
      await rpcResult<ToolResult>(
        await mcpRpc("tools/call", {
          name: "list_flaky_tests",
          arguments: { days: 1, branch: "no-such-branch" },
        }),
      ),
    );
    expect(offBranch.totalFlakyTests).toBe(0);
  });

  it("serves small text inline and traces by signed URL", async () => {
    const { runId, testResultId } = await readSeededTestResult();
    const textBytes = new TextEncoder().encode(
      "mcp e2e artifact: error context line",
    );
    const zipBytes = new TextEncoder().encode("PK-fake-trace-bytes");
    const registerRes = await fetch(`${DASHBOARD_URL}/api/artifacts/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
        "X-Wrightful-Version": "3",
      },
      body: JSON.stringify({
        runId,
        artifacts: [
          {
            testResultId,
            type: "other",
            name: "error-context.txt",
            contentType: "text/plain",
            sizeBytes: textBytes.length,
          },
          {
            testResultId,
            type: "trace",
            name: "trace.zip",
            contentType: "application/zip",
            sizeBytes: zipBytes.length,
          },
        ],
      }),
    });
    expect(registerRes.status).toBe(201);
    const { uploads } = (await registerRes.json()) as {
      uploads: { uploadUrl: string; artifactId: string }[];
    };
    expect(uploads).toHaveLength(2);
    const [textUpload, traceUpload] = uploads;
    for (const [upload, bytes, contentType] of [
      [textUpload, textBytes, "text/plain"],
      [traceUpload, zipBytes, "application/zip"],
    ] as const) {
      const putRes = await fetch(`${DASHBOARD_URL}${upload.uploadUrl}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "X-Wrightful-Version": "3",
          "Content-Type": contentType,
          "Content-Length": String(bytes.length),
        },
        body: bytes,
      });
      expect(putRes.status).toBe(204);
    }

    const textResult = await rpcResult<ToolResult>(
      await mcpRpc("tools/call", {
        name: "get_artifact",
        arguments: { artifact_id: textUpload.artifactId },
      }),
    );
    expect(textResult.isError ?? false).toBe(false);
    expect(textResult.content[0]).toMatchObject({
      type: "text",
      text: "mcp e2e artifact: error context line",
    });
    const textMeta = JSON.parse(textResult.content[1].text!) as {
      id: string;
      downloadUrl: string;
    };
    expect(textMeta.id).toBe(textUpload.artifactId);

    const traceMeta = toolJson<{
      id: string;
      downloadUrl: string;
      downloadUrlExpiresInSeconds: number;
      traceViewerUrl?: string;
      hint: string;
      note: string;
    }>(
      await rpcResult<ToolResult>(
        await mcpRpc("tools/call", {
          name: "get_artifact",
          arguments: { artifact_id: traceUpload.artifactId },
        }),
      ),
    );
    expect(traceMeta.id).toBe(traceUpload.artifactId);
    expect(traceMeta.note).toContain("downloadUrl");
    // No `traceViewerUrl`: this dashboard runs same-origin (no
    // VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN), and that link points at
    // Playwright's stock SPA, whose snapshot iframes hardcode
    // `allow-scripts`. Trace bytes are attacker-craftable, so the shell is
    // not vendored at all on the session origin (see
    // `apps/dashboard/scripts/vendor-trace-viewer.mjs`) — hence the 404 below,
    // and a hint steering to `show-trace`, which renders on the caller's own
    // localhost instead.
    expect(traceMeta.traceViewerUrl).toBeUndefined();
    expect(traceMeta.hint).toContain("npx playwright show-trace");
    const shell = await fetch(
      new URL("/trace-viewer/index.html", DASHBOARD_URL),
    );
    expect(shell.status).toBe(404);
    const download = await fetch(traceMeta.downloadUrl);
    expect(download.status).toBe(200);
    expect(new TextDecoder().decode(await download.arrayBuffer())).toBe(
      "PK-fake-trace-bytes",
    );
  });

  it("answers GET and DELETE with 405", async () => {
    for (const method of ["GET", "DELETE"] as const) {
      const res = await fetch(`${DASHBOARD_URL}/api/mcp`, {
        method,
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          Accept: "application/json, text/event-stream",
        },
      });
      expect(res.status, `${method} /api/mcp`).toBe(405);
    }
  });

  it("reports an unknown run as a tool error", async () => {
    const result = await rpcResult<ToolResult>(
      await mcpRpc("tools/call", {
        name: "get_run",
        arguments: { run_id: "not-a-real-run" },
      }),
    );
    expect(result.isError).toBe(true);
  });

  it("challenges unauthenticated requests with resource metadata", async () => {
    const res = await mcpRpc("initialize", {}, { key: null });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate");
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain(
      `resource_metadata="${DASHBOARD_URL}/.well-known/oauth-protected-resource"`,
    );
  });
});
