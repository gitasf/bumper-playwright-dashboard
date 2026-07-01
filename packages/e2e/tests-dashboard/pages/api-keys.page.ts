import { type Locator, type Page, expect } from "@playwright/test";

/**
 * Page object for `/settings/teams/:slug/p/:slug/keys`. The mint form
 * uses a Base UI <FieldLabel> which doesn't always wire up cleanly to
 * Playwright's getByLabel; the input is targeted by `name` instead.
 */
export class ApiKeysPage {
  readonly page: Page;
  readonly teamSlug: string;
  readonly projectSlug: string;

  readonly settingsHeading: Locator;
  readonly labelInput: Locator;
  readonly mintButton: Locator;
  readonly revealDialog: Locator;

  constructor(page: Page, teamSlug: string, projectSlug: string) {
    this.page = page;
    this.teamSlug = teamSlug;
    this.projectSlug = projectSlug;

    // The project settings page (API keys live in a "Keys · N" card on it)
    // renders a single <h1> reading `${project.name} · Settings`. The card
    // titles ("Keys · N", etc.) are styled <div>s, not heading roles, so the
    // only project-independent heading text is "Settings".
    this.settingsHeading = page.getByRole("heading", {
      name: /settings/i,
    });
    this.labelInput = page.locator('input[name="label"]');
    this.mintButton = page.getByRole("button", { name: /mint key/i });
    // The freshly-minted token is surfaced in a Base UI Dialog
    // (role="dialog"), title "Save this key now" — not a status Alert.
    this.revealDialog = page.getByRole("dialog").filter({
      hasText: /save this key now/i,
    });
  }

  get path(): string {
    return `/settings/teams/${this.teamSlug}/p/${this.projectSlug}/keys`;
  }

  async goto(): Promise<void> {
    await this.page.goto(this.path);
    await expect(this.settingsHeading).toBeVisible();
  }

  /** Mint a key with the given label. Returns the revealed plaintext. */
  async mint(label: string): Promise<string> {
    // The mint form is a client island. Before React hydrates, clicking the
    // submit button does a native GET (appending ?label=… to the URL) rather
    // than running the mintKey mutation, so the dialog never opens. Re-fill +
    // re-click until it appears — once hydrated, the mutation runs and the
    // RevealOnceDialog (role="dialog", title "Save this key now") surfaces the
    // plaintext token in a <pre>. Scope the lookup to the dialog so an
    // unrelated <pre> elsewhere on the page can't shadow it.
    await expect(async () => {
      await this.labelInput.fill(label);
      await this.mintButton.click();
      await expect(this.revealDialog).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    const token = await this.revealDialog.locator("pre").innerText();
    // Dismiss the modal — left open, its overlay intercepts clicks on the keys
    // list behind it (e.g. the Revoke button), which is what broke the revoke
    // spec while the mint spec, which only reads visibility, was unaffected.
    await this.page.keyboard.press("Escape");
    await expect(this.revealDialog).not.toBeVisible();
    return token;
  }

  rowFor(label: string): Locator {
    // The keys list is not a table: each key is a <div> row containing
    // the label, prefix, a status badge with exact text "active"/
    // "revoked", and (while active) a Revoke button. Anchor on the row
    // <div> that holds both the label and the status badge so the inner
    // label-only <div> can't match.
    return this.page
      .locator("div")
      .filter({ hasText: label })
      .filter({ has: this.page.getByText(/^(active|revoked)$/i) })
      .last();
  }

  async revoke(label: string): Promise<void> {
    const row = this.rowFor(label);
    await row.getByRole("button", { name: /^revoke$/i }).click();
  }
}
