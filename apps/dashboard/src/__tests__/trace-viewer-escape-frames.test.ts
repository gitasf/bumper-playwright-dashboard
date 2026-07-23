import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { waitFor } from "@testing-library/react";
import { bindEscapeAcrossFrames } from "@/trace-viewer/components/escape-frames";

/**
 * `bindEscapeAcrossFrames` — the close-on-Escape net over a snapshot
 * iframe's same-origin frame tree. Happy-dom gives real (src-less,
 * about:blank) iframe windows plus working MutationObserver delivery, so the
 * bind/re-scan/cleanup lifecycle is exercised against actual frames rather
 * than mocks. The cross-origin arm is driven with a document getter that
 * throws, which is exactly how a cross-origin WindowProxy behaves.
 */

function pressEscape(win: Window): void {
  win.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
}

function mountFrame(doc: Document): HTMLIFrameElement {
  const frame = doc.createElement("iframe");
  doc.body.appendChild(frame);
  return frame;
}

/** Wait one macrotask (iframe window creation, MutationObserver delivery). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.innerHTML = "";
});

function bind(onEscape: () => void, win: Window = window): () => void {
  const cleanup = bindEscapeAcrossFrames(win, onEscape);
  cleanups.push(cleanup);
  return cleanup;
}

describe("bindEscapeAcrossFrames", () => {
  it("fires on Escape from the top window, exactly once per press", () => {
    const onEscape = vi.fn();
    bind(onEscape);

    pressEscape(window);
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys", () => {
    const onEscape = vi.fn();
    bind(onEscape);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("reaches Escape presses inside an existing iframe, and nested frames", async () => {
    const outer = mountFrame(document);
    await flush();
    const outerWin = outer.contentWindow!;
    const inner = mountFrame(outerWin.document);
    await flush();

    const onEscape = vi.fn();
    bind(onEscape);

    pressEscape(outerWin);
    expect(onEscape).toHaveBeenCalledTimes(1);

    pressEscape(inner.contentWindow!);
    expect(onEscape).toHaveBeenCalledTimes(2);
  });

  it("binds frames ADDED after the initial scan (MutationObserver re-scan)", async () => {
    const onEscape = vi.fn();
    bind(onEscape);

    const late = mountFrame(document);
    await flush();

    await waitFor(() => {
      pressEscape(late.contentWindow!);
      expect(onEscape).toHaveBeenCalled();
    });
  });

  it("does not stack duplicate listeners when the tree mutates", async () => {
    const onEscape = vi.fn();
    bind(onEscape);

    // Any subtree change re-runs scanDoc over the already-bound document.
    document.body.appendChild(document.createElement("div"));
    await flush();

    pressEscape(window);
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("tears everything down on cleanup, including frame listeners", async () => {
    const frame = mountFrame(document);
    await flush();

    const onEscape = vi.fn();
    const cleanup = bind(onEscape);
    cleanup();

    pressEscape(window);
    pressEscape(frame.contentWindow!);
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("skips an unreachable (cross-origin) window instead of throwing", () => {
    const onEscape = vi.fn();
    const crossOrigin = {
      get document(): Document {
        throw new DOMException("Blocked a frame", "SecurityError");
      },
    } as unknown as Window;

    expect(() => bind(onEscape, crossOrigin)).not.toThrow();
    expect(onEscape).not.toHaveBeenCalled();
  });
});
