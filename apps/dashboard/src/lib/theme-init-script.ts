import {
  DARK_CLASS,
  DEFAULT_DARK,
  THEME_STORAGE_KEY,
  THEME_VALUE_DARK,
} from "@/lib/theme";

/**
 * The FOUC-killer theme-init script — and the one place that records why the
 * dashboard's CSP runs `script-src 'self' 'unsafe-inline'` instead of a
 * stricter nonce policy.
 *
 * ## What this is
 *
 * `themeInitScript` is the inline `<script>` body injected into every page's
 * `<head>` by `middleware/01.head.ts`. It reads the saved theme from
 * localStorage and toggles `.dark` on `<html>` synchronously, before first
 * paint, so the page never flashes the wrong theme. It must run inline (not as
 * an external `src=`) because any deferral would reintroduce the flash.
 *
 * ## Why the CSP keeps `script-src 'unsafe-inline'` (recorded decision)
 *
 * The pre-Void (rwsdk) stack ran a nonce-based CSP (`setCommonHeaders` with a
 * per-request CSP nonce — see docs/worklog/2026-05-02-rwsdk-best-practices-audit.md).
 * That nonce seam was lost in the Void migration, and CSP was later restored in
 * `void.json` as `script-src 'self' 'unsafe-inline'`. Restoring the *nonce* form
 * is **not** currently possible on Void: the framework itself emits executable
 * inline `<script>` blocks during SSR with no nonce hook —
 *
 *   - the deferred-prop resolution scripts streamed by Void's page protocol
 *     (`window.__resolveDeferred(...)` / `window.__rejectDeferred(...)`), and
 *   - this FOUC-killer, injected via `headDefaults.script[].innerHTML`.
 *
 * Void exposes no way to tag those inline scripts with a per-request nonce, so a
 * strict `script-src 'self' 'nonce-…'` would break hydration. `'unsafe-inline'`
 * is therefore intentionally load-bearing for `script-src`. (`style-src
 * 'unsafe-inline'` is separately load-bearing for Tailwind v4's runtime-injected
 * styles.)
 *
 * ## Consequence for XSS (the point worth recording)
 *
 * Because `script-src 'unsafe-inline'` is on, CSP does **not** contain
 * inline-script / event-handler injection at the dashboard's lone untrusted-text
 * → `dangerouslySetInnerHTML` sink (`ansiToHtml` in `src/lib/ansi.ts`, rendered
 * by `src/components/test-error-alert.tsx`). The layered story is single-layered
 * there: the ansi sanitiser is the SOLE XSS guarantee for attacker-controlled
 * Playwright error text — CSP is not a backstop for it. That contract is pinned
 * by `src/__tests__/ansi.test.ts`; do not weaken it on the assumption CSP will
 * catch a regression. It won't.
 *
 * If Void ever exposes a per-request script nonce, the deepening is: thread that
 * nonce through `themeInitScript`'s injection point and drop `'unsafe-inline'`
 * from `script-src` in `void.json` — at which point CSP becomes a real second
 * layer for the ansi sink and this comment can be revised.
 */
export const themeInitScript: string =
  `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});` +
  `var d=t?t===${JSON.stringify(THEME_VALUE_DARK)}:${JSON.stringify(DEFAULT_DARK)};` +
  `document.documentElement.classList.toggle(${JSON.stringify(DARK_CLASS)},d);` +
  `}catch(_){}`;
