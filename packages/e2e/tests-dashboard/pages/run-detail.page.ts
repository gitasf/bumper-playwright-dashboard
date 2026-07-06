import { type Locator, type Page, expect } from "@playwright/test";

/**
 * Page object for `/t/:teamSlug/p/:projectSlug/runs/:runId`.
 *
 * Test-row anchors are recovered by href suffix (`a[href*="/tests/"]`) —
 * every row in the `RunProgress` Tests tab links to
 * `…/runs/<runId>/tests/<id>`, and no other anchor on the page does. The
 * back-link is recovered by URL suffix since it's generic chrome.
 */
export class RunDetailPage {
  readonly page: Page;
  readonly teamSlug: string;
  readonly projectSlug: string;

  readonly testRowLinks: Locator;
  readonly testTitleHeading: Locator;
  readonly testGroups: Locator;

  constructor(page: Page, teamSlug: string, projectSlug: string) {
    this.page = page;
    this.teamSlug = teamSlug;
    this.projectSlug = projectSlug;
    // The Tests tab paginates BY GROUP: each group renders as a disclosure
    // button (`data-testid="run-test-group"`, `aria-expanded`) and its test-row
    // links only render while it's open. Only failing groups auto-expand, so
    // reaching a passing run's rows means expanding the group first.
    this.testGroups = page.getByTestId("run-test-group");
    // Each test row in the Tests tab (`RunProgress` → `TestRow`) renders as
    // a `<Link>` whose href is `…/runs/<runId>/tests/<id>?attempt=0`. Scope
    // to those anchors by href: no other anchor on the run-detail page
    // points at `/tests/` (tab links use `?tab=`, the branch/PR/commit pills
    // are external github.com links, and the history-chart points link to
    // `/runs/<id>` without `/tests/`).
    this.testRowLinks = page.locator('a[href*="/tests/"]');
    // The test-detail page's only level-1 heading is the spec title. (The
    // former "Attempts & errors" section header was dropped when the attempts
    // panel was restyled to flat underline tabs.) It's the stable anchor that
    // proves the deep-dive page rendered rather than a 404 / error page, and
    // it doesn't depend on attempt count or pass/fail status.
    this.testTitleHeading = page.getByRole("heading", { level: 1 });
  }

  pathFor(runId: string): string {
    return `/t/${this.teamSlug}/p/${this.projectSlug}/runs/${runId}`;
  }

  async goto(runId: string): Promise<void> {
    const target = this.pathFor(runId);
    try {
      await this.page.goto(target);
    } catch (err) {
      // Retry once past the transient net::ERR_ABORTED seen under dev-server load.
      if (!/ERR_ABORTED/i.test(String(err))) throw err;
      await this.page.goto(target);
    }
  }

  /** Project-page back-link — the generic chrome anchor on every detail page. */
  backLink(): Locator {
    return this.page.locator(
      `a[href$="/t/${this.teamSlug}/p/${this.projectSlug}"]`,
    );
  }

  /**
   * Expand every collapsed test group so their rows render. The Tests-tab group
   * list loads client-side and only auto-expands FAILING groups, so a passing
   * group's `a[href*="/tests/"]` rows stay hidden until toggled. Waits for the
   * (deferred) group list to load, then opens each still-collapsed group. No-op
   * when the run has no groups (e.g. an empty run).
   */
  async expandTestGroups(): Promise<void> {
    // The list is client-loaded behind a skeleton; give it room to arrive.
    await expect(this.testGroups.first()).toBeVisible({ timeout: 15_000 });
    const count = await this.testGroups.count();
    for (let i = 0; i < count; i++) {
      const header = this.testGroups.nth(i);
      // Skip already-open groups — clicking one would collapse it.
      if ((await header.getAttribute("aria-expanded")) === "false") {
        await header.click();
      }
    }
  }

  async clickFirstTest(): Promise<void> {
    await this.expandTestGroups();
    const link = this.testRowLinks.first();
    await expect(link).toBeVisible({ timeout: 10_000 });
    await link.click();
    try {
      await this.page.waitForURL(/\/tests\//, { timeout: 10_000 });
    } catch (err) {
      // Re-click once if a pre-hydration click was dropped; bail if we did navigate.
      if (/\/tests\//.test(this.page.url())) throw err;
      await link.click();
      await this.page.waitForURL(/\/tests\//, { timeout: 10_000 });
    }
    await this.page.waitForLoadState("load");
  }
}
