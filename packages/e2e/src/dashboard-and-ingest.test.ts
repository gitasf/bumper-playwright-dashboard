import { beforeAll, describe, expect, it } from "vite-plus/test";

import {
  API_KEY,
  DASHBOARD_URL,
  PROJECT_SLUG,
  PROJECT_URL,
  TEAM_SLUG,
  assertSeededReportExists,
  fetchAuthed,
  readSeededRunId,
} from "./e2e-context";

describe("Dashboard and ingest E2E", () => {
  beforeAll(assertSeededReportExists);

  describe("Dashboard auth gate", () => {
    it("redirects unauthenticated / to /login", async () => {
      const res = await fetch(DASHBOARD_URL, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/login");
    });

    it("returns 200 with the scoped project page for an authed user", async () => {
      const res = await fetchAuthed(PROJECT_URL);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain('"component":"t/[teamSlug]/p/[projectSlug]"');
    });
  });

  describe("Streaming API auth and validation", () => {
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

    for (const version of ["2", "99"]) {
      it(`rejects unsupported protocol version ${version} (409)`, async () => {
        const res = await fetch(`${DASHBOARD_URL}/api/runs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${API_KEY}`,
            "X-Wrightful-Version": version,
          },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(409);
      });
    }
  });

  describe("Reporter stream to dashboard render", () => {
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
      const runId = await readSeededRunId();
      const detailRes = await fetchAuthed(`${PROJECT_URL}/runs/${runId}`);
      const detailHtml = await detailRes.text();
      expect(detailRes.status).toBe(200);
      expect(detailHtml).toContain("Tests");
      expect(detailHtml).toContain("Environment");

      const groupsRes = await fetchAuthed(
        `${DASHBOARD_URL}/api/t/${TEAM_SLUG}/p/${PROJECT_SLUG}/runs/${runId}/groups?groupBy=file`,
      );
      expect(groupsRes.status).toBe(200);
      expect(await groupsRes.text()).toContain(".spec");
    });
  });

  describe("Sharded ingest over the raw wire", () => {
    const ingestHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      "X-Wrightful-Version": "3",
    };
    const idempotencyKey = `e2e-sharded-${Date.now()}`;
    const shardTotal = 3;
    const shardTests: Record<number, { testId: string; title: string }[]> = {
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
      const tests = shardTests[index]!;
      return fetch(`${DASHBOARD_URL}/api/runs`, {
        method: "POST",
        headers: ingestHeaders,
        body: JSON.stringify({
          idempotencyKey,
          run: {
            plannedTests: tests.map((test) => ({
              ...test,
              file: "sharded.spec.ts",
            })),
            expectedTotalTests: tests.length,
            branch: "e2e-sharded",
          },
          shard: { index, total: shardTotal },
        }),
      });
    }

    function streamShardResults(
      index: number,
      failTestId?: string,
    ): Promise<Response> {
      const results = shardTests[index]!.map((test) => {
        const status = test.testId === failTestId ? "failed" : "passed";
        return {
          ...test,
          file: "sharded.spec.ts",
          status,
          durationMs: 25,
          shardIndex: index,
          attempts: [{ attempt: 0, status, durationMs: 25 }],
        };
      });
      return fetch(`${DASHBOARD_URL}/api/runs/${runId}/results`, {
        method: "POST",
        headers: ingestHeaders,
        body: JSON.stringify({ results }),
      });
    }

    function completeShard(
      index: number,
      status: "passed" | "failed",
    ): Promise<Response> {
      return fetch(`${DASHBOARD_URL}/api/runs/${runId}/complete`, {
        method: "POST",
        headers: ingestHeaders,
        body: JSON.stringify({
          status,
          durationMs: 500 + index,
          shard: { index, total: shardTotal },
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

    it("lands every shard on one run and aggregates the suite total", async () => {
      // Shard 2 wins the open race — deliberately NOT shard 1, so nothing
      // accidentally depends on the opener being the first shard.
      const first = await openShard(2);
      expect(first.status).toBe(201);
      runId = ((await first.json()) as { runId: string }).runId;
      expect((await readRunSummary()).expectedTotalTests).toBe(2);

      const second = await openShard(1);
      const third = await openShard(3);
      expect(second.status).toBe(200);
      expect(third.status).toBe(200);
      for (const res of [second, third]) {
        const body = (await res.json()) as { runId: string; duplicate?: true };
        expect(body.runId).toBe(runId);
        expect(body.duplicate).toBe(true);
      }
      expect((await readRunSummary()).expectedTotalTests).toBe(6);
    });

    it("streams each shard's results against the shared run", async () => {
      for (const [index, failedTest] of [
        [1, undefined],
        [2, "sh2-b"],
        [3, undefined],
      ] as const) {
        expect((await streamShardResults(index, failedTest)).status).toBe(200);
      }
      const summary = await readRunSummary();
      expect(summary.totalTests).toBe(6);
      expect(summary.passed).toBe(5);
      expect(summary.failed).toBe(1);
      expect(summary.totalTests).toBe(summary.expectedTotalTests);
    });

    it("stays running until the last shard completes, then takes the worst status", async () => {
      expect((await completeShard(1, "passed")).status).toBe(200);
      expect((await readRunSummary()).status).toBe("running");
      expect((await completeShard(3, "passed")).status).toBe(200);
      expect((await readRunSummary()).status).toBe("running");

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
});
