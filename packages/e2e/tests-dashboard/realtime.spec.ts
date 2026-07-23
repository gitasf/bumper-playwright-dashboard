/**
 * Realtime UI updates over the `void/ws` rooms (ADR 0001) — the regression guard
 * for the WS realtime. Drives the streaming-ingest API (as the reporter does)
 * while the authed browser watches, asserting the UI fills in WITHOUT a reload
 * across the full run lifecycle (open → stream → complete) on BOTH surfaces:
 *
 *   - run DETAIL (`/ws/run/:runId`): the per-test list streams, the published
 *     summary drives the header OutcomeBar live, the Tests-tab count is live, and
 *     the header status glyph flips running → terminal on completion (the
 *     "status stuck on running until refresh" regression).
 *   - runs LIST (`/ws/project/:projectId`): a row streams its counts and flips to
 *     its terminal status on completion; a run opened after load appears live.
 *
 * WS rooms have no event replay, so each test connects the room socket before
 * streaming: wait for the matching `websocket` event, then for a possible
 * second connect (some mounts tear down and reopen the socket shortly after —
 * e.g. a double-invoked effect in dev) so we don't stream into a socket that's
 * about to be replaced.
 */
import type { APIRequestContext, Page, WebSocket } from "@playwright/test";

import { expect, test } from "./fixtures";

const ingestHeaders = (apiKey: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${apiKey}`,
  "X-Wrightful-Version": "3",
});

async function openRun(
  request: APIRequestContext,
  apiKey: string,
  branch?: string,
): Promise<string> {
  const res = await request.post("/api/runs", {
    headers: ingestHeaders(apiKey),
    data: {
      idempotencyKey: `realtime-${Date.now()}-${Math.random()}`,
      run: { reporterVersion: "0.0.0", playwrightVersion: "0.0.0", branch },
    },
  });
  if (!res.ok()) {
    throw new Error(`openRun failed (${res.status()}): ${await res.text()}`);
  }
  return ((await res.json()) as { runId: string }).runId;
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
    headers: ingestHeaders(apiKey),
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
        attempts: [{ attempt: 0, status: r.status, durationMs: 50 }],
      })),
    },
  });
  if (!res.ok()) {
    throw new Error(
      `appendResults failed (${res.status()}): ${await res.text()}`,
    );
  }
}

async function completeRun(
  request: APIRequestContext,
  apiKey: string,
  runId: string,
  status: "passed" | "failed",
): Promise<void> {
  const res = await request.post(`/api/runs/${runId}/complete`, {
    headers: ingestHeaders(apiKey),
    data: { status, durationMs: 500 },
  });
  if (!res.ok()) {
    throw new Error(
      `completeRun failed (${res.status()}): ${await res.text()}`,
    );
  }
}

/**
 * Navigate via `navigate()`, resolve once the room WebSocket whose URL
 * contains `fragment` (`/ws/run/` or `/ws/project/`) is open, then wait
 * (briefly, bounded) for a possible second connect before returning.
 *
 * Some mounts tear down and reopen the socket shortly after the first connect
 * (e.g. a double-invoked effect in dev). WS rooms have no event replay, so
 * streaming into a socket about to be torn down loses those events for good —
 * retrying `expect()` can't recover them. Waiting for the second connect (when
 * it happens) means the caller streams against the socket that survives.
 *
 * The listener is attached before `navigate()` and stays attached across both
 * waits: Playwright fires `websocket` once per socket at creation, so a
 * listener attached only after the first event could miss a reconnect between.
 */
async function gotoAndAwaitRoom(
  page: Page,
  navigate: () => Promise<void>,
  fragment: string,
): Promise<void> {
  const matches: WebSocket[] = [];
  // Resolvers waiting for `matches.length` to reach some target count; woken
  // (and pruned) on every matching socket, not just the next one.
  let pending: Array<{ target: number; wake: () => void }> = [];
  const onWebSocket = (ws: WebSocket): void => {
    if (!ws.url().includes(fragment)) return;
    matches.push(ws);
    pending = pending.filter(({ target, wake }) => {
      if (matches.length < target) return true;
      wake();
      return false;
    });
  };
  page.on("websocket", onWebSocket);

  const waitForCount = (target: number, timeoutMs: number): Promise<void> => {
    if (matches.length >= target) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = pending.filter((p) => p.wake !== wake);
        reject(
          new Error(
            `timed out waiting for ${target} websocket(s) matching "${fragment}" (got ${matches.length})`,
          ),
        );
      }, timeoutMs);
      const wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
      pending.push({ target, wake });
    });
  };

  try {
    // CI's shared preview can be slow to open the void/ws socket under
    // parallel load; give it more room there than a responsive local server.
    const firstConnectTimeout = process.env.CI ? 30_000 : 20_000;
    await navigate();
    await waitForCount(1, firstConnectTimeout);
    // A reconnect (if any) lands within a render tick or two. `.catch()` lets
    // the helper proceed with just the first socket when no remount occurs.
    await waitForCount(2, 2_000).catch(() => null);
  } finally {
    page.off("websocket", onWebSocket);
  }
}

test.describe("Realtime UI updates (void/ws rooms)", () => {
  test("run detail: per-test list, header OutcomeBar, and Tests-tab count stream live, and the status glyph flips on completion", async ({
    playwright,
    runDetailPage,
    ctx,
  }) => {
    const request = await playwright.request.newContext({ baseURL: ctx.url });
    try {
      const runId = await openRun(request, ctx.apiKey);
      const page = runDetailPage.page;
      await gotoAndAwaitRoom(page, () => runDetailPage.goto(runId), "/ws/run/");

      // Header (sticky top-0 H1) status glyph starts on "running". StatusGlyph
      // exposes role=img + aria-label; `exact` avoids colliding with the
      // OutcomeBar (also role=img, name "…passed, …failed, …").
      const header = page.getByTestId("run-header");
      await expect(
        header.getByRole("img", { name: "running", exact: true }),
      ).toBeVisible();

      await expect(runDetailPage.testRowLinks).toHaveCount(0);
      await appendResults(request, ctx.apiKey, runId, [
        { testId: "p-1", title: "p1", status: "passed" },
        { testId: "p-2", title: "p2", status: "passed" },
      ]);
      await appendResults(request, ctx.apiKey, runId, [
        { testId: "f-1", title: "f1", status: "failed" },
      ]);
      // The tab paginates by group: the live rows land in a group whose header
      // streams in on the throttled skeleton refresh. Expand it (idempotent for
      // the auto-expanded failing group) so all three rows render, then assert.
      await runDetailPage.expandTestGroups();
      await expect(runDetailPage.testRowLinks).toHaveCount(3);

      // Published SUMMARY snapshot drives the header OutcomeBar (role=img whose
      // accessible name is the aggregate counts) — distinct from the per-row
      // accumulator. 2 passed + 1 failed ⇒ "2 passed, 1 failed, …".
      await expect(
        page.getByRole("img", {
          name: /passed,.*failed,.*flaky,.*skipped/,
        }),
      ).toHaveAttribute("aria-label", /2 passed, 1 failed/, { timeout: 5_000 });

      // Tests-tab count is live (RunTestCountLive ← run-room summary.totalTests).
      await expect(page.getByRole("link", { name: /Tests\s*3/ })).toBeVisible();
      await expect(
        header.getByRole("img", { name: "running", exact: true }),
      ).toBeVisible();

      // Complete → the header status glyph flips to "failed" with no reload.
      await completeRun(request, ctx.apiKey, runId, "failed");
      await expect(
        header.getByRole("img", { name: "failed", exact: true }),
      ).toBeVisible();
      await expect(
        header.getByRole("img", { name: "running", exact: true }),
      ).toHaveCount(0);
    } finally {
      await request.dispose();
    }
  });

  test("runs list: a run streams its counts and flips to its terminal status on completion", async ({
    playwright,
    runsListPage,
    ctx,
  }) => {
    const request = await playwright.request.newContext({ baseURL: ctx.url });
    try {
      // Unique branch + branch-filtered list ⇒ our run is the only row shown.
      const branch = `e2e-rt-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      const runId = await openRun(request, ctx.apiKey, branch);
      const page = runsListPage.page;
      await gotoAndAwaitRoom(
        page,
        () => runsListPage.goto(`branch=${encodeURIComponent(branch)}`),
        "/ws/project/",
      );

      const row = page.locator(`tr:has(a[href*="/runs/${runId}"])`);
      await expect(row).toBeVisible();
      await expect(
        row.getByRole("img", { name: "running", exact: true }),
      ).toBeVisible();
      const total = row.getByText(/^\/\d+$/);
      await expect(total).toHaveText("/0");

      await appendResults(request, ctx.apiKey, runId, [
        { testId: "p-1", title: "p1", status: "passed" },
        { testId: "p-2", title: "p2", status: "passed" },
        { testId: "f-1", title: "f1", status: "failed" },
      ]);
      await expect(total).toHaveText("/3");
      await expect(
        row.getByRole("img", { name: "running", exact: true }),
      ).toBeVisible();

      await completeRun(request, ctx.apiKey, runId, "failed");
      await expect(
        row.getByRole("img", { name: "failed", exact: true }),
      ).toBeVisible();
      await expect(
        row.getByRole("img", { name: "running", exact: true }),
      ).toHaveCount(0);
    } finally {
      await request.dispose();
    }
  });

  test("runs list: a run opened AFTER load appears and streams live", async ({
    playwright,
    runsListPage,
    ctx,
  }) => {
    const request = await playwright.request.newContext({ baseURL: ctx.url });
    try {
      const page = runsListPage.page;
      // Default, unfiltered list ⇒ accepts a live run-created prepend.
      await gotoAndAwaitRoom(page, () => runsListPage.goto(), "/ws/project/");

      const runId = await openRun(request, ctx.apiKey);
      const row = page.locator(`tr:has(a[href*="/runs/${runId}"])`);
      await expect(row).toBeVisible();
      const total = row.getByText(/^\/\d+$/);
      await expect(total).toHaveText("/0");

      await appendResults(request, ctx.apiKey, runId, [
        { testId: "p-1", title: "p1", status: "passed" },
      ]);
      await expect(total).toHaveText("/1");
    } finally {
      await request.dispose();
    }
  });
});
