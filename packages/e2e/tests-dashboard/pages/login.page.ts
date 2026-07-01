import { type Locator, type Page, expect } from "@playwright/test";

/**
 * Page object for /login and /signup. Both routes render the same
 * `<LoginForm>` with a `name` input added in signup mode, so this
 * single class covers both flows.
 */
export class LoginPage {
  readonly page: Page;
  readonly nameInput: Locator;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly signInButton: Locator;
  readonly createAccountButton: Locator;
  readonly errorAlert: Locator;
  readonly signUpHeading: Locator;

  constructor(page: Page) {
    this.page = page;
    this.nameInput = page.getByLabel(/^name$/i);
    this.emailInput = page.getByLabel(/email/i);
    // Exact match: the login form renders a "Show password" / "Hide password"
    // visibility-toggle button whose accessible name also contains "password",
    // so a loose /password/i would resolve to two elements (strict-mode
    // violation). The input's accessible name is exactly "Password".
    this.passwordInput = page.getByLabel("Password", { exact: true });
    // The email submit button reads "Sign in". When GitHub OAuth is enabled
    // the form *also* renders a "Continue with GitHub" button, so we match on
    // the submit button's exact "Sign in" text rather than /continue/ (which
    // would hit the GitHub button and kick off the OAuth redirect). The e2e
    // fixture sets dummy AUTH_GITHUB_* creds, so githubEnabled is true under
    // test. Scoped to the <form> so the "Sign in to Wrightful" heading can't
    // interfere.
    this.signInButton = page.locator("form").getByRole("button", {
      name: /^sign in$/i,
    });
    this.createAccountButton = page.getByRole("button", {
      name: /create account/i,
    });
    this.errorAlert = page.getByRole("alert");
    this.signUpHeading = page.getByRole("heading", {
      name: /create your wrightful account/i,
    });
  }

  async gotoSignIn(): Promise<void> {
    await this.page.goto("/login");
  }

  async gotoSignUp(): Promise<void> {
    await this.page.goto("/signup");
    await expect(this.signUpHeading).toBeVisible();
  }

  async signIn(email: string, password: string): Promise<void> {
    // Wait for hydration BEFORE filling. The inputs are React-controlled; if we
    // type before the island hydrates, hydration resets them to their empty
    // initial state and we silently submit blank credentials (which hangs).
    // The submit button stays `disabled` until the form's hydration effect
    // runs, so its enabled state is a reliable hydration gate.
    await expect(this.signInButton).toBeEnabled({ timeout: 15_000 });
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.signInButton.click();
  }

  async signUp(opts: {
    name: string;
    email: string;
    password: string;
  }): Promise<void> {
    // Wait for hydration before filling (see signIn): typing into the
    // controlled inputs pre-hydration lets React reset them to empty on
    // hydration, submitting a blank form. The disabled-until-hydrated submit
    // button is the gate.
    await expect(this.createAccountButton).toBeEnabled({ timeout: 15_000 });
    await this.nameInput.fill(opts.name);
    await this.emailInput.fill(opts.email);
    await this.passwordInput.fill(opts.password);
    await this.createAccountButton.click();
  }

  /** Wait for navigation away from /login or /signup. */
  async waitForLandedOff(prefix: "/login" | "/signup"): Promise<void> {
    // Generous timeout: email sign-in/up runs a scrypt password hash which is
    // markedly slow on the local miniflare dev server the e2e harness boots.
    await this.page.waitForURL((url) => !url.pathname.startsWith(prefix), {
      timeout: 30_000,
    });
  }
}
