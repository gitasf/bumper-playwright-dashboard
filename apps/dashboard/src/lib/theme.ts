/**
 * The single source of truth for the dashboard's theme contract.
 *
 * The no-FOUC guarantee depends on three facts agreeing in two places that run
 * at different times: the inline boot script in `@/lib/theme-init-script`
 * (runs synchronously in `<head>` before first paint) and the `ThemeToggle`
 * component (runs at click time after hydration). Before this module those
 * facts — the localStorage key, the `.dark` class name, and the dark-by-default
 * rule — were hand-encoded independently in each place; flipping the key in one
 * and not the other silently broke persistence with no type or test error.
 *
 * Both consumers now derive from the constants here. The boot script can't
 * `import` at runtime (it's a stringified inline script), so it interpolates
 * these same constants into its source at build time — see `theme-init-script`.
 */
export const THEME_STORAGE_KEY = "theme";
export const DARK_CLASS = "dark";
/** Wrightful defaults to dark to match the design direction. */
export const DEFAULT_DARK = true;

/** The stored value written for each theme. */
export const THEME_VALUE_DARK = "dark";
export const THEME_VALUE_LIGHT = "light";

/**
 * The dark-by-default rule, as a pure function of the raw localStorage value.
 * This is the exact decision the FOUC-killer script encodes; keeping it here
 * (and unit-testing it) means the boot script and the toggle can't disagree
 * about what "no saved preference" means.
 */
export function prefersDark(rawStored: string | null): boolean {
  return rawStored ? rawStored === THEME_VALUE_DARK : DEFAULT_DARK;
}

/** The string persisted to localStorage for a given theme. */
export function themeValue(isDark: boolean): string {
  return isDark ? THEME_VALUE_DARK : THEME_VALUE_LIGHT;
}

// --- client-only DOM helpers (safe to define on the server; never called there) ---

/** Whether `.dark` is currently applied to `<html>`. The toggle's source of truth. */
export function isDarkApplied(): boolean {
  return document.documentElement.classList.contains(DARK_CLASS);
}

/** Toggle the `.dark` class on `<html>`. */
export function applyTheme(isDark: boolean): void {
  document.documentElement.classList.toggle(DARK_CLASS, isDark);
}

/** Persist the chosen theme; swallows localStorage failures (private mode etc). */
export function persistTheme(isDark: boolean): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, themeValue(isDark));
  } catch {
    // localStorage unavailable — the class is still toggled by applyTheme.
  }
}
