"use client";

import { snapshotDom } from "./snapshot-dom";

/**
 * Exact contents of the guard `<style>` Playwright prepends to every rendered
 * DOM snapshot. Kept as a literal (not a pattern) so a Playwright upgrade that
 * changes it fails the drift canary in `trace-viewer-vendor.test.ts` instead of
 * silently regressing replay to a blank pane.
 */
export const SNAPSHOT_VISIBILITY_GUARD_CSS =
  "*,*::before,*::after { visibility: hidden }";

/** Named, not inline, so a repeated `load` registers one listener rather than N. */
function suppressNavigation(event: Event): void {
  event.preventDefault();
}

/**
 * Stand in for the inline bootstrap a script-less snapshot never gets to run.
 *
 * Playwright's service worker opens every rendered snapshot with the guard
 * `<style>` above, followed by a bootstrap script that lifts it once the
 * document is ready — so the raw serialized DOM never flashes. Same-origin
 * snapshot iframes are sandboxed without `allow-scripts` (see
 * `snapshotSandbox`), so that script is blocked, the guard stays up and the
 * pane renders blank white rather than the static DOM the isolation trade-off
 * is documented to cost.
 *
 * Two fixups, and only two:
 *
 * 1. Suppress navigation. The serializer rewrites `src` but leaves `href`
 *    alone, so a snapshot's links still point at their original live URLs —
 *    unreachable while `visibility: hidden` makes them un-hit-testable, live
 *    the moment the guard lifts. One capturing document listener covers a
 *    pointer click and Enter on a focused link alike. Without it, a click
 *    replaces the replay with a real page load in a frame React keys by URL
 *    and so never remounts.
 * 2. Lift the guard, matching only the first `<style>` and only on exact text —
 *    the same "it is `styleSheets[0]`" assumption Playwright's bootstrap makes.
 *
 * Everything else the bootstrap would have restored stays unrestored; that is
 * the documented fidelity cost of running same-origin (see SELF-HOSTING.md).
 * `inert` on the frame would neutralise clicks too, but it also blocks
 * scrolling (measured), and scrolling is the only way left to see below the
 * fold once scroll restoration is gone.
 *
 * Never throws: callers run this from an `onLoad` handler with its own
 * bookkeeping to finish.
 */
export function prepareScriptlessSnapshot(win: Window): void {
  const dom = snapshotDom(win);
  if (!dom) return;

  dom.listen(dom.document, "click", suppressNavigation, true);

  const guard = dom.query("style");
  if (guard?.textContent !== SNAPSHOT_VISIBILITY_GUARD_CSS) return;
  guard.remove();
}
