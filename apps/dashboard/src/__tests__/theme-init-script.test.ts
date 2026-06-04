import { describe, expect, it } from "vite-plus/test";
import { themeInitScript } from "@/lib/theme-init-script";

// `themeInitScript` is the FOUC-killer injected inline into every page's <head>
// (middleware/01.head.ts). It is the one inline-script source the dashboard
// controls, and the documented reason the CSP keeps `script-src 'unsafe-inline'`
// — which in turn is why CSP is NOT a backstop for the ansi XSS sink (see
// src/lib/theme-init-script.ts + src/__tests__/ansi.test.ts).
//
// These tests pin the contract so a refactor can't silently (a) turn it into an
// executable-but-broken script, (b) leak a `<` that would close the host
// <script> early, or (c) grow event-handler / external-load surface that would
// change what `'unsafe-inline'` is shouldering.
describe("themeInitScript (FOUC-killer / 'unsafe-inline' dependency)", () => {
  it("toggles `.dark` on <html> from the saved theme, defaulting to dark", () => {
    // The whole point: synchronously set the class before first paint.
    expect(themeInitScript).toContain('localStorage.getItem("theme")');
    expect(themeInitScript).toContain(
      'document.documentElement.classList.toggle("dark"',
    );
    // `t?t==="dark":true` — when nothing is saved, default to dark.
    expect(themeInitScript).toContain('t?t==="dark":true');
  });

  it("is wrapped in try/catch so a blocked localStorage can't break the page", () => {
    expect(themeInitScript).toContain("try{");
    expect(themeInitScript).toContain("catch(_)");
  });

  it("contains no `<` so it cannot close its host <script> tag early", () => {
    // Void serializes this verbatim into `<script>…</script>` with no escaping
    // of the body (head.mjs renderHeadToString). A stray `</script` or `<` would
    // break out of the script context — keep the body free of `<`.
    expect(themeInitScript).not.toContain("<");
  });

  it("adds no event-handler or external-load surface — purely DOM-class toggling", () => {
    // It must stay inline-only (no src=) and free of on*= handler strings, so
    // the inline-script policy `'unsafe-inline'` shoulders nothing beyond this
    // one tightly-scoped FOUC-killer.
    expect(themeInitScript).not.toMatch(/\bsrc\s*=/);
    expect(themeInitScript).not.toMatch(/\bon\w+\s*=/i);
    expect(themeInitScript).not.toMatch(/\beval\b|new Function/);
  });
});
