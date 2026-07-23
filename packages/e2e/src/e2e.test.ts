/**
 * E2E assertions that run against a live dashboard booted by Vitest's
 * globalSetup (packages/e2e/vitest.globalSetup.ts). Connection details are
 * passed in via inject() — see the ProvidedContext augmentation in
 * vitest.globalSetup.ts for the full set of keys.
 */

import { createHash, createHmac } from "node:crypto";
import { existsSync } from "node:fs";

import { beforeAll, describe, expect, inject, it } from "vite-plus/test";

const DASHBOARD_URL = inject("dashboardUrl");
const API_KEY = inject("apiKey");
const REPORT_PATH = inject("reportPath");
const SESSION_COOKIE = inject("sessionCookie");
const TEAM_SLUG = inject("teamSlug");
const PROJECT_SLUG = inject("projectSlug");
// The secret the booted dashboard actually signs artifact-download tokens with,
// already resolved by the fixture (dedicated ARTIFACT_TOKEN_SECRET when set,
// else BETTER_AUTH_SECRET). We sign with THIS rather than re-deriving the
// `?? BETTER_AUTH_SECRET` precedence here, so the forge can never silently
// diverge from the dashboard's resolveArtifactTokenSecret the moment a
// dedicated secret is introduced.
const ARTIFACT_TOKEN_SECRET = inject("artifactTokenSecret");
// The deterministic VCS context globalSetup pins on the seeded runs (the
// reporter's GITHUB_* detection is fed fixed values), so branch/commit filter
// assertions hold in every environment.
const SEEDED_BRANCH = inject("seededBranch");
const SEEDED_COMMIT_SHA = inject("seededCommitSha");

// Mirrors apps/dashboard/src/lib/artifacts/tokens.ts#signArtifactToken.
// Artifact downloads are gated by a short-lived HMAC token the dashboard mints
// server-side on authenticated pages; the e2e suite holds the same secret, so
// we can forge a valid token rather than scrape one out of the rendered HTML.
// Token format: `${base64url(JSON({r2Key, contentType, exp}))}.${base64url(HMAC(body))}`.
//
// This is a deliberate cross-package clone (the canonical signer is async
// WebCrypto running in workerd; this runs sync in the Node Vitest harness). The
// body-shape + HMAC/base64url contract is guarded by a canary in the dashboard
// suite — apps/dashboard/src/__tests__/artifact-tokens.test.ts ("e2e token
// forging contract"). Keep this in sync with that canary; a drift fails there.
function base64url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signArtifactToken(
  r2Key: string,
  contentType: string,
  ttlSeconds = 60,
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = base64url(
    Buffer.from(JSON.stringify({ r2Key, contentType, exp })),
  );
  const sig = base64url(
    createHmac("sha256", ARTIFACT_TOKEN_SECRET).update(body).digest(),
  );
  return `${body}.${sig}`;
}

const PROJECT_URL = `${DASHBOARD_URL}/t/${TEAM_SLUG}/p/${PROJECT_SLUG}`;

function fetchAuthed(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", SESSION_COOKIE);
  return fetch(url, { ...init, headers, redirect: "manual" });
}

describe("Wrightful E2E", () => {
  beforeAll(() => {
    if (!existsSync(REPORT_PATH)) {
      throw new Error(`Playwright report not found at ${REPORT_PATH}`);
    }
  });

  describe("Dashboard auth gate", () => {
    it("redirects unauthenticated / to /login", async () => {
      const res = await fetch(DASHBOARD_URL, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/login");
    });

    it("returns 200 with the scoped project page for an authed user", async () => {
      // globalSetup streams a Playwright run into this project before the
      // suite starts, so the page is no longer empty — assert on the stable
      // page chrome instead of the empty-state copy.
      const res = await fetchAuthed(PROJECT_URL);
      const html = await res.text();
      expect(res.status).toBe(200);
      // Assert on a marker UNIQUE to the runs-list page, not the bare word
      // "Runs" (which the sidebar nav prints on every tenant page). The Void
      // page-data component id is rendered only by this route.
      expect(html).toContain('"component":"t/[teamSlug]/p/[projectSlug]"');
    });
  });

  describe("Streaming API auth + validation", () => {
    it("rejects requests without an auth token (401)", async () => {
      const res = await fetch(`${DASHBOARD_URL}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "k", run: {} }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects requests with a bad API key (401)", async () => {
      const res = await fetch(`${DASHBOARD_URL}/api/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrf_bad_key_99999999",
        },
        body: JSON.stringify({ idempotencyKey: "k", run: {} }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects invalid payloads (400) with a validation message", async () => {
      const res = await fetch(`${DASHBOARD_URL}/api/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "X-Wrightful-Version": "3",
        },
        body: JSON.stringify({ bad: "payload" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("Validation failed");
    });

    it("rejects superseded protocol versions (409)", async () => {
      const res = await fetch(`${DASHBOARD_URL}/api/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "X-Wrightful-Version": "2",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
    });

    it("rejects unknown (too new) protocol versions (409)", async () => {
      const res = await fetch(`${DASHBOARD_URL}/api/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "X-Wrightful-Version": "99",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
    });
  });

  describe("Reporter stream → dashboard render", () => {
    it("renders the streamed run on the scoped project runs page", async () => {
      const res = await fetchAuthed(PROJECT_URL);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).not.toContain("No test runs yet");
      expect(html).toMatch(
        new RegExp(`/t/${TEAM_SLUG}/p/${PROJECT_SLUG}/runs/`),
      );
    });

    it("renders the run detail page with test result data", async () => {
      const indexHtml = await (await fetchAuthed(PROJECT_URL)).text();
      const runHrefRe = new RegExp(
        `/t/${TEAM_SLUG}/p/${PROJECT_SLUG}/runs/([\\w]+)`,
      );
      const match = indexHtml.match(runHrefRe);
      expect(match).not.toBeNull();
      const runId = match![1];

      const detailRes = await fetchAuthed(`${PROJECT_URL}/runs/${runId}`);
      const detailHtml = await detailRes.text();
      expect(detailRes.status).toBe(200);
      //   1. Stable page chrome — the Tests/Environment tab pills — proves we
      //      landed on the run-detail page rather than an error/empty render.
      expect(detailHtml).toContain("Tests");
      expect(detailHtml).toContain("Environment");
      //   2. The Tests-tab group list now loads client-side (deferred), so the
      //      test-file names are no longer in the SSR HTML — they come from the
      //      grouped-read API the island calls. Hit that data path and assert it
      //      returns the streamed run's `.spec` files (real test-result data,
      //      not just the page shell).
      const groupsRes = await fetchAuthed(
        `${DASHBOARD_URL}/api/t/${TEAM_SLUG}/p/${PROJECT_SLUG}/runs/${runId}/groups?groupBy=file`,
      );
      expect(groupsRes.status).toBe(200);
      expect(await groupsRes.text()).toContain(".spec");
    });
  });

  describe("Artifacts register + upload + download", () => {
    // Read once and share across the suite — avoid repeated seed lookups and
    // keep the artifact tests pinned to one real result.
    let runId: string;
    let testResultId: string;
    beforeAll(async () => {
      // The reporter-driven playwright run in globalSetup streams real test
      // results into the dashboard; grab one so the artifact register+upload
      // tests below have a valid (runId, testResultId) pair to point at.
      const seeded = await readSeededTestResult();
      runId = seeded.runId;
      testResultId = seeded.testResultId;
    });

    it("rejects an invalid register payload (400)", async () => {
      const res = await fetch(`${DASHBOARD_URL}/api/artifacts/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "X-Wrightful-Version": "3",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("registers, uploads, and downloads an artifact end-to-end", async () => {
      const payloadBytes = new TextEncoder().encode("hello-artifact-bytes");

      const registerRes = await fetch(
        `${DASHBOARD_URL}/api/artifacts/register`,
        {
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
                type: "trace",
                name: "trace.zip",
                contentType: "application/zip",
                sizeBytes: payloadBytes.length,
              },
            ],
          }),
        },
      );
      expect(registerRes.status).toBe(201);

      const registerBody = (await registerRes.json()) as {
        uploads?: Array<{
          uploadUrl?: string;
          r2Key?: string;
          artifactId?: string;
        }>;
      };
      expect(registerBody.uploads).toHaveLength(1);

      const upload = registerBody.uploads![0];
      expect(upload.uploadUrl).toMatch(/^\/api\/artifacts\/[^/]+\/upload$/);
      expect(upload.r2Key).toMatch(
        new RegExp(
          `^t/[^/]+/p/[^/]+/runs/${runId}/${testResultId}/.+/trace\\.zip$`,
        ),
      );
      expect(upload.artifactId).toBeTruthy();

      // The subsequent PUT upload + signed download both look up the artifact
      // row server-side, so their 204/200 responses already prove the register
      // call persisted it — no separate DB count assertion needed.

      const putRes = await fetch(`${DASHBOARD_URL}${upload.uploadUrl}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "X-Wrightful-Version": "3",
          "Content-Type": "application/zip",
          "Content-Length": String(payloadBytes.length),
        },
        body: payloadBytes,
      });
      expect(putRes.status).toBe(204);

      const artifactId = upload.artifactId;
      if (!artifactId) throw new Error("register response missing artifactId");
      if (!upload.r2Key) throw new Error("register response missing r2Key");
      const token = signArtifactToken(upload.r2Key, "application/zip");
      const downloadRes = await fetch(
        `${DASHBOARD_URL}/api/artifacts/${artifactId}/download?t=${token}`,
      );
      expect(downloadRes.status).toBe(200);
      // CORS was narrowed from `*` to the dashboard origin (plus the
      // Playwright trace viewer); with no Origin header the response should
      // echo the dashboard origin.
      expect(downloadRes.headers.get("access-control-allow-origin")).toBe(
        DASHBOARD_URL,
      );
      expect(downloadRes.headers.get("vary")).toBe("Origin");
      const downloadedBytes = new Uint8Array(await downloadRes.arrayBuffer());
      expect(new TextDecoder().decode(downloadedBytes)).toBe(
        "hello-artifact-bytes",
      );
    });

    it("rejects a run that doesn't belong to the caller's project (404)", async () => {
      const res = await fetch(`${DASHBOARD_URL}/api/artifacts/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "X-Wrightful-Version": "3",
        },
        body: JSON.stringify({
          runId: "nonexistent-run",
          artifacts: [
            {
              testResultId,
              type: "trace",
              name: "trace.zip",
              contentType: "application/zip",
              sizeBytes: 1024,
            },
          ],
        }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("Sharded ingest (multi-shard run over the raw wire)", () => {
    // Drives the full sharded-suite lifecycle exactly as N reporter processes
    // would — one `idempotencyKey`, per-shard opens/results/completes over raw
    // HTTP — against the live dashboard. Pins the three sharded invariants
    // end-to-end: (1) every shard lands on ONE run, in any open order; (2) the
    // run's `expectedTotalTests` aggregates to the EXACT suite size as shards
    // open (each shard's onBegin only sees its own slice); (3) the run defers
    // its terminal flip until the LAST shard completes, then takes the worst
    // status across shards.
    const INGEST_HEADERS = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      "X-Wrightful-Version": "3",
    };
    const idempotencyKey = `e2e-sharded-${Date.now()}`;
    const SHARD_TOTAL = 3;
    // Shard slices: 3 + 2 + 1 = 6 planned tests across the suite.
    const SHARD_TESTS: Record<number, { testId: string; title: string }[]> = {
      1: [
        { testId: "sh1-a", title: "shard1 a" },
        { testId: "sh1-b", title: "shard1 b" },
        { testId: "sh1-c", title: "shard1 c" },
      ],
      2: [
        { testId: "sh2-a", title: "shard2 a" },
        { testId: "sh2-b", title: "shard2 b (fails)" },
      ],
      3: [{ testId: "sh3-a", title: "shard3 a" }],
    };
    let runId: string;

    function openShard(index: number): Promise<Response> {
      const tests = SHARD_TESTS[index]!;
      return fetch(`${DASHBOARD_URL}/api/runs`, {
        method: "POST",
        headers: INGEST_HEADERS,
        body: JSON.stringify({
          idempotencyKey,
          run: {
            plannedTests: tests.map((t) => ({ ...t, file: "sharded.spec.ts" })),
            expectedTotalTests: tests.length,
            branch: "e2e-sharded",
          },
          shard: { index, total: SHARD_TOTAL },
        }),
      });
    }

    function streamShardResults(
      index: number,
      failTestId?: string,
    ): Promise<Response> {
      const results = SHARD_TESTS[index]!.map((t) => {
        const status = t.testId === failTestId ? "failed" : "passed";
        return {
          testId: t.testId,
          title: t.title,
          file: "sharded.spec.ts",
          status,
          durationMs: 25,
          shardIndex: index,
          attempts: [{ attempt: 0, status, durationMs: 25 }],
        };
      });
      return fetch(`${DASHBOARD_URL}/api/runs/${runId}/results`, {
        method: "POST",
        headers: INGEST_HEADERS,
        body: JSON.stringify({ results }),
      });
    }

    function completeShard(
      index: number,
      status: "passed" | "failed",
    ): Promise<Response> {
      return fetch(`${DASHBOARD_URL}/api/runs/${runId}/complete`, {
        method: "POST",
        headers: INGEST_HEADERS,
        body: JSON.stringify({
          status,
          durationMs: 500 + index,
          shard: { index, total: SHARD_TOTAL },
        }),
      });
    }

    interface RunSummary {
      status: string;
      totalTests: number;
      expectedTotalTests: number | null;
      passed: number;
      failed: number;
      completedAt: number | null;
    }

    async function readRunSummary(): Promise<RunSummary> {
      const res = await fetch(`${DASHBOARD_URL}/api/v1/runs/${runId}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(200);
      return (await res.json()) as RunSummary;
    }

    it("lands every shard on ONE run (any open order) and aggregates the exact suite total", async () => {
      // Shard 2 wins the open race — deliberately NOT shard 1, so nothing
      // accidentally depends on the opener being the first shard.
      const first = await openShard(2);
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as { runId: string };
      runId = firstBody.runId;

      // Mid-open: only shard 2's slice is declared so far.
      expect((await readRunSummary()).expectedTotalTests).toBe(2);

      const second = await openShard(1);
      expect(second.status).toBe(200); // duplicate open
      const third = await openShard(3);
      expect(third.status).toBe(200);
      for (const res of [second, third]) {
        const body = (await res.json()) as { runId: string; duplicate?: true };
        expect(body.runId).toBe(runId);
        expect(body.duplicate).toBe(true);
      }

      // All shards open → the run knows the EXACT suite size (3 + 2 + 1).
      expect((await readRunSummary()).expectedTotalTests).toBe(6);
    });

    it("streams each shard's results against the shared run", async () => {
      for (const [index, fail] of [
        [1, undefined],
        [2, "sh2-b"],
        [3, undefined],
      ] as const) {
        const res = await streamShardResults(index, fail);
        expect(res.status).toBe(200);
      }
      const summary = await readRunSummary();
      expect(summary.totalTests).toBe(6);
      expect(summary.passed).toBe(5);
      expect(summary.failed).toBe(1);
      // Everything declared has reported — nothing left pending.
      expect(summary.totalTests).toBe(summary.expectedTotalTests);
    });

    it("stays running until the LAST shard completes, then takes the worst status", async () => {
      expect((await completeShard(1, "passed")).status).toBe(200);
      expect((await readRunSummary()).status).toBe("running");

      expect((await completeShard(3, "passed")).status).toBe(200);
      expect((await readRunSummary()).status).toBe("running");

      // The failing shard completes LAST: the run flips terminal exactly once,
      // to the worst status across shards.
      expect((await completeShard(2, "failed")).status).toBe(200);
      const final = await readRunSummary();
      expect(final.status).toBe("failed");
      expect(final.completedAt).not.toBeNull();
      expect(final.totalTests).toBe(6);
      expect(final.expectedTotalTests).toBe(6);
      expect(final.passed).toBe(5);
      expect(final.failed).toBe(1);
    });
  });

  describe("MCP endpoint (/api/mcp)", () => {
    // Raw JSON-RPC over Streamable HTTP — deliberately NOT the MCP SDK client,
    // so this exercises exactly the bytes any MCP client puts on the wire
    // (Accept negotiation, Bearer auth, stateless JSON responses).
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

    /** Parse the first text content block of a tools/call result as JSON. */
    function toolJson<T>(result: {
      isError?: boolean;
      content: { type: string; text?: string }[];
    }): T {
      expect(result.isError ?? false).toBe(false);
      const text = result.content.find((c) => c.type === "text")?.text;
      if (!text) throw new Error("tool returned no text content");
      return JSON.parse(text) as T;
    }

    it("rejects a missing/bad API key with 401 (no version handshake 409)", async () => {
      const noKey = await mcpRpc("initialize", {}, { key: null });
      expect(noKey.status).toBe(401);
      const badKey = await mcpRpc("initialize", {}, { key: "wrf_bad_key" });
      expect(badKey.status).toBe(401);
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
      expect(result.tools.map((t) => t.name).sort()).toEqual([
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

    it("walks run → tests → test detail over seeded data", async () => {
      const listRuns = await rpcResult<{
        content: { type: string; text?: string }[];
        isError?: boolean;
      }>(
        await mcpRpc("tools/call", {
          name: "list_runs",
          arguments: { limit: 5 },
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

      const listTests = await rpcResult<{
        content: { type: string; text?: string }[];
        isError?: boolean;
      }>(
        await mcpRpc("tools/call", {
          name: "list_tests",
          arguments: { run_id: runId },
        }),
      );
      const testsPage = toolJson<{ tests: { id: string; title: string }[] }>(
        listTests,
      );
      expect(testsPage.tests.length).toBeGreaterThan(0);

      const detailRes = await rpcResult<{
        content: { type: string; text?: string }[];
        isError?: boolean;
      }>(
        await mcpRpc("tools/call", {
          name: "get_test_result",
          arguments: { test_result_id: testsPage.tests[0].id },
        }),
      );
      const detail = toolJson<{
        id: string;
        status: string;
        attempts: unknown[];
        artifacts: unknown[];
      }>(detailRes);
      expect(detail.id).toBe(testsPage.tests[0].id);
      expect(Array.isArray(detail.attempts)).toBe(true);
      expect(Array.isArray(detail.artifacts)).toBe(true);
    });

    it("ranks the deliberately-flaky demo test and links its latest flaky result", async () => {
      // tests/demo.spec.ts seeds one retried-then-passed test per run
      // ("flaky by design"), so the window always contains ≥1 flaky test.
      const result = await rpcResult<{
        isError?: boolean;
        content: { type: string; text?: string }[];
      }>(
        await mcpRpc("tools/call", {
          name: "list_flaky_tests",
          arguments: { days: 1 },
        }),
      );
      const page = toolJson<{
        totalFlakyTests: number;
        flakyTests: {
          title: string;
          flakyCount: number;
          flakeRatePct: number;
          lastFlakyTestResultId: string | null;
        }[];
      }>(result);
      expect(page.totalFlakyTests).toBeGreaterThan(0);
      const flaky = page.flakyTests.find((t) =>
        t.title.includes("flaky by design"),
      );
      expect(flaky, "the seeded flaky demo test must rank").toBeTruthy();
      expect(flaky!.flakyCount).toBeGreaterThan(0);
      expect(flaky!.flakeRatePct).toBeGreaterThan(0);
      expect(flaky!.lastFlakyTestResultId).toBeTruthy();

      // The handle feeds straight into get_test_result, whose attempts carry
      // the failing first attempt + the passing retry — the diagnosis loop.
      const detailRes = await rpcResult<{
        isError?: boolean;
        content: { type: string; text?: string }[];
      }>(
        await mcpRpc("tools/call", {
          name: "get_test_result",
          arguments: { test_result_id: flaky!.lastFlakyTestResultId },
        }),
      );
      const detail = toolJson<{
        status: string;
        attempts: { attempt: number; status: string }[];
      }>(detailRes);
      expect(detail.status).toBe("flaky");
      expect(detail.attempts.length).toBeGreaterThanOrEqual(2);
      expect(detail.attempts.some((a) => a.status !== "passed")).toBe(true);
      expect(detail.attempts.at(-1)?.status).toBe("passed");
    });

    it("filters list_runs by the seeded commit SHA prefix", async () => {
      const hit = toolJson<{ runs: { commitSha: string | null }[] }>(
        await rpcResult(
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
        await rpcResult(
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
        await rpcResult(
          await mcpRpc("tools/call", {
            name: "list_flaky_tests",
            arguments: { days: 1, branch: SEEDED_BRANCH },
          }),
        ),
      );
      expect(
        onBranch.flakyTests.some((t) => t.title.includes("flaky by design")),
      ).toBe(true);

      const offBranch = toolJson<{ totalFlakyTests: number }>(
        await rpcResult(
          await mcpRpc("tools/call", {
            name: "list_flaky_tests",
            arguments: { days: 1, branch: "no-such-branch" },
          }),
        ),
      );
      expect(offBranch.totalFlakyTests).toBe(0);
    });

    it("serves get_artifact: small text inline, traces via signed URL + viewer link", async () => {
      // Seed two artifacts through the real ingest path (register → PUT),
      // one on each side of the inline/download decision.
      const { runId, testResultId } = await readSeededTestResult();
      const textBytes = new TextEncoder().encode(
        "mcp e2e artifact: error context line",
      );
      const zipBytes = new TextEncoder().encode("PK-fake-trace-bytes");

      const registerRes = await fetch(
        `${DASHBOARD_URL}/api/artifacts/register`,
        {
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
        },
      );
      expect(registerRes.status).toBe(201);
      const { uploads } = (await registerRes.json()) as {
        uploads: { uploadUrl: string; artifactId: string; name?: string }[];
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

      // Small text/plain → inlined: raw content first, JSON metadata second.
      const textResult = await rpcResult<{
        isError?: boolean;
        content: { type: string; text?: string }[];
      }>(
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

      // Trace (zip) → never inlined: metadata-only with a working signed
      // download URL and a trace-viewer link.
      const traceMeta = toolJson<{
        id: string;
        downloadUrl: string;
        downloadUrlExpiresInSeconds: number;
        traceViewerUrl: string;
        note: string;
      }>(
        await rpcResult(
          await mcpRpc("tools/call", {
            name: "get_artifact",
            arguments: { artifact_id: traceUpload.artifactId },
          }),
        ),
      );
      expect(traceMeta.id).toBe(traceUpload.artifactId);
      expect(traceMeta.note).toContain("downloadUrl");
      const traceViewerUrl = new URL(traceMeta.traceViewerUrl);
      expect(traceViewerUrl.origin).toBe(new URL(DASHBOARD_URL).origin);
      expect(traceViewerUrl.pathname).toBe("/trace-viewer/index.html");
      expect(traceViewerUrl.searchParams.get("trace")).toBe(
        traceMeta.downloadUrl,
      );
      // The signed URL must work WITHOUT an Authorization header — that is
      // the whole point (hand it to curl / a browser / show-trace).
      const download = await fetch(traceMeta.downloadUrl);
      expect(download.status).toBe(200);
      expect(new TextDecoder().decode(await download.arrayBuffer())).toBe(
        "PK-fake-trace-bytes",
      );
    });

    it("answers GET and DELETE with 405 (stateless: no SSE channel, no sessions)", async () => {
      // The spec's required behavior for sessionless Streamable HTTP servers;
      // documented in docs/api/mcp.md.
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

    it("reports an unknown run as a tool error, not a protocol failure", async () => {
      const result = await rpcResult<{
        isError?: boolean;
        content: { type: string; text?: string }[];
      }>(
        await mcpRpc("tools/call", {
          name: "get_run",
          arguments: { run_id: "not-a-real-run" },
        }),
      );
      expect(result.isError).toBe(true);
    });

    it("challenges an unauthenticated request with WWW-Authenticate resource metadata", async () => {
      const res = await mcpRpc("initialize", {}, { key: null });
      expect(res.status).toBe(401);
      const challenge = res.headers.get("www-authenticate");
      expect(challenge).toContain("Bearer");
      expect(challenge).toContain(
        `resource_metadata="${DASHBOARD_URL}/.well-known/oauth-protected-resource"`,
      );
    });
  });

  describe("MCP OAuth flow (discovery → register → authorize → consent → token → tools)", () => {
    const REDIRECT_URI = "http://127.0.0.1:8976/callback";

    // PKCE S256 pair, built with node crypto (the e2e suite runs in Node).
    const verifier = base64url(
      createHmac("sha256", "pkce-seed").update("verifier").digest(),
    );
    const challenge = base64url(createHash("sha256").update(verifier).digest());

    /** Collect every Set-Cookie a response carries into one Cookie header. */
    function harvestCookies(res: Response): string {
      return res.headers
        .getSetCookie()
        .map((sc) => sc.split(";")[0])
        .join("; ");
    }

    it("walks the full OAuth dance and reads seeded data with the minted token", async () => {
      // 1. Root discovery documents (rewritten in void.json onto the Better
      //    Auth plugin endpoints) — what an MCP client fetches after the 401.
      const prm = (await (
        await fetch(`${DASHBOARD_URL}/.well-known/oauth-protected-resource`)
      ).json()) as { resource: string; authorization_servers: string[] };
      expect(prm.authorization_servers.length).toBeGreaterThan(0);

      const asMeta = (await (
        await fetch(`${DASHBOARD_URL}/.well-known/oauth-authorization-server`)
      ).json()) as {
        authorization_endpoint: string;
        token_endpoint: string;
        registration_endpoint: string;
      };
      expect(asMeta.authorization_endpoint).toBe(
        `${DASHBOARD_URL}/api/auth/mcp/authorize`,
      );

      // 2. Dynamic client registration (public client, PKCE only).
      const regRes = await fetch(asMeta.registration_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "wrightful-e2e-agent",
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      });
      expect(regRes.status, await regRes.clone().text()).toBeLessThan(300);
      const { client_id } = (await regRes.json()) as { client_id: string };
      expect(client_id).toBeTruthy();

      // 3. Authorize as the logged-in browser. The middleware must first
      //    force prompt=consent (302 back to authorize), then the plugin
      //    must redirect to the consent page — NEVER straight to the
      //    redirect_uri with a code (that would be the silent-grant hole).
      const authorizeUrl = new URL(asMeta.authorization_endpoint);
      authorizeUrl.searchParams.set("client_id", client_id);
      authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("scope", "openid");
      authorizeUrl.searchParams.set("state", "e2e-state");
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const forced = await fetchAuthed(authorizeUrl.toString());
      expect(forced.status).toBe(302);
      const forcedLocation = new URL(
        forced.headers.get("location")!,
        DASHBOARD_URL,
      );
      expect(forcedLocation.searchParams.get("prompt")).toBe("consent");

      const authorizeRes = await fetchAuthed(forcedLocation.toString());
      expect(authorizeRes.status).toBe(302);
      const consentLocation = new URL(
        authorizeRes.headers.get("location")!,
        DASHBOARD_URL,
      );
      expect(consentLocation.pathname).toBe("/oauth/consent");
      expect(consentLocation.searchParams.get("client_id")).toBe(client_id);
      const consentCookies = harvestCookies(authorizeRes);
      expect(consentCookies).toContain("oidc_consent_prompt");

      // 4. Approve — the same POST the consent page's button makes.
      const consentRes = await fetch(
        `${DASHBOARD_URL}/api/auth/oauth2/consent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: `${SESSION_COOKIE}; ${consentCookies}`,
          },
          body: JSON.stringify({ accept: true }),
        },
      );
      expect(consentRes.status, await consentRes.clone().text()).toBe(200);
      const { redirectURI } = (await consentRes.json()) as {
        redirectURI: string;
      };
      const callback = new URL(redirectURI);
      expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
      expect(callback.searchParams.get("state")).toBe("e2e-state");
      const code = callback.searchParams.get("code");
      expect(code).toBeTruthy();

      // 5. Exchange the code (PKCE verifier, no client secret).
      const tokenRes = await fetch(asMeta.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          client_id,
          code_verifier: verifier,
        }),
      });
      expect(tokenRes.status, await tokenRes.clone().text()).toBe(200);
      const { access_token } = (await tokenRes.json()) as {
        access_token: string;
      };
      expect(access_token).toBeTruthy();

      // 6. The token drives the MCP endpoint in USER mode: list_projects
      //    surfaces the seeded workspace, and the scoped tools take
      //    team/project slugs.
      async function oauthRpc(method: string, params: Record<string, unknown>) {
        const res = await fetch(`${DASHBOARD_URL}/api/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${access_token}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        expect(res.status, await res.clone().text()).toBe(200);
        const body = (await res.json()) as { result?: unknown };
        return body.result as {
          tools?: { name: string }[];
          content?: { type: string; text?: string }[];
          isError?: boolean;
        };
      }

      const toolsResult = await oauthRpc("tools/list", {});
      expect(toolsResult.tools?.map((t) => t.name)).toContain("list_projects");

      const projectsResult = await oauthRpc("tools/call", {
        name: "list_projects",
        arguments: {},
      });
      const projectsText =
        projectsResult.content?.find((c) => c.type === "text")?.text ?? "";
      expect(projectsText).toContain(TEAM_SLUG);
      expect(projectsText).toContain(PROJECT_SLUG);

      const runsResult = await oauthRpc("tools/call", {
        name: "list_runs",
        arguments: { team: TEAM_SLUG, project: PROJECT_SLUG, limit: 5 },
      });
      expect(runsResult.isError ?? false).toBe(false);
      const runsText =
        runsResult.content?.find((c) => c.type === "text")?.text ?? "";
      const runsPage = JSON.parse(runsText) as { runs: { id: string }[] };
      expect(runsPage.runs.length).toBeGreaterThan(0);

      // Membership is enforced per call — a team the user isn't in errors.
      const deniedResult = await oauthRpc("tools/call", {
        name: "list_runs",
        arguments: { team: "not-my-team", project: "nope" },
      });
      expect(deniedResult.isError).toBe(true);
    });

    it("denying consent returns access_denied to the client — and no code", async () => {
      // Same dance as above up to the consent screen, but the user clicks
      // Deny. The redirect back to the client must carry an OAuth error and
      // must NOT mint an authorization code.
      const asMeta = (await (
        await fetch(`${DASHBOARD_URL}/.well-known/oauth-authorization-server`)
      ).json()) as {
        authorization_endpoint: string;
        registration_endpoint: string;
      };
      const regRes = await fetch(asMeta.registration_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "wrightful-e2e-denier",
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
        }),
      });
      const { client_id } = (await regRes.json()) as { client_id: string };

      const authorizeUrl = new URL(asMeta.authorization_endpoint);
      authorizeUrl.searchParams.set("client_id", client_id);
      authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("scope", "openid");
      authorizeUrl.searchParams.set("state", "e2e-deny-state");
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const forced = await fetchAuthed(authorizeUrl.toString());
      expect(forced.status).toBe(302);
      const authorizeRes = await fetchAuthed(
        new URL(forced.headers.get("location")!, DASHBOARD_URL).toString(),
      );
      expect(authorizeRes.status).toBe(302);
      const consentCookies = harvestCookies(authorizeRes);

      const denyRes = await fetch(`${DASHBOARD_URL}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION_COOKIE}; ${consentCookies}`,
        },
        body: JSON.stringify({ accept: false }),
      });
      expect(denyRes.status, await denyRes.clone().text()).toBe(200);
      const { redirectURI } = (await denyRes.json()) as { redirectURI: string };
      const callback = new URL(redirectURI);
      expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
      expect(callback.searchParams.get("code")).toBeNull();
      expect(callback.searchParams.get("error")).toBe("access_denied");
    });

    it("renders the consent page for a signed-in user and bounces anonymous hits to login", async () => {
      const authed = await fetchAuthed(
        `${DASHBOARD_URL}/oauth/consent?client_id=whatever&scope=openid`,
      );
      expect(authed.status).toBe(200);
      const html = await authed.text();
      expect(html).toContain("Authorize");
      expect(html).toContain("openid");

      const anonymous = await fetch(`${DASHBOARD_URL}/oauth/consent`, {
        redirect: "manual",
      });
      expect(anonymous.status).toBe(302);
      expect(anonymous.headers.get("location")).toContain("/login");
    });
  });
});

async function readSeededTestResult(): Promise<{
  runId: string;
  testResultId: string;
}> {
  // Scrape a runId from the authenticated runs-list HTML (the same path the
  // "renders the run detail page" test uses), then hit the authenticated
  // test-preview API for that run and grab any test result it returns.
  const indexHtml = await (await fetchAuthed(PROJECT_URL)).text();
  const match = indexHtml.match(
    new RegExp(`/t/${TEAM_SLUG}/p/${PROJECT_SLUG}/runs/([\\w]+)`),
  );
  if (!match) {
    throw new Error(
      "Expected at least one run link on the project page — did the reporter-driven playwright run seed data in globalSetup?",
    );
  }
  const runId = match[1];

  const previewRes = await fetchAuthed(
    `${DASHBOARD_URL}/api/t/${TEAM_SLUG}/p/${PROJECT_SLUG}/runs/${runId}/test-preview`,
  );
  if (!previewRes.ok) {
    throw new Error(
      `test-preview fetch failed (${previewRes.status}): ${await previewRes.text()}`,
    );
  }
  const preview = (await previewRes.json()) as Record<string, { id: string }[]>;
  const firstId = [
    ...(preview.failed ?? []),
    ...(preview.flaky ?? []),
    ...(preview.passed ?? []),
    ...(preview.skipped ?? []),
  ][0]?.id;
  if (!firstId) {
    throw new Error("test-preview returned no test results for the seeded run");
  }
  return { runId, testResultId: firstId };
}
