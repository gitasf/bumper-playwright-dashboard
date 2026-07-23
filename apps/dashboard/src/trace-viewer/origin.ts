import { env } from "void/env";

/**
 * Trace snapshots may be isolated on a cookieless origin. Same-origin
 * snapshots keep scripts disabled because uploaded trace bytes are untrusted.
 * See SELF-HOSTING.md for deployment requirements.
 */

/** The trace-viewer scope path, relative to whichever origin serves it. */
export const TRACE_VIEWER_SCOPE = "/trace-viewer/";

function normalizedHttpOrigin(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "";
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

function currentPageOrigin(): string {
  const location = (globalThis as { location?: { origin?: unknown } }).location;
  return normalizedHttpOrigin(location?.origin);
}

/** Configured trace-viewer origin, or an empty string for same-origin mode. */
export function traceViewerOrigin(): string {
  try {
    return normalizedHttpOrigin(env.VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN);
  } catch {
    // Config evaluation and isolated client tests may not have runtime
    // bindings. Missing config is same-origin mode, which is the safe default.
    return "";
  }
}

/** True when the trace viewer is served from a DIFFERENT (cookieless) origin. */
export function isSeparateTraceViewerOrigin(
  pageOrigin = currentPageOrigin(),
): boolean {
  const viewerOrigin = traceViewerOrigin();
  const normalizedPageOrigin = normalizedHttpOrigin(pageOrigin);
  return (
    viewerOrigin !== "" &&
    normalizedPageOrigin !== "" &&
    viewerOrigin !== normalizedPageOrigin
  );
}

/**
 * True when `pageOrigin` IS the configured separate (cookieless) viewer
 * origin. False whenever no separate origin is configured. The server-side
 * question ("which host is serving this request?") — the inverse perspective
 * of `isSeparateTraceViewerOrigin`, which asks from a dashboard page whether
 * the viewer lives elsewhere. The defensive-headers middleware keys the
 * script-less snapshot CSP on it: snapshot scripts are only ever safe on the
 * cookieless host itself, so every OTHER origin (the dashboard included,
 * configured or not) keeps the strict policy.
 */
export function isTraceViewerHost(pageOrigin: string): boolean {
  const viewerOrigin = traceViewerOrigin();
  return (
    viewerOrigin !== "" && normalizedHttpOrigin(pageOrigin) === viewerOrigin
  );
}

export function traceViewerScopeUrl(): string {
  return `${traceViewerOrigin()}${TRACE_VIEWER_SCOPE}`;
}

/** Origin used for bridge postMessage targets and sender validation. */
export function traceViewerBridgeOrigin(pageOrigin: string): string {
  const normalizedPageOrigin = normalizedHttpOrigin(pageOrigin);
  return isSeparateTraceViewerOrigin(normalizedPageOrigin)
    ? traceViewerOrigin()
    : normalizedPageOrigin;
}

/** Enable snapshot scripts only when the viewer is isolated from the session. */
export function snapshotSandbox(pageOrigin = currentPageOrigin()): string {
  return isSeparateTraceViewerOrigin(pageOrigin)
    ? "allow-same-origin allow-scripts"
    : "allow-same-origin";
}
