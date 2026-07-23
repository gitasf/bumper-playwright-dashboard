import { type Page, type Locator, expect } from "@playwright/test";

/**
 * The single canonical "React has hydrated" signal. `useHydrated` is a global
 * flag (one `useSyncExternalStore` snapshot), so every consumer in the tree
 * flips at the same commit — and `AppLayout` wraps every project/settings
 * route. Waiting on this one attribute therefore proves the whole page (shell
 * *and* its content) is interactive; there is no need for per-page markers.
 * Routes without `AppLayout` (e.g. auth pages) have no marker and no-op here.
 */
export async function waitForHydration(page: Page): Promise<void> {
  const appShell = page.locator("[data-app-hydrated]");
  if ((await appShell.count()) > 0) {
    await expect(appShell).toHaveAttribute("data-app-hydrated", "true", {
      timeout: 15_000,
    });
  }
}

/** Navigate and wait for the destination's visible readiness contract. */
export async function gotoAndExpect(
  page: Page,
  path: string,
  ready: Locator,
): Promise<void> {
  let navigationError: unknown;
  try {
    await page.goto(path, {
      timeout: 30_000,
      waitUntil: "domcontentloaded",
    });
  } catch (error) {
    if (!/ERR_ABORTED/i.test(String(error))) throw error;
    navigationError = error;
  }

  try {
    // Exact path+search equality: callers assert the URL they asked for landed
    // verbatim. This couples the helper to the server never rewriting the query
    // string (true today — loaders read params without canonicalizing them).
    await expect(page).toHaveURL(
      (url) => `${url.pathname}${url.search}` === path,
      { timeout: 15_000 },
    );
    await expect(ready).toBeVisible({ timeout: 15_000 });
    await waitForHydration(page);
  } catch (readinessError) {
    if (navigationError) throw navigationError;
    throw readinessError;
  }
}
