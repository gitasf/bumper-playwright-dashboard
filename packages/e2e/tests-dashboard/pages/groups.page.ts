import { type Locator, type Page, expect } from "@playwright/test";

import { gotoAndExpect } from "../helpers/navigation";

/**
 * Page object for the team-settings Groups page
 * (`/settings/teams/:teamSlug/groups`) — owner-managed, server-rendered CRUD
 * over `memberGroups`.
 *
 * The page is plain server-rendered forms (no island): create / save / delete
 * each POST to a `?action`-suffixed handler that redirects back to the list, so
 * a click drives a native submit + redirect on the no-JS path and the
 * @void/react SPA takeover post-hydration alike. Locators anchor on the
 * per-action `form[action*="…"]` and on each group's card (scoped by the
 * group's unique, timestamped name) so parallel specs/groups don't collide.
 */
export class GroupsPage {
  readonly page: Page;
  readonly teamSlug: string;
  readonly heading: Locator;

  constructor(page: Page, teamSlug: string) {
    this.page = page;
    this.teamSlug = teamSlug;
    this.heading = page.getByRole("heading", { name: /^groups$/i });
  }

  get path(): string {
    return `/settings/teams/${this.teamSlug}/groups`;
  }

  async goto(): Promise<void> {
    await gotoAndExpect(this.page, this.path, this.heading);
  }

  private get createForm(): Locator {
    return this.page.locator('form[action*="createGroup"]');
  }

  private get editForm(): Locator {
    return this.page.locator('form[action*="saveGroup"]');
  }

  /** A group's settings card, anchored on its (unique) name. */
  card(name: string): Locator {
    return this.page.getByTestId("group-card").filter({ hasText: name });
  }

  /**
   * Create a group, checking the member checkbox for each listed email. Resolves
   * once the new card is on the list (the create action redirects back here).
   */
  async create(name: string, memberEmails: string[] = []): Promise<void> {
    const form = this.createForm;
    await form.locator('input[name="name"]').fill(name);
    for (const email of memberEmails) {
      await form
        .locator("label")
        .filter({ hasText: email })
        .getByRole("checkbox")
        .check();
    }
    await form.getByRole("button", { name: /create group/i }).click();
    await expect(this.card(name)).toBeVisible({ timeout: 15_000 });
  }

  async createExpectingDuplicate(name: string): Promise<void> {
    const form = this.createForm;
    await form.locator('input[name="name"]').fill(name);
    await form.getByRole("button", { name: /create group/i }).click();
    await expect(this.page.getByRole("alert")).toContainText(
      /already exists/i,
      {
        timeout: 15_000,
      },
    );
  }

  /** Open the inline editor for a group (its `?editGroup=` Link). */
  async openEditor(name: string): Promise<void> {
    await this.card(name).getByRole("link", { name: /edit/i }).click();
    await expect(this.editForm.locator('input[name="name"]')).toBeVisible();
  }

  /**
   * Edit a group's name and/or its exact member set, then save. Members are set
   * absolutely: every member checkbox is cleared first, then the ones whose
   * email is in `memberEmails` are checked, mirroring the form's
   * replace-wholesale semantics.
   */
  async edit(
    currentName: string,
    opts: { newName?: string; memberEmails: string[] },
  ): Promise<void> {
    await this.openEditor(currentName);
    const form = this.editForm;
    if (opts.newName !== undefined) {
      await form.locator('input[name="name"]').fill(opts.newName);
    }
    const boxes = form.locator('input[name="member"]');
    const count = await boxes.count();
    for (let i = 0; i < count; i++) {
      await boxes.nth(i).uncheck();
    }
    for (const email of opts.memberEmails) {
      await form
        .locator("label")
        .filter({ hasText: email })
        .getByRole("checkbox")
        .check();
    }
    await form.getByRole("button", { name: /^save$/i }).click();
  }

  /** Delete a group via its card's `?deleteGroup` form. */
  async delete(name: string): Promise<void> {
    await this.card(name)
      .locator('form[action*="deleteGroup"]')
      .getByRole("button", { name: /delete/i })
      .click();
    await expect(this.card(name)).toHaveCount(0);
  }
}
