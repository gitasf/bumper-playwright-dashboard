import { describe, expect, it, vi } from "vite-plus/test";
vi.mock("void/env", () => ({
  env: { VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN: undefined },
}));
import { warmTraceViewer } from "@/trace-viewer/warm";

/**
 * `warmTraceViewer` keeps at most ONE full-prefetch iframe alive (each pins a
 * fully parsed trace in the SW), replacing it when a different artifact is
 * warmed, and dedupes on the artifact path — not the exact signed URL, whose
 * token rotates per page load. State is module-level with no reset hook, so
 * each prefetch test below uses its own unique artifact path.
 *
 * The bare (no-arg) register-only call latches a module-level flag
 * (`registerWarmed`) after its first invocation, so it can only be exercised
 * ONCE against the shared top-level import — every test that needs a FRESH
 * bare-mode iframe (to see it get removed on the bridge's `warm` ack, or via
 * the timeout fallback) uses `vi.resetModules()` + a dynamic re-import to get
 * its own isolated module instance instead, rather than fighting the latch or
 * depending on test execution order.
 */

function postMessageFrom(
  iframe: HTMLIFrameElement,
  data: Record<string, unknown>,
): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data,
      origin: window.location.origin,
      source: iframe.contentWindow as unknown as Window,
    }),
  );
}

/** Wait one macrotask so an appended iframe's `contentWindow` is populated. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// The bridge src always carries an explicit `host=<parent-origin>` param now
// (the cross-origin postMessage handshake — see `bridgeIframeSrc`), so a
// register-only (warm-mode) iframe is "bridge.html with a host but NO trace",
// and a prefetch iframe additionally carries `trace=`.
function registerOnlyIframes(): HTMLIFrameElement[] {
  return Array.from(
    document.querySelectorAll<HTMLIFrameElement>("iframe"),
  ).filter((iframe) => {
    const url = new URL(iframe.src, document.baseURI);
    return (
      url.pathname === "/trace-viewer/bridge.html" &&
      !url.searchParams.has("trace")
    );
  });
}

function prefetchIframes(): HTMLIFrameElement[] {
  return Array.from(
    document.querySelectorAll<HTMLIFrameElement>("iframe"),
  ).filter((iframe) => {
    const url = new URL(iframe.src, document.baseURI);
    return (
      url.pathname === "/trace-viewer/bridge.html" &&
      url.searchParams.has("trace")
    );
  });
}

async function freshWarm(): Promise<(traceUrl?: string) => void> {
  vi.resetModules();
  const mod = await import("@/trace-viewer/warm");
  return mod.warmTraceViewer;
}

describe("warmTraceViewer", () => {
  it("mounts exactly one iframe for the bare warm-mode call, and repeats before any ack are no-ops", () => {
    const before = registerOnlyIframes().length;

    warmTraceViewer();
    warmTraceViewer();
    warmTraceViewer();

    const after = registerOnlyIframes();
    expect(after).toHaveLength(before + 1);
    const iframe = after[after.length - 1] as HTMLIFrameElement;
    expect(iframe.style.display).toBe("none");
    expect(iframe.getAttribute("aria-hidden")).toBe("true");

    // Send the ack so this iframe's real (non-fake-timer) fallback timeout
    // doesn't stay armed for the rest of the suite — the ack/timeout removal
    // behavior itself is covered in isolation below via `freshWarm()`.
    postMessageFrom(iframe, {
      source: "wrightful-trace-bridge",
      method: "warm",
      params: {},
    });
  });

  it("mounts one iframe carrying the encoded trace param for a full prefetch", () => {
    const traceUrl = "https://dash.test/api/artifacts/warm-1/download?t=tok";
    // The src leads with the encoded trace param and also carries the explicit
    // `host=<parent-origin>` postMessage-handshake param appended after it.
    warmTraceViewer(traceUrl);

    const iframes = prefetchIframes().filter((iframe) => {
      const url = new URL(iframe.src, document.baseURI);
      return url.searchParams.get("trace") === traceUrl;
    });
    expect(iframes).toHaveLength(1);
    const src = new URL(iframes[0]!.src, document.baseURI);
    expect(src.pathname).toBe("/trace-viewer/bridge.html");
    expect(src.searchParams.get("host")).toBe(window.location.origin);
  });

  it("dedupes repeat warms of the same artifact even when the signed token rotates", () => {
    const tokenA = "https://dash.test/api/artifacts/warm-2/download?t=tok-a";
    const tokenB = "https://dash.test/api/artifacts/warm-2/download?t=tok-b";

    warmTraceViewer(tokenA);
    warmTraceViewer(tokenA);
    warmTraceViewer(tokenB);

    const matching = prefetchIframes().filter((iframe) =>
      iframe.src.includes(encodeURIComponent("/artifacts/warm-2/")),
    );
    expect(matching).toHaveLength(1);
    // The first mint won; the rotated token did not remount.
    expect(matching[0]?.src).toContain(encodeURIComponent(tokenA));
  });

  it("replaces the previous prefetch iframe when a DIFFERENT trace is warmed", () => {
    const urlA = "https://dash.test/api/artifacts/warm-3a/download?t=tok";
    const urlB = "https://dash.test/api/artifacts/warm-3b/download?t=tok";

    warmTraceViewer(urlA);
    const mounted = prefetchIframes().find((iframe) =>
      iframe.src.includes(encodeURIComponent(urlA)),
    );
    expect(mounted).toBeDefined();

    warmTraceViewer(urlB);
    // The old iframe is gone (its pinned trace released); only B remains.
    expect(mounted?.isConnected).toBe(false);
    const remaining = prefetchIframes();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.src).toContain(encodeURIComponent(urlB));
  });

  it("removes the register-only iframe once the bridge's warm ack arrives, ignoring mismatched messages first", async () => {
    // A prior test's un-acked register-only iframe (test 1 above never sends
    // an ack) can already be sitting in the DOM — grab the LAST match, the
    // one this test's own `freshWarm()` instance just mounted.
    const before = registerOnlyIframes().length;
    const warm = await freshWarm();
    warm();

    const after = registerOnlyIframes();
    expect(after).toHaveLength(before + 1);
    const iframe = after[after.length - 1];
    if (!iframe) throw new Error("register-only iframe did not mount");

    // Let both iframes' `contentWindow` populate before comparing identities
    // (unpopulated `contentWindow` is `null` on both, which would otherwise
    // make the "wrong source" case below a false negative).
    const decoy = document.createElement("iframe");
    document.body.appendChild(decoy);
    await flush();

    // Wrong origin — ignored.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "wrightful-trace-bridge", method: "warm", params: {} },
        origin: "https://evil.example",
        source: iframe.contentWindow as unknown as Window,
      }),
    );
    expect(iframe.isConnected).toBe(true);

    // Wrong source window — ignored.
    postMessageFrom(decoy, {
      source: "wrightful-trace-bridge",
      method: "warm",
      params: {},
    });
    expect(iframe.isConnected).toBe(true);
    decoy.remove();

    // Right origin/source, but not a bridge envelope — ignored.
    postMessageFrom(iframe, { unrelated: true });
    expect(iframe.isConnected).toBe(true);

    // Right envelope, wrong method — ignored.
    postMessageFrom(iframe, {
      source: "wrightful-trace-bridge",
      method: "progress",
      params: { done: 1, total: 2 },
    });
    expect(iframe.isConnected).toBe(true);

    // The real ack — removed.
    postMessageFrom(iframe, {
      source: "wrightful-trace-bridge",
      method: "warm",
      params: {},
    });
    expect(iframe.isConnected).toBe(false);

    // A late, stray second ack is a safe no-op (no double-removal error).
    postMessageFrom(iframe, {
      source: "wrightful-trace-bridge",
      method: "warm",
      params: {},
    });
  });

  it("falls back to removing the register-only iframe on a timeout if no warm ack ever arrives", async () => {
    vi.useFakeTimers();
    // try/finally so a failing expect can't leak fake timers into later tests.
    try {
      const before = registerOnlyIframes().length;
      const warm = await freshWarm();
      warm();

      const after = registerOnlyIframes();
      expect(after).toHaveLength(before + 1);
      const iframe = after[after.length - 1];
      if (!iframe) throw new Error("register-only iframe did not mount");

      vi.advanceTimersByTime(9_999);
      expect(iframe.isConnected).toBe(true);

      vi.advanceTimersByTime(1);
      expect(iframe.isConnected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
