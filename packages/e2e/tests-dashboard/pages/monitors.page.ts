import { type Locator, type Page, expect } from "@playwright/test";

import { gotoAndExpect, waitForHydration } from "../helpers/navigation";

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Page object for the synthetic-monitors section under
 * `/t/:teamSlug/p/:projectSlug/monitors` — the list, the create form
 * (`/new`), and a monitor's detail (`/:monitorId`).
 *
 * `create*` waits for app hydration (via {@link waitForHydration}) before
 * filling controlled fields, so tests never drive the fallback textarea while
 * CodeMirror is replacing it.
 */
export class MonitorsPage {
  readonly page: Page;
  readonly teamSlug: string;
  readonly projectSlug: string;

  readonly listHeading: Locator;
  readonly newMonitorLink: Locator;
  readonly nameInput: Locator;
  readonly intervalSelect: Locator;
  readonly sourceEditor: Locator;
  readonly urlInput: Locator;
  readonly createButton: Locator;
  readonly enabledSwitch: Locator;
  readonly pauseButton: Locator;
  readonly resumeButton: Locator;

  constructor(page: Page, teamSlug: string, projectSlug: string) {
    this.page = page;
    this.teamSlug = teamSlug;
    this.projectSlug = projectSlug;

    this.listHeading = page.getByRole("heading", { name: /^monitors$/i });
    this.newMonitorLink = page.getByRole("link", { name: /new monitor/i });
    this.nameInput = page.locator('input[name="name"]');
    this.intervalSelect = page.locator('select[name="intervalSeconds"]');
    this.sourceEditor = page.getByRole("textbox", {
      name: /playwright source/i,
    });
    this.urlInput = page.locator('input[name="url"]');
    this.createButton = page.getByRole("button", { name: /create monitor/i });
    this.enabledSwitch = page.getByRole("switch", {
      name: /^(enabled|paused)\b/i,
    });
    this.pauseButton = page.getByRole("button", { name: /^pause$/i });
    this.resumeButton = page.getByRole("button", { name: /^resume$/i });
  }

  get base(): string {
    return `/t/${this.teamSlug}/p/${this.projectSlug}`;
  }

  get listPath(): string {
    return `${this.base}/monitors`;
  }

  get newPath(): string {
    return `${this.listPath}/new`;
  }

  detailPath(monitorId: string): string {
    return `${this.listPath}/${monitorId}`;
  }

  /**
   * URL pattern for a monitor detail page under THIS team/project (excludes
   * `/new`), so a wrong-tenant redirect can never satisfy the assertion.
   */
  private get detailUrl(): RegExp {
    return new RegExp(
      `${escapeRegExp(this.listPath)}/(?!new(?:[/?#]|$))[^/?#]+(?:[?#]|$)`,
    );
  }

  private async submitCreate(): Promise<string> {
    await this.createButton.click();
    await expect(this.page).toHaveURL(this.detailUrl, { timeout: 15_000 });
    // The create action redirects via a full page load, so the detail page
    // hydrates like any fresh navigation; callers chain straight into
    // pause()/openEdit(), whose clicks a mid-hydration render can swallow.
    await waitForHydration(this.page);

    const monitorId = new URL(this.page.url()).pathname.match(
      /\/monitors\/([^/?#]+)/,
    )?.[1];
    if (!monitorId) {
      throw new Error(
        `Monitor creation did not land on a detail URL: ${this.page.url()}`,
      );
    }
    return monitorId;
  }

  async gotoList(): Promise<void> {
    await gotoAndExpect(this.page, this.listPath, this.listHeading);
  }

  /** Open the create form for the browser type directly (skips the chooser). */
  async gotoNew(): Promise<void> {
    await gotoAndExpect(
      this.page,
      `${this.newPath}?type=browser`,
      this.nameInput,
    );
  }

  /** Open the create form for the http (uptime) type directly (skips the chooser). */
  async gotoNewHttp(): Promise<void> {
    await gotoAndExpect(this.page, `${this.newPath}?type=http`, this.urlInput);
  }

  async createHttp(opts: {
    name: string;
    intervalSeconds: number;
    url: string;
    enabled?: boolean;
  }): Promise<string> {
    await waitForHydration(this.page);
    await this.nameInput.fill(opts.name);
    await this.intervalSelect.selectOption(String(opts.intervalSeconds));
    await this.urlInput.fill(opts.url);
    await this.setFormEnabled(opts.enabled ?? true);

    return this.submitCreate();
  }

  /**
   * Fill + submit the create form, returning the new monitor's id (recovered
   * from the detail URL the create action redirects to:
   * `…/monitors/<monitorId>`). `intervalSeconds` is one of the preset values
   * (60 = "Every 1m"). The source defaults to a passing smoke check so the stub
   * executor synthesizes a `passed` run.
   */
  async create(opts: {
    name: string;
    intervalSeconds: number;
    source?: string;
    enabled?: boolean;
  }): Promise<string> {
    await waitForHydration(this.page);
    await this.nameInput.fill(opts.name);
    await this.intervalSelect.selectOption(String(opts.intervalSeconds));
    if (opts.source !== undefined) {
      await this.sourceEditor.fill(opts.source);
    }
    await this.setFormEnabled(opts.enabled ?? true);

    return this.submitCreate();
  }

  private async setFormEnabled(enabled: boolean): Promise<void> {
    if (enabled) return;
    await expect(this.enabledSwitch).toBeChecked();
    await this.enabledSwitch.click();
    await expect(this.enabledSwitch).not.toBeChecked();
  }

  /** A list-table row anchored on the monitor's name. */
  listRowFor(name: string): Locator {
    return this.page.getByRole("row").filter({ hasText: name });
  }

  // ─── Detail page ──────────────────────────────────────────────────────────

  async gotoDetail(monitorId: string): Promise<void> {
    await gotoAndExpect(
      this.page,
      this.detailPath(monitorId),
      this.page.getByRole("heading", { level: 1 }),
    );
  }

  async pause(): Promise<void> {
    await this.pauseButton.click();
    await expect(this.resumeButton).toBeVisible();
  }

  async resume(): Promise<void> {
    await this.resumeButton.click();
    await expect(this.pauseButton).toBeVisible();
  }

  /** The empty-executions placeholder shown before any execution lands. */
  get emptyExecutions(): Locator {
    return this.page.getByText(/no executions yet/i);
  }

  /** The Executions section's "View run" deep-links (one per execution row). */
  get runLinks(): Locator {
    return this.page.getByRole("link", { name: /view run/i });
  }

  // ─── Alert controls (owner-only, detail page) ───────────────────────────────
  //
  // The Mute/Unmute button is a server-rendered header form that POSTs and
  // redirects back — no island. The alert-recipients picker now lives INSIDE
  // the edit modal (a `MonitorEditDialog` island keyed off `?edit=1`): its
  // radios/checkboxes ride in the same `updateMonitor` form as the config, so
  // one "Save changes" persists both. The button label is the unambiguous
  // state signal (alerts on ⇒ "Mute alerts").

  get muteAlertsButton(): Locator {
    return this.page.getByRole("button", { name: /^mute alerts$/i });
  }

  get unmuteAlertsButton(): Locator {
    return this.page.getByRole("button", { name: /^unmute alerts$/i });
  }

  /** Mute alerts and wait for the control to flip to "Unmute alerts". */
  async muteAlerts(): Promise<void> {
    await this.muteAlertsButton.click();
    await expect(this.unmuteAlertsButton).toBeVisible();
  }

  /** Unmute alerts and wait for the control to flip back to "Mute alerts". */
  async unmuteAlerts(): Promise<void> {
    await this.unmuteAlertsButton.click();
    await expect(this.muteAlertsButton).toBeVisible();
  }

  /** The "Edit" affordance (`Button render={<Link href=?edit=1>}` ⇒ role link). */
  private get editLink(): Locator {
    return this.page.getByRole("link", { name: /^edit$/i }).first();
  }

  /** The edit form inside the modal (config + recipients share one form). */
  private get editForm(): Locator {
    return this.page.locator('form[action*="updateMonitor"]');
  }

  get saveEditButton(): Locator {
    return this.editForm.getByRole("button", { name: /save changes/i });
  }

  async openEdit(): Promise<void> {
    await expect(this.editLink).toBeVisible();
    // Pin the assertion to the detail page we're editing, not any ?edit=1 URL.
    const detailPathname = new URL(this.page.url()).pathname;
    await this.editLink.click();
    await expect(this.page).toHaveURL(
      new RegExp(`${escapeRegExp(detailPathname)}\\?(?:.*&)?edit=1(?:&|$)`),
      { timeout: 15_000 },
    );
    await expect(this.saveEditButton).toBeVisible({ timeout: 15_000 });
  }

  recipientModeRadio(mode: "all" | "specific"): Locator {
    return this.editForm.locator(
      `input[name="recipientMode"][value="${mode}"]`,
    );
  }

  /** The member checkbox (name="user") whose label carries `email`. */
  recipientMemberCheckbox(email: string): Locator {
    return this.editForm
      .locator("label")
      .filter({ hasText: email })
      .getByRole("checkbox");
  }

  /**
   * Pick "specific" recipients (the given member emails) and save. Assumes the
   * edit modal is already open (call {@link openEdit} first). Waits for the
   * modal to close after the save redirect.
   */
  async setSpecificRecipients(memberEmails: string[]): Promise<void> {
    await this.recipientModeRadio("specific").check();
    for (const email of memberEmails) {
      await this.recipientMemberCheckbox(email).check();
    }
    await this.saveEditButton.click();
    await expect(this.editForm).toBeHidden();
  }

  /**
   * Reset recipients back to "All team members" and save. Assumes the edit
   * modal is already open; waits for it to close after the save redirect.
   */
  async setAllRecipients(): Promise<void> {
    await this.recipientModeRadio("all").check();
    await this.saveEditButton.click();
    await expect(this.editForm).toBeHidden();
  }
}
