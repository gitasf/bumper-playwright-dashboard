/**
 * Realtime UI updates via the `void/live` topic `run:<runId>`.
 *
 * Flow:
 *   1. Open a fresh run via the public API.
 *   2. Navigate the browser to that run's detail page (auth'd).
 *   3. Append results via API.
 *   4. Assert the page DOM reflects the new state without reload — the
 *      published summary snapshot drives the header OutcomeBar/tiles, and the
 *      test row appears in the live list.
 */
import type { APIRequestContext } from "@playwright/test";

import { expect, test } from "./fixtures";

interface OpenRunResponse {
  runId: string;
}

async function openRun(
  request: APIRequestContext,
  apiKey: string,
): Promise<string> {
  const res = await request.post("/api/runs", {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Wrightful-Version": "3",
    },
    data: {
      idempotencyKey: `realtime-${Date.now()}-${Math.random()}`,
      run: { reporterVersion: "0.0.0", playwrightVersion: "0.0.0" },
    },
  });
  if (!res.ok()) {
    throw new Error(`openRun failed (${res.status()}): ${await res.text()}`);
  }
  const body = (await res.json()) as OpenRunResponse;
  return body.runId;
}

async function appendResults(
  request: APIRequestContext,
  apiKey: string,
  runId: string,
  results: Array<{
    testId: string;
    title: string;
    status: "passed" | "failed";
  }>,
): Promise<void> {
  const res = await request.post(`/api/runs/${runId}/results`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Wrightful-Version": "3",
    },
    data: {
      results: results.map((r) => ({
        clientKey: r.testId,
        testId: r.testId,
        title: r.title,
        file: "live.spec.ts",
        status: r.status,
        durationMs: 50,
        retryCount: 0,
        tags: [],
        annotations: [],
        attempts: [
          {
            attempt: 0,
            status: r.status,
            durationMs: 50,
            errorMessage: r.status === "failed" ? "boom" : null,
            errorStack: null,
          },
        ],
      })),
    },
  });
  if (!res.ok()) {
    throw new Error(
      `appendResults failed (${res.status()}): ${await res.text()}`,
    );
  }
}

test.describe("Realtime UI updates (void/live topic run:<runId>)", () => {
  test("a passing test appended via API appears live in the run detail page", async ({
    playwright,
    runDetailPage,
    ctx,
  }) => {
    const request = await playwright.request.newContext({ baseURL: ctx.url });
    try {
      const runId = await openRun(request, ctx.apiKey);
      // Connect to the live stream BEFORE appending. The subscription is set up
      // asynchronously after the page hydrates, and a progress event published
      // before the topic subscribe lands is missed (no replay). Wait for the
      // /live connection (set up pre-navigation so we can't miss it), then a
      // brief settle for the async topic subscribe.
      const liveConnected = runDetailPage.page
        .waitForResponse((r) => r.url().includes("/live"), { timeout: 15_000 })
        .catch(() => null);
      await runDetailPage.goto(runId);
      await liveConnected;
      await runDetailPage.page.waitForTimeout(500);

      const uniqueTitle = `live-test-${Date.now()}`;
      await appendResults(request, ctx.apiKey, runId, [
        { testId: "live-1", title: uniqueTitle, status: "passed" },
      ]);

      await expect(runDetailPage.page.getByText(uniqueTitle)).toBeVisible({
        timeout: 5_000,
      });
    } finally {
      await request.dispose();
    }
  });

  test("header summary snapshot updates live as results stream in", async ({
    playwright,
    runDetailPage,
    ctx,
  }) => {
    const request = await playwright.request.newContext({ baseURL: ctx.url });
    try {
      const runId = await openRun(request, ctx.apiKey);
      // Connect to the live stream BEFORE appending. The subscription is set up
      // asynchronously after the page hydrates, and a progress event published
      // before the topic subscribe lands is missed (no replay). Wait for the
      // /live connection (set up pre-navigation so we can't miss it), then a
      // brief settle for the async topic subscribe.
      const liveConnected = runDetailPage.page
        .waitForResponse((r) => r.url().includes("/live"), { timeout: 15_000 })
        .catch(() => null);
      await runDetailPage.goto(runId);
      await liveConnected;
      await runDetailPage.page.waitForTimeout(500);

      await appendResults(request, ctx.apiKey, runId, [
        { testId: "p-1", title: "p1", status: "passed" },
        { testId: "p-2", title: "p2", status: "passed" },
      ]);
      await appendResults(request, ctx.apiKey, runId, [
        { testId: "f-1", title: "f1", status: "failed" },
      ]);

      // Assert the PUBLISHED SUMMARY snapshot, not the per-test row recompute:
      // the header OutcomeBar (rendered by the <RunSummaryLive> island from
      // `RunProgressEvent.summary`) is a `role="img"` whose accessible name is
      // built from the aggregate counts. Once 2 passed + 1 failed stream in it
      // reads "2 passed, 1 failed, …" — proving the broadcast summary reaches
      // the header live, distinct from the SegmentedControl filter pill counts
      // that derive from the row accumulator.
      const outcomeBar = runDetailPage.page.getByRole("img", {
        name: /passed,.*failed,.*flaky,.*skipped/,
      });
      await expect(outcomeBar).toHaveAttribute(
        "aria-label",
        /2 passed, 1 failed/,
        { timeout: 5_000 },
      );
    } finally {
      await request.dispose();
    }
  });
});
