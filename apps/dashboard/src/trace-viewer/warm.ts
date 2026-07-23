"use client";

import { mountBridgeIframe } from "./bridge-iframe";
import { traceViewerBridgeOrigin } from "./origin";
import { isBridgeMessage } from "./use-trace-model";

/**
 * Pre-warm the trace viewer on intent (hover/focus of a Replay button).
 *
 * Two levels, both via hidden bridge iframes (see `bridge.html`):
 * - `warmTraceViewer()` — registers the service worker (warm mode), then
 *   removes its iframe once the bridge confirms registration (or a timeout
 *   fallback fires) — see `mountRegisterOnlyIframe`. Mostly matters on a
 *   user's very first replay; registration persists after the iframe is gone.
 * - `warmTraceViewer(traceUrl)` — full prefetch: the bridge loads + parses
 *   the trace into the SW's cache, so opening the modal is near-instant.
 *
 * Each prefetch iframe pins a fully parsed trace in the SW for as long as it
 * stays mounted — and the dashboard navigates client-side, so "until the page
 * unloads" can be a whole session. At most ONE prefetch iframe therefore
 * exists at a time: warming a different trace removes the previous iframe
 * (releasing its pinned trace) before mounting the new one. Failures are
 * silent (warming is best-effort — the modal's own bridge is authoritative).
 */
let registerWarmed = false;
let prefetch: { key: string; iframe: HTMLIFrameElement } | null = null;

/**
 * Ceiling for the register-only iframe: if the bridge's `warm` ack (sent
 * once `navigator.serviceWorker.register` resolves — see `bridge.html`)
 * never arrives, e.g. a broken SW or a protocol-skewed bridge document,
 * remove the iframe anyway so it can't leak for the rest of the session.
 */
const REGISTER_WARM_TIMEOUT_MS = 10_000;

/**
 * Mount the register-only bridge iframe and remove it once the bridge
 * confirms SW registration or the timeout fallback fires, whichever comes
 * first. `mountBridgeIframe` documents that the caller owns the returned
 * node's lifetime — this is that ownership for the register-only path (the
 * argful prefetch path's lifetime is owned by `prefetch`/`releaseWarmedTrace`
 * instead).
 */
function mountRegisterOnlyIframe(): void {
  const iframe = mountBridgeIframe(undefined, "Trace viewer warm-up");
  let settled = false;
  const cleanup = (): void => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timeout);
    window.removeEventListener("message", onMessage);
    iframe.remove();
  };
  const onMessage = (event: MessageEvent): void => {
    if (event.origin !== traceViewerBridgeOrigin(window.location.origin))
      return;
    if (event.source !== iframe.contentWindow) return;
    if (!isBridgeMessage(event.data) || event.data.method !== "warm") return;
    cleanup();
  };
  window.addEventListener("message", onMessage);
  const timeout = window.setTimeout(cleanup, REGISTER_WARM_TIMEOUT_MS);
}

/**
 * Prefetch dedupe identity: the signed download token in the query rotates
 * per page load / re-mint, but it's the same trace bytes — dedupe on the
 * artifact path, not the exact signed URL.
 */
function traceKey(traceUrl: string): string {
  try {
    const url = new URL(traceUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return traceUrl;
  }
}

export function warmTraceViewer(traceUrl?: string): void {
  if (typeof document === "undefined") return;
  try {
    if (!traceUrl) {
      if (registerWarmed) return;
      registerWarmed = true;
      mountRegisterOnlyIframe();
      return;
    }
    const key = traceKey(traceUrl);
    if (prefetch?.key === key) return;
    prefetch?.iframe.remove();
    prefetch = { key, iframe: mountBridgeIframe(traceUrl, "Trace prewarm") };
  } catch {
    // Best-effort only.
  }
}

/**
 * Release the current prefetch iframe (and the trace it pins in the SW). The
 * Replay modal calls this once it mounts its OWN authoritative bridge — the
 * prewarm has done its job and no longer needs to hold the trace open, so it
 * shouldn't linger for the rest of the client-side session.
 */
export function releaseWarmedTrace(): void {
  if (typeof document === "undefined") return;
  prefetch?.iframe.remove();
  prefetch = null;
}
