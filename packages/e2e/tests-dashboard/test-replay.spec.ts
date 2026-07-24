import { expect, test } from "./fixtures";
import { FAILURES_BRANCH } from "./global-setup";

// Real trace parsing crosses the artifact proxy, service worker, and iframe.
test.setTimeout(90_000);

/**
 * Embedded Test Replay — Wrightful's OWN trace viewer.
 *
 * The reporter uploads `trace.zip` per failed/flaky attempt. The dashboard
 * renders replays with its own React workbench (`src/trace-viewer/`) built on
 * the vendored Playwright service worker: a hidden bridge iframe under
 * `/trace-viewer/` loads the parsed model (`contexts?trace=…`), and DOM
 * snapshots render in iframes served by the SW
 * (`/trace-viewer/snapshot/<pageId>?trace=…`). The official viewer bundle
 * stays vendored as the engine only — there's no separate "official viewer"
 * fallback link; the replay endpoint's `attempts` entries carry just
 * `{ attempt, downloadHref }`, the signed artifact-download URL the native
 * workbench's SW range-reads.
 *
 * These specs prove: (1) the SW scope is served with the headers that make
 * registration + same-origin snapshot framing possible while the rest of the
 * app stays strict; (2) the per-row "Replay" button deep-links `?replay=` and
 * opens the native workbench with a REAL trace driven through the real SW —
 * action list populated, snapshot document served; (3) the test-detail rail
 * does the same. This doubles as the vendored-engine contract test: a
 * playwright-core bump that breaks the SW's `contexts`/`snapshot` endpoints
 * or the model shape fails here, not in production.
 *
 * The seed (`upload-fixtures.mjs`, reporter `artifacts: "all"` +
 * `trace: "retain-on-failure"`) gives the `FAILURES_BRANCH` run tests that
 * failed and therefore carry a trace — so the replay affordances render.
 */
test.describe("Test Replay (embedded trace viewer)", () => {
  test("serves the SW scope with same-origin framing; global routes stay strict", async ({
    page,
  }) => {
    // The vendored engine files our viewer depends on.
    for (const path of [
      "/trace-viewer/sw.bundle.js",
      "/trace-viewer/bridge.html",
      "/trace-viewer/index.html", // official-viewer fallback, still vendored
    ]) {
      const res = await page.request.get(path);
      expect(res.status(), path).toBe(200);
      const h = res.headers();
      // Relaxed only for /trace-viewer/* so snapshots can be framed and the
      // SW can register at the directory scope.
      expect(h["x-frame-options"]?.toLowerCase(), path).toBe("sameorigin");
      expect(h["content-security-policy"], path).toContain(
        "frame-ancestors 'self'",
      );
      expect(h["service-worker-allowed"], path).toBe("/trace-viewer/");
    }

    // Every other route keeps the strict global policy — the relaxation must
    // not leak. A normal page response still denies framing entirely.
    const normal = await page.request.get("/login");
    const nh = normal.headers();
    expect(nh["x-frame-options"]?.toLowerCase()).toBe("deny");
    expect(nh["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  test("run test-list Replay button opens the native workbench, deep-links, and closes on Escape", async ({
    page,
    openSeededRun,
  }, testInfo) => {
    // Three 40s workbench outcomes, two dialog remounts, and the later snapshot
    // and cold deep-link checks must all fit when both recovery attempts fire.
    testInfo.setTimeout(240_000);

    await openSeededRun(FAILURES_BRANCH);

    // The button renders only for rows whose test has a trace (the row's
    // `hasTrace`, set by the `…/results` read); the failures run has at least one.
    const replay = page.getByRole("button", { name: /^replay$/i }).first();
    await expect(replay).toBeVisible({ timeout: 10_000 });

    // Clicking sets `?replay=<testResultId>`; the page-level host then fetches
    // the replay endpoint. Each attempt entry carries only `{ attempt,
    // downloadHref }` — the signed artifact-download URL
    // (`/api/artifacts/:id/download?t=<token>`, see `signedDownloadHref` in
    // `src/lib/artifacts/tokens.ts`) that the native workbench's service
    // worker range-reads directly; there's no separate trace-viewer URL
    // field. The modal replays the LAST attempt.
    const [resp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/replay") && r.request().method() === "GET",
      ),
      replay.click(),
    ]);
    expect(resp.ok()).toBe(true);
    const body = (await resp.json()) as {
      attempts?: Array<{ downloadHref?: unknown }>;
    };
    const downloadHref = body.attempts?.at(-1)?.downloadHref ?? null;
    expect(typeof downloadHref).toBe("string");
    expect(downloadHref).toMatch(/^\/api\/artifacts\/.+\/download\?t=.+/);
    expect(downloadHref).not.toContain("trace.playwright.dev");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // The NATIVE workbench loads the real trace through the real service
    // worker: the action list populates from the parsed model. Under a busy
    // preview (parallel workers), the workbench's own 30s no-progress
    // watchdog (BRIDGE_TIMEOUT_MS in use-trace-model.ts) can fire before the
    // queued SW/trace fetches complete, leaving a terminal "Couldn't load
    // this trace" state. Closing and reopening the dialog remounts the
    // bridge iframe — a pure read, no side effects to repeat — so recover
    // from that specific terminal state rather than failing on contention.
    const actionList = dialog.getByRole("listbox", { name: "Actions" });
    const loadError = dialog.getByText(/couldn't load this trace/i);
    const workbenchOutcome = async (): Promise<"ready" | "error"> => {
      await expect(actionList.or(loadError)).toBeVisible({ timeout: 40_000 });
      return (await actionList.isVisible()) ? "ready" : "error";
    };
    let outcome = await workbenchOutcome();
    for (let retry = 0; outcome === "error" && retry < 2; retry++) {
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await replay.click();
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      outcome = await workbenchOutcome();
    }
    expect(outcome).toBe("ready");
    expect(await actionList.getByRole("option").count()).toBeGreaterThan(0);

    // …and the DOM snapshot iframes are served by the SW from the trace
    // (up to three stacked, one per Before/Action/After — see snapshot-pane).
    await expect(
      dialog.locator('iframe[title^="DOM snapshot"]').first(),
    ).toHaveAttribute("src", /\/trace-viewer\/snapshot\/.+\?.*trace=/, {
      timeout: 30_000,
    });

    // Parity-pass chrome renders alongside the workbench: the action search
    // box, the Call detail tab, and the timeline strip above the panes.
    await expect(
      dialog.getByRole("searchbox", { name: "Filter actions" }),
    ).toBeVisible();
    await expect(dialog.getByRole("tab", { name: "Call" })).toBeVisible();

    // Opening the modal is reflected in the URL (deep-linkable / shareable).
    await expect(page).toHaveURL(/[?&]replay=/);
    const deepLink = page.url();

    // Escape closes the modal and drops the param from the URL.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await expect(page).not.toHaveURL(/[?&]replay=/);

    // A cold load of the shared link re-opens the same modal (the host reads
    // the param and re-mints the trace URL), independent of any row being
    // expanded.
    await page.goto(deepLink);
    const relinked = page.getByRole("dialog");
    await expect(relinked).toBeVisible({ timeout: 10_000 });
    await expect(
      relinked.getByRole("listbox", { name: "Actions" }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("test-detail rail shows Replay (native viewer) alongside the standalone video/screenshot buttons", async ({
    page,
    openSeededRun,
  }) => {
    await openSeededRun(FAILURES_BRANCH);

    // Navigate into a test known to have a trace: the row carrying the
    // list-level Replay button. `TestRow` (run/progress-row.tsx) renders each
    // row as a `<div className="group …">` with the detail `<Link>` and the
    // `<ReplayRowButton>` as siblings (a control nested inside an <a> is
    // invalid HTML). Recover the row by filtering row containers to the one
    // that has the Replay button, not an XPath parent-hop. Click its sibling
    // detail link (SPA nav keeps the app hydrated so the rail's dialog trigger
    // is interactive on arrival; a full `goto` would race re-hydration). The
    // row no longer bounces back to the run page (see use-feed-room's guard).
    const listReplay = page.getByRole("button", { name: /^replay$/i }).first();
    await expect(listReplay).toBeVisible({ timeout: 10_000 });
    const row = page
      .locator("div.group")
      .filter({ has: listReplay })
      .filter({ has: page.locator('a[href*="/tests/"]') });
    await row.locator('a[href*="/tests/"]').first().click();
    await page.waitForURL(/\/tests\//, { timeout: 15_000 });

    // Rail button renamed from "Trace Viewer" → "Replay".
    const railReplay = page.getByRole("button", { name: /^replay$/i });
    await expect(railReplay).toBeVisible({ timeout: 10_000 });

    // The standalone Video / Screenshot rail buttons are kept alongside Replay —
    // handy for grabbing a single asset without the whole trace.zip,
    // and the embedded viewer doesn't render the video anyway. The seed run
    // (reporter `artifacts: "all"`) carries both for a failed test.
    await expect(
      page.getByRole("button", { name: /^video$/i }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^screenshot$/i }).first(),
    ).toBeVisible();

    // Opening it renders the native workbench off the real trace.
    await railReplay.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByRole("listbox", { name: "Actions" })).toBeVisible({
      timeout: 30_000,
    });
  });
});
