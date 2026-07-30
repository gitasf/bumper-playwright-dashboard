import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SplitPane } from "@/trace-viewer/components/split-pane";
import { installTraceViewerDomStubs } from "./trace-viewer-test-env";

/**
 * The workbench's hand-rolled two-pane splitter: fraction-driven flex-basis,
 * pointer-capture drag with min/max clamping, and lostpointercapture as the
 * single end-of-drag hook. The layout stub pins the container rect at
 * 800×400 @ (0,0), so pointer coordinates map 1:1 onto fractions.
 */

let restoreDomStubs: () => void;

beforeEach(() => {
  restoreDomStubs = installTraceViewerDomStubs({
    layout: true,
    pointerCapture: true,
  });
});

afterEach(() => {
  cleanup();
  restoreDomStubs();
});

function renderPane(over?: {
  direction?: "horizontal" | "vertical";
  min?: number;
  max?: number;
}): {
  firstPane: HTMLElement;
  separator: HTMLElement;
} {
  const { container, getByRole } = render(
    <SplitPane
      direction={over?.direction ?? "horizontal"}
      initial={0.3}
      separatorLabel="Resize fixture panes"
      min={over?.min}
      max={over?.max}
    >
      <div>first pane</div>
      <div>second pane</div>
    </SplitPane>,
  );
  const root = container.firstChild as HTMLElement;
  return {
    firstPane: root.children[0] as HTMLElement,
    separator: getByRole("separator", { name: "Resize fixture panes" }),
  };
}

describe("SplitPane", () => {
  it("sizes the first pane by the initial fraction and orients the separator", () => {
    const { firstPane, separator } = renderPane();
    expect(firstPane.style.flexBasis).toBe("30%");
    // A divider between horizontal panes is itself a VERTICAL line.
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
    expect(separator.getAttribute("aria-label")).toBe("Resize fixture panes");
    expect(separator.tabIndex).toBe(0);
    expect(separator.getAttribute("aria-valuenow")).toBe("30");
  });

  it("supports keyboard resizing and min/max jumps", () => {
    const { firstPane, separator } = renderPane({ min: 0.2, max: 0.7 });

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(firstPane.style.flexBasis).toBe("32%");
    expect(separator.getAttribute("aria-valuenow")).toBe("32");

    fireEvent.keyDown(separator, { key: "End" });
    expect(firstPane.style.flexBasis).toBe("70%");
    fireEvent.keyDown(separator, { key: "Home" });
    expect(firstPane.style.flexBasis).toBe("20%");
  });

  it("drags horizontally to the pointer's fraction of the container width", () => {
    const { firstPane, separator } = renderPane();

    fireEvent.pointerDown(separator, { pointerId: 1 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 480 });

    expect(firstPane.style.flexBasis).toBe("60%");
  });

  it("drags vertically against the container height", () => {
    const { firstPane, separator } = renderPane({ direction: "vertical" });
    expect(separator.getAttribute("aria-orientation")).toBe("horizontal");

    fireEvent.pointerDown(separator, { pointerId: 1 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientY: 100 });

    expect(firstPane.style.flexBasis).toBe("25%");
  });

  it("clamps the drag to min and max", () => {
    const { firstPane, separator } = renderPane({ min: 0.2, max: 0.7 });

    fireEvent.pointerDown(separator, { pointerId: 1 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 40 });
    expect(firstPane.style.flexBasis).toBe("20%");

    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 780 });
    expect(firstPane.style.flexBasis).toBe("70%");
  });

  it("ignores pointer moves that aren't part of a drag", () => {
    const { firstPane, separator } = renderPane();

    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 480 });

    expect(firstPane.style.flexBasis).toBe("30%");
  });

  it("stops tracking once pointer capture is lost (drag end)", () => {
    const { firstPane, separator } = renderPane();

    fireEvent.pointerDown(separator, { pointerId: 1 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 480 });
    fireEvent.lostPointerCapture(separator, { pointerId: 1 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 200 });

    expect(firstPane.style.flexBasis).toBe("60%");
  });
});
