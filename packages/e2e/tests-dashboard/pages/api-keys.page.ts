import { type Locator, type Page, expect } from "@playwright/test";

import { gotoAndExpect } from "../helpers/navigation";

/**
 * Page object for `/settings/teams/:slug/p/:slug/keys`. The mint form
 * uses a client-only mutation to mint and reveal each plaintext token.
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
    this.labelInput = page.getByLabel("Key label");
    this.mintButton = page.getByRole("button", { name: /mint key/i });
    // The freshly-minted token is surfaced in a Base UI Dialog
    // (role="dialog"), title "Save this key now" — not a status Alert.
    this.revealDialog = page.getByRole("dialog", {
      name: /save this key now/i,
    });
  }

  get path(): string {
    return `/settings/teams/${this.teamSlug}/p/${this.projectSlug}/keys`;
  }

  async goto(): Promise<void> {
    await gotoAndExpect(this.page, this.path, this.settingsHeading);
  }

  /** Mint a key with the given label. Returns the revealed plaintext. */
  async mint(label: string): Promise<string> {
    await expect(this.mintButton).toBeEnabled({ timeout: 15_000 });
    await this.labelInput.fill(label);
    await this.mintButton.click();
    await expect(this.revealDialog).toBeVisible({ timeout: 15_000 });
    const token = await this.revealDialog.locator("pre").innerText();
    // Dismiss the modal — left open, its overlay intercepts clicks on the keys
    // list behind it (e.g. the Revoke button), which is what broke the revoke
    // spec while the mint spec, which only reads visibility, was unaffected.
    await this.page.keyboard.press("Escape");
    await expect(this.revealDialog).not.toBeVisible();
    return token;
  }

  rowFor(label: string): Locator {
    // Not a table: each key is a <div data-testid="key-row"> with a label,
    // prefix, active/revoked badge, and (while active) a Revoke button. The
    // test id matches only the row container, so anchor there and narrow by
    // label — no `.last()` hack against the inner label-only <div> needed.
    return this.page.getByTestId("key-row").filter({ hasText: label });
  }

  async revoke(label: string): Promise<void> {
    const row = this.rowFor(label);
    await row.getByRole("button", { name: /^revoke$/i }).click();
  }
}
