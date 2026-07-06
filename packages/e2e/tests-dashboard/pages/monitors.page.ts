import { type Locator, type Page, expect } from "@playwright/test";

/**
 * Page object for the synthetic-monitors section under
 * `/t/:teamSlug/p/:projectSlug/monitors` — the list, the create form
 * (`/new`), and a monitor's detail (`/:monitorId`).
 *
 * The create form (`MonitorForm`) is a client island whose interactive leaf is
 * the `<CodeEditor>` source field. That editor renders a plain `<textarea>` on
 * the server / before hydration and swaps to a CodeMirror surface after mount —
 * both expose `role="textbox"` with `aria-label="Playwright source"`, and
 * Playwright's `fill` drives the textarea and CodeMirror's contenteditable
 * alike, so `sourceEditor` is a stable anchor across the swap. The rest of the
 * form posts natively even before hydration (the hidden `source`/`enabled`
 * fields are in the SSR HTML), so a submit works on the no-JS slow path too;
 * `create` retries the submit until the URL settles on the new detail page to
 * ride out the hydration window (same pattern as the api-keys mint).
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
  readonly enabledSwitch: Locator;
  readonly createButton: Locator;

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
    this.enabledSwitch = page.getByRole("switch");
    this.createButton = page.getByRole("button", { name: /create monitor/i });
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

  async gotoList(): Promise<void> {
    await this.page.goto(this.listPath);
    await expect(this.listHeading).toBeVisible();
  }

  /** Open the create form for the browser type directly (skips the chooser). */
  async gotoNew(): Promise<void> {
    await this.page.goto(`${this.newPath}?type=browser`);
    await expect(this.nameInput).toBeVisible();
  }

  /** Open the create form for the http (uptime) type directly (skips the chooser). */
  async gotoNewHttp(): Promise<void> {
    await this.page.goto(`${this.newPath}?type=http`);
    await expect(this.urlInput).toBeVisible();
  }

  /**
   * Fill + submit the http (uptime) create form, returning the new monitor's id.
   * The http form posts natively even before hydration (the hidden `type=http`,
   * `enabled`, `followRedirects`, and `assertions` fields are in the SSR HTML, and
   * the threshold inputs carry default values), so the same retry-submit pattern
   * as {@link create} rides out the hydration window.
   */
  async createHttp(opts: {
    name: string;
    intervalSeconds: number;
    url: string;
  }): Promise<string> {
    await this.nameInput.fill(opts.name);
    await this.intervalSelect.selectOption(String(opts.intervalSeconds));
    await this.urlInput.fill(opts.url);

    const detailUrlRe = new RegExp(
      `/monitors/(?!new(?:[/?#]|$))[^/?#]+(?:[?#]|$)`,
    );
    await expect(async () => {
      await this.createButton.click();
      await this.page.waitForURL(detailUrlRe, { timeout: 3_000 });
    }).toPass({ timeout: 15_000 });

    const match = new URL(this.page.url()).pathname.match(
      /\/monitors\/([^/?#]+)/,
    );
    const monitorId = match?.[1];
    if (!monitorId) {
      throw new Error(
        `createHttp() did not land on a monitor detail URL: ${this.page.url()}`,
      );
    }
    return monitorId;
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
  }): Promise<string> {
    await this.nameInput.fill(opts.name);
    await this.intervalSelect.selectOption(String(opts.intervalSeconds));
    if (opts.source !== undefined) {
      await this.sourceEditor.fill(opts.source);
    }

    // The form is a client island; before React hydrates a click does a native
    // POST (which is also handled by the action and redirects), but to be
    // robust against the SPA-action takeover mid-click, re-submit until the URL
    // lands on the detail page. The id is a ULID — exclude the `/monitors/new`
    // sentinel we post FROM, otherwise `waitForURL` matches the still-current
    // pre-redirect URL immediately and we'd capture "new" as the monitor id.
    const detailUrlRe = new RegExp(
      `/monitors/(?!new(?:[/?#]|$))[^/?#]+(?:[?#]|$)`,
    );
    await expect(async () => {
      await this.createButton.click();
      await this.page.waitForURL(detailUrlRe, { timeout: 3_000 });
    }).toPass({ timeout: 15_000 });

    const match = new URL(this.page.url()).pathname.match(
      /\/monitors\/([^/?#]+)/,
    );
    const monitorId = match?.[1];
    if (!monitorId) {
      throw new Error(
        `create() did not land on a monitor detail URL: ${this.page.url()}`,
      );
    }
    return monitorId;
  }

  /** A list-table row anchored on the monitor's name. */
  listRowFor(name: string): Locator {
    return this.page.getByRole("row").filter({ hasText: name });
  }

  // ─── Detail page ──────────────────────────────────────────────────────────

  async gotoDetail(monitorId: string): Promise<void> {
    await this.page.goto(this.detailPath(monitorId));
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

  /**
   * Open the edit modal. The modal's open state is keyed off `?edit=1`, which
   * the "Edit" link navigates to; the island then hydrates and shows it. Only
   * clicks when the form isn't already visible so a re-click can't land on the
   * (backdrop-covered) link, and retries to ride out the hydration window.
   */
  async openEdit(): Promise<void> {
    await expect(async () => {
      if (!(await this.saveEditButton.isVisible())) {
        await this.editLink.click();
      }
      await expect(this.saveEditButton).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 15_000 });
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
