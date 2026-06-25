import { expect, test } from "./fixtures";
import { FAILURES_BRANCH } from "./global-setup";

/**
 * Embedded Test Replay (self-hosted Playwright Trace Viewer).
 *
 * The reporter uploads `trace.zip` per failed/flaky attempt; the dashboard now
 * serves the official trace viewer from its OWN origin (`/trace-viewer/…`,
 * vendored into `public/`) and embeds it in a dialog, instead of linking out to
 * the public trace.playwright.dev. These specs prove: (1) the bundle is served
 * with the framing/CSP headers that make same-origin embedding possible while
 * the rest of the app stays strict; (2) the per-row "Test Replay" button in a
 * run's test list mints a self-hosted viewer URL and opens it; (3) the
 * test-detail rail's "Test Replay" button does the same, alongside the
 * standalone Video/Screenshot buttons (kept so a single asset can be grabbed
 * without downloading the whole trace.zip).
 *
 * The seed (`upload-fixtures.mjs`, reporter `artifacts: "all"` +
 * `trace: "retain-on-failure"`) gives the `FAILURES_BRANCH` run tests that
 * failed and therefore carry a trace — so the replay affordances render.
 */
test.describe("Test Replay (embedded trace viewer)", () => {
  test("serves the self-hosted bundle with same-origin framing; global routes stay strict", async ({
    page,
  }) => {
    const viewer = await page.request.get("/trace-viewer/index.html");
    expect(viewer.status()).toBe(200);
    const h = viewer.headers();
    // Relaxed only for /trace-viewer/* so the dashboard can iframe it.
    expect(h["x-frame-options"]?.toLowerCase()).toBe("sameorigin");
    expect(h["content-security-policy"]).toContain("frame-ancestors 'self'");
    // The service worker that serves DOM snapshots must be in scope.
    expect(h["service-worker-allowed"]).toBe("/trace-viewer/");

    // Every other route keeps the strict global policy — the relaxation must
    // not leak. A normal page response still denies framing entirely.
    const normal = await page.request.get("/login");
    const nh = normal.headers();
    expect(nh["x-frame-options"]?.toLowerCase()).toBe("deny");
    expect(nh["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  test("run test-list Test Replay button mints a self-hosted viewer URL and opens it", async ({
    page,
    runsListPage,
    runDetailPage,
  }) => {
    await runsListPage.goto(`branch=${encodeURIComponent(FAILURES_BRANCH)}`);
    const runId = await runsListPage.firstRunId();
    await runDetailPage.goto(runId);

    // The button renders only for rows whose test has a trace (the loader's
    // `tracedTestIds`); the failures run has at least one.
    const replay = page.getByRole("button", { name: /test replay/i }).first();
    await expect(replay).toBeVisible({ timeout: 10_000 });

    // Clicking fetches the lazy replay endpoint, then opens the dialog with the
    // returned URL. Assert the endpoint hands back a SELF-HOSTED viewer URL.
    const [resp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/replay") && r.request().method() === "GET",
      ),
      replay.click(),
    ]);
    expect(resp.ok()).toBe(true);
    const body: unknown = await resp.json();
    const traceViewerUrl =
      body && typeof body === "object" && "traceViewerUrl" in body
        ? body.traceViewerUrl
        : null;
    expect(typeof traceViewerUrl).toBe("string");
    expect(traceViewerUrl).toContain("/trace-viewer/index.html?trace=");
    expect(traceViewerUrl).not.toContain("trace.playwright.dev");

    // The dialog mounts an iframe pointed at that same-origin viewer URL.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    const frame = dialog.locator("iframe");
    await expect(frame).toHaveAttribute(
      "src",
      /\/trace-viewer\/index\.html\?trace=/,
    );
  });

  test("test-detail rail shows Test Replay (self-hosted) alongside the standalone video/screenshot buttons", async ({
    page,
    runsListPage,
    runDetailPage,
  }) => {
    await runsListPage.goto(`branch=${encodeURIComponent(FAILURES_BRANCH)}`);
    const runId = await runsListPage.firstRunId();
    await runDetailPage.goto(runId);

    // Navigate into a test KNOWN to have a trace: the row that carries the
    // list-level Test Replay button. Click its sibling detail link (SPA nav, so
    // the app stays hydrated and the rail's dialog trigger is interactive on
    // arrival — a full `goto` would race re-hydration). The run-detail row no
    // longer bounces back to the run page (see use-feed-room's navigation guard).
    const listReplay = page
      .getByRole("button", { name: /test replay/i })
      .first();
    await expect(listReplay).toBeVisible({ timeout: 10_000 });
    const row = listReplay.locator("xpath=..");
    await row.locator('a[href*="/tests/"]').first().click();
    await page.waitForURL(/\/tests\//, { timeout: 15_000 });

    // Rail button renamed from "Trace Viewer" → "Test Replay".
    const railReplay = page.getByRole("button", { name: /test replay/i });
    await expect(railReplay).toBeVisible({ timeout: 10_000 });

    // The standalone Video / Screenshot rail buttons are kept alongside Test
    // Replay — handy for grabbing a single asset without the whole trace.zip,
    // and the embedded viewer doesn't render the video anyway. The seed run
    // (reporter `artifacts: "all"`) carries both for a failed test.
    await expect(
      page.getByRole("button", { name: /^video$/i }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^screenshot$/i }).first(),
    ).toBeVisible();

    // Opening it embeds the self-hosted viewer (not trace.playwright.dev).
    await railReplay.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.locator("iframe")).toHaveAttribute(
      "src",
      /\/trace-viewer\/index\.html\?trace=/,
    );
  });
});
