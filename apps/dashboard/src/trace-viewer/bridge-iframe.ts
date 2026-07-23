"use client";

import { traceViewerScopeUrl } from "./origin";

/**
 * Where the SW bridge document lives (inside the service-worker scope owned
 * by `TRACE_VIEWER_SCOPE` — see `bridge.html` for why the dashboard page
 * itself must never be the SW-controlled client).
 */
export const BRIDGE_PATH = `${traceViewerScopeUrl()}bridge.html`;

/**
 * Create + mount the hidden bridge iframe. With a `traceUrl` the bridge loads
 * and parses that trace into the SW's cache; without one it only registers
 * the service worker (warm mode). The caller owns the returned node's
 * lifetime (removal).
 */
export function mountBridgeIframe(
  traceUrl: string | undefined,
  title: string,
): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  iframe.setAttribute("aria-hidden", "true");
  iframe.title = title;
  iframe.src = bridgeIframeSrc(traceUrl);
  document.body.appendChild(iframe);
  return iframe;
}

/** Build the bridge URL with an explicit postMessage host origin. */
export function bridgeIframeSrc(traceUrl: string | undefined): string {
  const params = new URLSearchParams();
  if (traceUrl) params.set("trace", traceUrl);
  const host =
    typeof window !== "undefined" ? window.location.origin : undefined;
  if (host) params.set("host", host);
  const query = params.toString();
  return query ? `${BRIDGE_PATH}?${query}` : BRIDGE_PATH;
}
