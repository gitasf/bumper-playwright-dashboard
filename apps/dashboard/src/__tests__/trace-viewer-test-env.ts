import { vi } from "vite-plus/test";

/**
 * Shared happy-dom stub scaffold for the trace-viewer component suites.
 * Every suite that mounts a measured/scrollable trace-viewer pane hits the
 * same handful of happy-dom gaps:
 *
 *  - `ResizeObserver` ships as a polyfill that never actually fires (no real
 *    layout engine driving it), which would leave every measured pane at
 *    0×0 — stub it to invoke synchronously off a mocked bounding rect.
 *  - `Element.getBoundingClientRect` / `HTMLElement.clientWidth`/`clientHeight`
 *    otherwise report 0 for everything happy-dom lays out.
 *  - `URL.createObjectURL` / `revokeObjectURL` aren't implemented.
 *  - `Element.scrollIntoView`, `setPointerCapture`/`releasePointerCapture`,
 *    and `Element.getAnimations` may or may not exist depending on the
 *    happy-dom version — stub them only when missing, and restore by
 *    deleting the added polyfill (rather than clobbering a real
 *    implementation) when they do. `getAnimations` matters because the
 *    vendored Base UI ScrollArea polls it on its viewport on a timer; left
 *    missing, that poll throws as an unhandled rejection from a detached
 *    setTimeout well after the test that triggered it has finished.
 *
 * `installTraceViewerDomStubs()` installs whichever subset a suite needs and
 * returns a single restore function. Call it from `beforeEach`/`afterEach`
 * (per-test mocks that need a fresh `vi.spyOn` each run) or
 * `beforeAll`/`afterAll` (a suite that just wants the polyfill in place for
 * the whole file) — whichever matches the suite's existing semantics.
 */

export interface TraceViewerRect {
  width: number;
  height: number;
  left?: number;
  top?: number;
}

export interface TraceViewerClientSize {
  width: number;
  height: number;
}

export interface TraceViewerDomStubOptions {
  /**
   * Installs the ResizeObserver stub plus getBoundingClientRect/clientWidth/
   * clientHeight mocks (the ResizeObserverStub's contentRect is fed off the
   * same getBoundingClientRect mock, so these three always travel together).
   * `true` uses the 800×400 @ (0,0) default every current suite relies on;
   * pass `{ rect, clientSize }` to override.
   */
  layout?:
    | boolean
    | { rect?: TraceViewerRect; clientSize?: TraceViewerClientSize };
  /** Stubs URL.createObjectURL/revokeObjectURL. */
  objectUrl?: boolean;
  /** Polyfills Element.prototype.scrollIntoView when happy-dom lacks it. */
  scrollIntoView?: boolean;
  /** Polyfills set/releasePointerCapture when happy-dom lacks them. */
  pointerCapture?: boolean;
  /** Polyfills Element.prototype.getAnimations when happy-dom lacks it. */
  getAnimations?: boolean;
}

const DEFAULT_RECT: Required<TraceViewerRect> = {
  width: 800,
  height: 400,
  left: 0,
  top: 0,
};

const DEFAULT_CLIENT_SIZE: TraceViewerClientSize = { width: 800, height: 400 };

type StubFn = (...args: never[]) => unknown;

/** Stubs a prototype method/property that happy-dom may or may not implement:
 * `vi.spyOn` over an existing implementation (restored via `mockRestore`), or
 * a bare assignment when happy-dom doesn't ship it at all (restored by
 * deleting the polyfill, so a later happy-dom upgrade isn't shadowed). */
function stubPrototypeMethod(
  target: object,
  prop: string,
  impl: StubFn,
): () => void {
  const record = target as Record<string, unknown>;
  if (typeof record[prop] === "function") {
    const fnRecord = target as Record<string, StubFn>;
    const spy = vi.spyOn(fnRecord, prop).mockImplementation(impl);
    return () => spy.mockRestore();
  }
  record[prop] = impl;
  return () => {
    delete record[prop];
  };
}

export function installTraceViewerDomStubs(
  options: TraceViewerDomStubOptions = {},
): () => void {
  const restoreFns: Array<() => void> = [];

  if (options.layout) {
    const custom = typeof options.layout === "object" ? options.layout : {};
    const rect = { ...DEFAULT_RECT, ...custom.rect };
    const clientSize = { ...DEFAULT_CLIENT_SIZE, ...custom.clientSize };
    const mockedRect = {
      width: rect.width,
      height: rect.height,
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON() {
        return {};
      },
    } as DOMRect;

    const originalResizeObserver = globalThis.ResizeObserver;
    class ResizeObserverStub {
      #callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.#callback = callback;
      }
      observe(target: Element): void {
        this.#callback(
          [
            {
              target,
              contentRect: target.getBoundingClientRect(),
            } as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver =
      ResizeObserverStub as unknown as typeof ResizeObserver;
    restoreFns.push(() => {
      globalThis.ResizeObserver =
        originalResizeObserver as typeof ResizeObserver;
    });

    const rectSpy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue(mockedRect);
    restoreFns.push(() => rectSpy.mockRestore());

    const widthSpy = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(clientSize.width);
    restoreFns.push(() => widthSpy.mockRestore());

    const heightSpy = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(clientSize.height);
    restoreFns.push(() => heightSpy.mockRestore());
  }

  if (options.objectUrl) {
    const originalCreateObjectURL = URL.createObjectURL.bind(URL);
    const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = vi.fn(() => "blob:mock-url");
    URL.revokeObjectURL = vi.fn();
    restoreFns.push(() => {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    });
  }

  if (options.scrollIntoView) {
    restoreFns.push(
      stubPrototypeMethod(Element.prototype, "scrollIntoView", () => {}),
    );
  }

  if (options.pointerCapture) {
    restoreFns.push(
      stubPrototypeMethod(Element.prototype, "setPointerCapture", () => {}),
    );
    restoreFns.push(
      stubPrototypeMethod(Element.prototype, "releasePointerCapture", () => {}),
    );
  }

  if (options.getAnimations) {
    restoreFns.push(
      stubPrototypeMethod(Element.prototype, "getAnimations", () => []),
    );
  }

  return () => {
    for (const restore of restoreFns.reverse()) restore();
  };
}
