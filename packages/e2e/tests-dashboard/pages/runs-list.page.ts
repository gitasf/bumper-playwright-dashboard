import { type Locator, type Page, expect } from "@playwright/test";

import { gotoAndExpect, waitForHydration } from "../helpers/navigation";

/**
 * Page object for `/t/:teamSlug/p/:projectSlug` (the project's runs list).
 * Encapsulates the run-row link contract and the empty-state copy.
 */
export class RunsListPage {
  readonly page: Page;
  readonly teamSlug: string;
  readonly projectSlug: string;

  readonly heading: Locator;
  readonly emptyState: Locator;
  readonly runLinks: Locator;
  readonly userMenuTrigger: Locator;
  readonly logoutButton: Locator;

  constructor(page: Page, teamSlug: string, projectSlug: string) {
    this.page = page;
    this.teamSlug = teamSlug;
    this.projectSlug = projectSlug;

    this.heading = page.getByRole("heading", { name: /^Runs$/ });
    this.emptyState = page.getByText(/no test runs/i);
    // Each run anchor wraps an `<span class="sr-only">View run …</span>`
    // for screen readers; that's the link's accessible name. Anchoring
    // on role+name leans on real a11y instead of a test-only attribute.
    this.runLinks = page.getByRole("link", { name: /^View run/i });
    this.userMenuTrigger = page.getByLabel(/account menu for/i);
    this.logoutButton = page.getByRole("button", { name: /sign out/i });
  }

  get path(): string {
    return `/t/${this.teamSlug}/p/${this.projectSlug}`;
  }

  async goto(query?: string): Promise<void> {
    const target = query ? `${this.path}?${query}` : this.path;
    await gotoAndExpect(this.page, target, this.heading);
  }

  async expectLoaded(): Promise<void> {
    await expect(this.heading).toBeVisible();
  }

  /** Returns the runId of the first row, or throws if none exist. */
  async firstRunId(): Promise<string> {
    const link = this.runLinks.first();
    await expect(link).toHaveAttribute("href", /\/runs\//, {
      timeout: 15_000,
    });
    const href = await link.getAttribute("href");
    if (!href) throw new Error("no run-row-link href on the project page");
    const match = href.match(/\/runs\/([\w]+)/);
    if (!match) throw new Error(`could not parse runId from "${href}"`);
    return match[1];
  }

  async clickFirstRun(): Promise<string> {
    const id = await this.firstRunId();
    await waitForHydration(this.page);
    await this.runLinks.first().click();
    await expect(this.page).toHaveURL(new RegExp(`/runs/${id}(?:\\?|$)`), {
      timeout: 15_000,
    });
    return id;
  }

  async openUserMenu(): Promise<void> {
    // The popover trigger is a client island; until React hydrates, the
    // click is a no-op. Re-click with a poll until the menu actually
    // opens. (`networkidle` would be a worse fix — the dashboard has
    // long-lived synced-state subscriptions that keep the network busy.)
    await expect(async () => {
      await this.userMenuTrigger.click();
      await expect(this.logoutButton).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
  }

  async logout(): Promise<void> {
    await this.openUserMenu();
    await this.logoutButton.click();
    await this.page.waitForURL((url) => url.pathname === "/login", {
      timeout: 10_000,
    });
  }
}
