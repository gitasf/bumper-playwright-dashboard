import { afterEach, describe, expect, it, vi } from "vite-plus/test";
vi.mock("void/env", () => ({
  env: { VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN: undefined },
}));
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  useBufferedObjectUrl,
  useObjectUrl,
} from "@/trace-viewer/use-object-url";
import { useTraceModel } from "@/trace-viewer/use-trace-model";
import { makeBridge } from "./trace-viewer-fixture";

/**
 * `useObjectUrl` (bridge blob → object URL) and `useTraceModel` (the hidden
 * bridge iframe + postMessage protocol) — the two trace-viewer hooks with no
 * existing coverage. `trace-viewer-model.test.ts` covers the pure adapter
 * functions; this file covers the stateful React hooks.
 *
 * Happy-dom turned out to fully support the postMessage contract this hook
 * relies on — `iframe.contentWindow` is populated once the iframe is attached,
 * and a `MessageEvent` dispatched with an explicit `source` satisfies the
 * hook's `event.source === iframe.contentWindow` check — so the message-driven
 * transitions (ready/error/progress/fetch round-trip) are exercised directly
 * rather than only the timeout/unmount fallbacks.
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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

/** Wait one macrotask so the iframe's `contentWindow` is populated. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Monkey-patches the iframe contentWindow's `postMessage` to capture the
 * `id` of each outgoing bridge fetch request (the hook mints one per
 * `fetchJson` call; a fetchResult reply must echo it back). No restore
 * needed — the patched contentWindow dies with the hook's iframe. */
function captureRequestId(iframe: HTMLIFrameElement): { id: number | null } {
  const captured: { id: number | null } = { id: null };
  const contentWindow = iframe.contentWindow!;
  const originalPostMessage = contentWindow.postMessage.bind(contentWindow);
  contentWindow.postMessage = ((data: unknown, ...rest: unknown[]) => {
    captured.id = (data as { id?: number }).id ?? null;
    return (originalPostMessage as (...a: unknown[]) => unknown)(data, ...rest);
  }) as typeof contentWindow.postMessage;
  return captured;
}

describe("useObjectUrl", () => {
  const originalCreateObjectURL = URL.createObjectURL.bind(URL);
  const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  let urlSeq = 0;
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  function stubObjectUrls(): void {
    urlSeq = 0;
    createObjectURL = vi.fn(() => `blob:test-${++urlSeq}`);
    revokeObjectURL = vi.fn();
    URL.createObjectURL =
      createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL =
      revokeObjectURL as unknown as typeof URL.revokeObjectURL;
  }

  afterEach(() => {
    cleanup();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it("resolves a matched sha1 path to an object URL", async () => {
    stubObjectUrls();
    const bridge = makeBridge({ "sha1/x": new Blob(["hi"]) });
    const { result, unmount } = renderHook(() =>
      useObjectUrl(bridge, "sha1/x?trace=t"),
    );

    await waitFor(() => expect(result.current.url).not.toBeNull());
    expect(result.current).toEqual({ url: "blob:test-1", error: false });
    expect(bridge.calls).toEqual(["sha1/x?trace=t"]);
    unmount();
  });

  it("reports an error for an unmatched path", async () => {
    stubObjectUrls();
    const bridge = makeBridge({});
    const { result, unmount } = renderHook(() =>
      useObjectUrl(bridge, "sha1/missing?trace=t"),
    );

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current).toEqual({ url: null, error: true });
    expect(createObjectURL).not.toHaveBeenCalled();
    unmount();
  });

  it("stays null and makes zero bridge calls when path is null", () => {
    stubObjectUrls();
    const bridge = makeBridge({ "sha1/x": new Blob(["hi"]) });
    const { result, unmount } = renderHook(() => useObjectUrl(bridge, null));

    expect(result.current).toEqual({ url: null, error: false });
    expect(bridge.calls).toHaveLength(0);
    unmount();
  });

  it("revokes the object URL on unmount", async () => {
    stubObjectUrls();
    const bridge = makeBridge({ "sha1/x": new Blob(["hi"]) });
    const { result, unmount } = renderHook(() =>
      useObjectUrl(bridge, "sha1/x?trace=t"),
    );

    await waitFor(() => expect(result.current.url).not.toBeNull());
    const url = result.current.url;
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith(url);
  });

  it("revokes the previous URL when the path changes", async () => {
    stubObjectUrls();
    const bridge = makeBridge({
      "sha1/x": new Blob(["hi"]),
      "sha1/y": new Blob(["yo"]),
    });
    const { result, rerender, unmount } = renderHook(
      ({ path }: { path: string | null }) => useObjectUrl(bridge, path),
      { initialProps: { path: "sha1/x?trace=t" as string | null } },
    );

    await waitFor(() => expect(result.current.url).not.toBeNull());
    const firstUrl = result.current.url;

    rerender({ path: "sha1/y?trace=t" });
    await waitFor(() => expect(result.current.url).not.toBe(firstUrl));

    expect(revokeObjectURL).toHaveBeenCalledWith(firstUrl);
    unmount();
  });

  describe("useBufferedObjectUrl", () => {
    it("keeps returning the previous URL while the new path resolves, then swaps and revokes the old one", async () => {
      stubObjectUrls();
      const bridge = makeBridge({
        "sha1/x": new Blob(["hi"]),
        "sha1/y": new Blob(["yo"]),
      });
      const { result, rerender, unmount } = renderHook(
        ({ path }: { path: string | null }) =>
          useBufferedObjectUrl(bridge, path),
        { initialProps: { path: "sha1/x?trace=t" as string | null } },
      );

      await waitFor(() => expect(result.current.url).not.toBeNull());
      const firstUrl = result.current.url;

      rerender({ path: "sha1/y?trace=t" });
      // The old URL is still displayed immediately after the path change —
      // never a blank frame while the new blob is in flight.
      expect(result.current).toEqual({ url: firstUrl, error: false });
      expect(revokeObjectURL).not.toHaveBeenCalled();

      await waitFor(() => expect(result.current.url).not.toBe(firstUrl));
      expect(result.current).toEqual({ url: "blob:test-2", error: false });
      expect(revokeObjectURL).toHaveBeenCalledWith(firstUrl);
      unmount();
    });

    it("revokes the displayed URL on unmount", async () => {
      stubObjectUrls();
      const bridge = makeBridge({ "sha1/x": new Blob(["hi"]) });
      const { result, unmount } = renderHook(() =>
        useBufferedObjectUrl(bridge, "sha1/x?trace=t"),
      );

      await waitFor(() => expect(result.current.url).not.toBeNull());
      const url = result.current.url;
      unmount();
      expect(revokeObjectURL).toHaveBeenCalledWith(url);
    });

    it("never leaks a blob fetched for a path that's since been abandoned", async () => {
      stubObjectUrls();
      const bridge = makeBridge({
        "sha1/x": new Blob(["hi"]),
        "sha1/y": new Blob(["yo"]),
        "sha1/z": new Blob(["zz"]),
      });
      const { result, rerender, unmount } = renderHook(
        ({ path }: { path: string | null }) =>
          useBufferedObjectUrl(bridge, path),
        { initialProps: { path: "sha1/x?trace=t" as string | null } },
      );
      await waitFor(() => expect(result.current.url).not.toBeNull());
      const firstUrl = result.current.url;

      // Switch through an intermediate path (y) and away again (z) before y's
      // fetch has a chance to resolve — y's blob must never surface as an
      // object URL (createObjectURL is only reached after the effect's own
      // `cancelled` guard, which trips as soon as we move to z).
      rerender({ path: "sha1/y?trace=t" });
      rerender({ path: "sha1/z?trace=t" });

      await waitFor(() => expect(result.current.url).not.toBe(firstUrl));
      expect(result.current).toEqual({ url: "blob:test-2", error: false });
      // Only two object URLs were ever minted: the first (x) and the one
      // actually displayed (z) — y's fetch was abandoned before resolving.
      expect(createObjectURL).toHaveBeenCalledTimes(2);
      expect(revokeObjectURL).toHaveBeenCalledWith(firstUrl);
      expect(revokeObjectURL).toHaveBeenCalledTimes(1);
      unmount();
    });
  });
});

describe("useTraceModel — mount + protocol", () => {
  const TRACE_URL = "https://dash.test/api/artifacts/a1/download?t=tok";

  afterEach(() => {
    cleanup();
  });

  it("starts in loading state with no progress", () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    expect(result.current.state).toEqual({ status: "loading", progress: null });
    unmount();
  });

  it("mounts a single hidden iframe whose src carries the encoded trace URL", () => {
    const { unmount } = renderHook(() => useTraceModel(TRACE_URL));

    const iframes = document.querySelectorAll("iframe");
    expect(iframes).toHaveLength(1);
    const iframe = iframes[0] as HTMLIFrameElement;
    expect(iframe.style.display).toBe("none");
    // Leads with the encoded trace param, then the explicit `host=` postMessage
    // handshake param (see `bridgeIframeSrc`).
    const src = new URL(iframe.src, document.baseURI);
    expect(src.pathname).toBe("/trace-viewer/bridge.html");
    expect(src.searchParams.get("trace")).toBe(TRACE_URL);
    expect(src.searchParams.get("host")).toBe(window.location.origin);
    expect(document.body.contains(iframe)).toBe(true);
    unmount();
  });

  it("transitions to ready on a model message", async () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    await flush();
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;

    act(() => {
      postMessageFrom(iframe, {
        source: "wrightful-trace-bridge",
        method: "model",
        params: { contextEntries: [] },
      });
    });

    await waitFor(() =>
      expect(result.current.state).toEqual({
        status: "ready",
        traceUrl: TRACE_URL,
        contextEntries: [],
        switching: null,
      }),
    );
    unmount();
  });

  it("transitions to error on an error message", async () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    await flush();
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;

    act(() => {
      postMessageFrom(iframe, {
        source: "wrightful-trace-bridge",
        method: "error",
        params: { error: "bad zip" },
      });
    });

    await waitFor(() =>
      expect(result.current.state).toEqual({
        status: "error",
        error: "bad zip",
      }),
    );
    unmount();
  });

  it("reflects a progress message while still loading", async () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    await flush();
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;

    act(() => {
      postMessageFrom(iframe, {
        source: "wrightful-trace-bridge",
        method: "progress",
        params: { done: 3, total: 10 },
      });
    });

    await waitFor(() =>
      expect(result.current.state).toEqual({
        status: "loading",
        progress: { done: 3, total: 10 },
      }),
    );
    unmount();
  });

  it("ignores messages from the wrong origin", async () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    await flush();
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            source: "wrightful-trace-bridge",
            method: "model",
            params: { contextEntries: [] },
          },
          origin: "https://evil.example",
          source: iframe.contentWindow as unknown as Window,
        }),
      );
    });

    // Give any (incorrect) state transition a tick to happen, then assert
    // the hook is still loading — the origin check must have dropped it.
    await flush();
    expect(result.current.state).toEqual({ status: "loading", progress: null });
    unmount();
  });

  it("ignores messages not tagged with the bridge source", async () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    await flush();
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;

    act(() => {
      postMessageFrom(iframe, {
        source: "some-other-sender",
        method: "model",
        params: { contextEntries: [] },
      });
    });

    await flush();
    expect(result.current.state).toEqual({ status: "loading", progress: null });
    unmount();
  });

  it("ignores bridge-tagged messages whose method payload is malformed", async () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    await flush();
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;

    act(() => {
      postMessageFrom(iframe, {
        source: "wrightful-trace-bridge",
        method: "model",
        params: { contextEntries: "not-an-array" },
      });
    });

    await flush();
    expect(result.current.state).toEqual({ status: "loading", progress: null });
    unmount();
  });

  it("resolves bridge.fetchJson via a fetchResult round-trip", async () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    await flush();
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;

    const captured = captureRequestId(iframe);

    const fetchPromise = result.current.bridge.fetchJson("sha1/x?trace=t");
    await flush();
    expect(captured.id).not.toBeNull();

    act(() => {
      postMessageFrom(iframe, {
        source: "wrightful-trace-bridge",
        method: "fetchResult",
        params: { id: captured.id, ok: true, status: 200, body: { hi: 1 } },
      });
    });

    await expect(fetchPromise).resolves.toEqual({ hi: 1 });
    unmount();
  });

  it("rejects bridge.fetchJson when the fetchResult reports a failure", async () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    await flush();
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;

    const captured = captureRequestId(iframe);

    const fetchPromise = result.current.bridge.fetchJson(
      "sha1/missing?trace=t",
    );
    await flush();

    act(() => {
      postMessageFrom(iframe, {
        source: "wrightful-trace-bridge",
        method: "fetchResult",
        params: { id: captured.id, ok: false, status: 404 },
      });
    });

    await expect(fetchPromise).rejects.toThrow("Trace fetch failed (404).");
    unmount();
  });

  it("resolves bridge.fetchBlob only from a Blob fetchResult body", async () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    await flush();
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    const captured = captureRequestId(iframe);

    const fetchPromise = result.current.bridge.fetchBlob("sha1/x?trace=t");
    await flush();
    expect(captured.id).not.toBeNull();

    act(() => {
      postMessageFrom(iframe, {
        source: "wrightful-trace-bridge",
        method: "fetchResult",
        params: {
          id: captured.id,
          ok: true,
          status: 200,
          body: new Blob(["hello"]),
        },
      });
    });

    await expect(fetchPromise.then((blob) => blob.text())).resolves.toBe(
      "hello",
    );
    unmount();
  });

  it("rejects bridge.fetchBlob when the bridge returns a non-Blob body", async () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    await flush();
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    const captured = captureRequestId(iframe);

    const fetchPromise = result.current.bridge.fetchBlob("sha1/x?trace=t");
    await flush();
    expect(captured.id).not.toBeNull();

    act(() => {
      postMessageFrom(iframe, {
        source: "wrightful-trace-bridge",
        method: "fetchResult",
        params: { id: captured.id, ok: true, status: 200, body: { hi: 1 } },
      });
    });

    await expect(fetchPromise).rejects.toThrow(
      "Trace bridge returned a non-Blob fetch body.",
    );
    unmount();
  });

  it("times out starting the bridge after 30s with no response", () => {
    vi.useFakeTimers();
    // try/finally so a failing expect can't leak fake timers into later tests.
    try {
      const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));

      act(() => {
        vi.advanceTimersByTime(30_000);
      });

      expect(result.current.state).toEqual({
        status: "error",
        error:
          "Timed out starting the trace viewer. Its service worker may be blocked in this browser.",
      });
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the trace-load deadline only after the service-worker bridge is ready", async () => {
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const iframe = document.querySelector("iframe") as HTMLIFrameElement;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(25_000);
      });
      act(() => {
        postMessageFrom(iframe, {
          source: "wrightful-trace-bridge",
          method: "ready",
          params: {},
        });
      });

      // The 30s startup deadline has passed, but the bridge's readiness ack
      // started a separate 60s trace-load budget.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(35_000);
      });
      expect(result.current.state.status).toBe("loading");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(25_000);
      });
      expect(result.current.state).toEqual({
        status: "error",
        error:
          "Timed out loading the trace after the trace viewer became ready.",
      });
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers the 60s load deadline on progress, but still fires on true silence", async () => {
    vi.useFakeTimers();
    // try/finally so a failing expect can't leak fake timers into later tests.
    try {
      const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));

      // Let the iframe's contentWindow populate — same macrotask the other
      // message-driven tests wait out via `flush()`, just via the fake clock.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const iframe = document.querySelector("iframe") as HTMLIFrameElement;

      act(() => {
        postMessageFrom(iframe, {
          source: "wrightful-trace-bridge",
          method: "ready",
          params: {},
        });
      });

      // 50s of silence — under the 60s load deadline, still loading.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50_000);
      });
      expect(result.current.state.status).toBe("loading");

      // A progress message resets the watchdog's clock.
      act(() => {
        postMessageFrom(iframe, {
          source: "wrightful-trace-bridge",
          method: "progress",
          params: { done: 1, total: 10 },
        });
      });

      // Another 50s (100s since ready, but only 50s since the last message) —
      // a total-time watchdog would've fired by now; a silence one hasn't.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50_000);
      });
      expect(result.current.state).toEqual({
        status: "loading",
        progress: { done: 1, total: 10 },
      });

      // 60s of true silence past the last progress message — now it fires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(result.current.state).toEqual({
        status: "error",
        error:
          "Timed out loading the trace after the trace viewer became ready.",
      });
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes the iframe on unmount", () => {
    const { unmount } = renderHook(() => useTraceModel(TRACE_URL));
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    unmount();
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("rejects a pending bridge fetch with 'unmounted' once the hook unmounts", async () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    await flush();

    const fetchPromise = result.current.bridge.fetchJson("sha1/x?trace=t");
    unmount();

    await expect(fetchPromise).rejects.toThrow("Trace bridge unmounted.");
  });

  it("rejects bridge.fetchJson immediately when the iframe was never mounted (post-unmount call)", async () => {
    const { result, unmount } = renderHook(() => useTraceModel(TRACE_URL));
    await flush();
    unmount();

    await expect(
      result.current.bridge.fetchJson("sha1/x?trace=t"),
    ).rejects.toThrow("Trace bridge is not mounted.");
  });
});

describe("useTraceModel — attempt switching (stale-while-loading)", () => {
  const TRACE_A = "https://dash.test/api/artifacts/a1/download?t=tok1";
  const TRACE_B = "https://dash.test/api/artifacts/a2/download?t=tok2";

  afterEach(() => {
    cleanup();
  });

  /** Render on TRACE_A and drive it to ready. */
  async function renderReady() {
    const rendered = renderHook(
      ({ url }: { url: string }) => useTraceModel(url),
      {
        initialProps: { url: TRACE_A },
      },
    );
    await flush();
    const iframeA = document.querySelector("iframe") as HTMLIFrameElement;
    act(() => {
      postMessageFrom(iframeA, {
        source: "wrightful-trace-bridge",
        method: "model",
        params: { contextEntries: [] },
      });
    });
    await waitFor(() =>
      expect(rendered.result.current.state).toMatchObject({ status: "ready" }),
    );
    return { ...rendered, iframeA };
  }

  /** The bridge iframe mounted after {@link renderReady}'s (the pending load). */
  function secondIframe(): HTMLIFrameElement {
    const iframes = document.querySelectorAll("iframe");
    expect(iframes).toHaveLength(2);
    return iframes[1] as HTMLIFrameElement;
  }

  it("keeps the ready model (flagged switching) while the next trace loads in a second iframe", async () => {
    const { result, rerender, iframeA, unmount } = await renderReady();

    rerender({ url: TRACE_B });
    await flush();

    expect(result.current.state).toEqual({
      status: "ready",
      traceUrl: TRACE_A,
      contextEntries: [],
      switching: { progress: null },
    });
    const iframeB = secondIframe();
    expect(document.body.contains(iframeA)).toBe(true);
    const src = new URL(iframeB.src, document.baseURI);
    expect(src.pathname).toBe("/trace-viewer/bridge.html");
    expect(src.searchParams.get("trace")).toBe(TRACE_B);
    expect(src.searchParams.get("host")).toBe(window.location.origin);
    unmount();
  });

  it("surfaces the pending load's progress under switching.progress", async () => {
    const { result, rerender, unmount } = await renderReady();

    rerender({ url: TRACE_B });
    await flush();

    act(() => {
      postMessageFrom(secondIframe(), {
        source: "wrightful-trace-bridge",
        method: "progress",
        params: { done: 4, total: 8 },
      });
    });

    await waitFor(() =>
      expect(result.current.state).toEqual({
        status: "ready",
        traceUrl: TRACE_A,
        contextEntries: [],
        switching: { progress: { done: 4, total: 8 } },
      }),
    );
    unmount();
  });

  it("swaps to the new model in place and retires the previous bridge iframe", async () => {
    const { result, rerender, iframeA, unmount } = await renderReady();

    rerender({ url: TRACE_B });
    await flush();
    const iframeB = secondIframe();

    act(() => {
      postMessageFrom(iframeB, {
        source: "wrightful-trace-bridge",
        method: "model",
        params: { contextEntries: [] },
      });
    });

    await waitFor(() =>
      expect(result.current.state).toEqual({
        status: "ready",
        traceUrl: TRACE_B,
        contextEntries: [],
        switching: null,
      }),
    );
    expect(document.body.contains(iframeA)).toBe(false);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    unmount();
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("drops to the error state when the new attempt fails to load", async () => {
    const { result, rerender, iframeA, unmount } = await renderReady();

    rerender({ url: TRACE_B });
    await flush();

    act(() => {
      postMessageFrom(secondIframe(), {
        source: "wrightful-trace-bridge",
        method: "error",
        params: { error: "bad zip" },
      });
    });

    await waitFor(() =>
      expect(result.current.state).toEqual({
        status: "error",
        error: "bad zip",
      }),
    );
    expect(document.body.contains(iframeA)).toBe(false);
    unmount();
  });

  it("switching back to the active trace cancels the pending load without reloading", async () => {
    const { result, rerender, iframeA, unmount } = await renderReady();

    rerender({ url: TRACE_B });
    await flush();
    const iframeB = secondIframe();

    rerender({ url: TRACE_A });
    await flush();

    expect(result.current.state).toEqual({
      status: "ready",
      traceUrl: TRACE_A,
      contextEntries: [],
      switching: null,
    });
    expect(document.body.contains(iframeB)).toBe(false);
    expect(document.body.contains(iframeA)).toBe(true);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    unmount();
  });

  it("still resolves bridge fetches through the PREVIOUS iframe mid-switch", async () => {
    const { result, rerender, iframeA, unmount } = await renderReady();

    rerender({ url: TRACE_B });
    await flush();

    // The fetch proxy must keep targeting the bridge that serves the visible
    // (previous) model until the swap.
    const captured = captureRequestId(iframeA);
    const fetchPromise = result.current.bridge.fetchJson("sha1/x?trace=t");
    await flush();
    expect(captured.id).not.toBeNull();

    act(() => {
      postMessageFrom(iframeA, {
        source: "wrightful-trace-bridge",
        method: "fetchResult",
        params: { id: captured.id, ok: true, status: 200, body: { hi: 1 } },
      });
    });

    await expect(fetchPromise).resolves.toEqual({ hi: 1 });
    unmount();
  });

  it("removes BOTH iframes when unmounted mid-switch", async () => {
    const { rerender, unmount } = await renderReady();

    rerender({ url: TRACE_B });
    await flush();
    expect(document.querySelectorAll("iframe")).toHaveLength(2);

    unmount();
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });
});
