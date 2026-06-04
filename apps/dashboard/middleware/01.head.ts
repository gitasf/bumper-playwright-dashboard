import { defineMiddleware } from "void";
import { themeInitScript } from "@/lib/theme-init-script";

/**
 * Sets `<head>` defaults that need to run before first paint on every page.
 *
 * The inline script is the FOUC-killer (`themeInitScript`): it reads the user's
 * saved theme from localStorage and toggles `.dark` on `<html>` synchronously,
 * before the body paints. Tailwind v4's `@custom-variant dark (&:is(.dark *))`
 * then keys off that class for every component in the tree. That module also
 * records why this inline script forces the CSP to keep `script-src
 * 'unsafe-inline'`, and what that means for the ansi XSS sink.
 *
 * Default is dark to match the Wrightful design direction. `script`,
 * `htmlAttrs`, and `bodyAttrs` from `headDefaults` are SSR-only per the void
 * head-management docs — they aren't re-applied on client-side navigation,
 * which is fine because the class lives on `<html>` and persists across
 * SPA transitions.
 */
export default defineMiddleware(async (c, next) => {
  c.set("headDefaults", {
    // Default document title — fixes axe `document-title` (serious). Pages can
    // override via a `head()` export (page > middleware precedence).
    title: "Wrightful",
    // `lang` on <html> — fixes axe `html-has-lang` (serious). Like `class`, it
    // persists across SPA transitions even though htmlAttrs is SSR-only.
    htmlAttrs: { class: "dark", lang: "en" },
    script: [{ innerHTML: themeInitScript }],
  });
  await next();
});
