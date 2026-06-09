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

  async gotoNew(): Promise<void> {
    await this.page.goto(this.newPath);
    await expect(this.nameInput).toBeVisible();
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
}
