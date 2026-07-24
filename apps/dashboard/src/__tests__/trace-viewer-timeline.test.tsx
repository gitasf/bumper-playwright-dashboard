import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { useMemo, useState } from "react";
import { PlaybackControls } from "@/trace-viewer/components/playback-controls";
import { Timeline } from "@/trace-viewer/components/timeline";
import { usePlayback } from "@/trace-viewer/components/use-playback";
import {
  actionIntersectsRange,
  sha1Path,
  type TraceTimeRange,
} from "@/trace-viewer/model";
import type { TraceBridge } from "@/trace-viewer/use-trace-model";
import type { TraceModel } from "@/trace-viewer/vendor/model-util";
import { makeBridge, makeModel } from "./trace-viewer-fixture";
import { installTraceViewerDomStubs } from "./trace-viewer-test-env";

/**
 * Component tests for the filmstrip + click-to-seek timeline strip: one
 * action bar per positive-duration action (fail/ring styling), bridge-backed
 * filmstrip thumbnails, click-to-seek resolving to the action active at the
 * clicked time, the zero-duration no-op render, the playback toolbar
 * (prev/play–pause/stop/next/speed with a stubbed requestAnimationFrame
 * clock), the drag range-selection (click seeks, drag selects a window whose
 * playback pauses at the window end), and the boundary-aware hover-preview
 * flip — against the shared synthetic fixture (`trace-viewer-fixture.ts`).
 *
 * The playback controller (`usePlayback`) is owned by the workbench and shared
 * between the timeline strip (which draws the moving Playhead) and the snapshot
 * pane's nav (which renders the prev/play/stop/next/speed cluster). `Harness`
 * reproduces that wiring so a single render exercises both consumers: the
 * strip's seek handlers + Playhead and the control buttons off one controller.
 */
function Harness({
  model,
  bridge,
  selectedCallId,
  onSelect,
  onSelectionChange,
  controls = true,
}: {
  model: TraceModel;
  bridge: TraceBridge;
  selectedCallId: string | undefined;
  onSelect: (callId: string) => void;
  /** Observation hook for the drag range-selection tests. */
  onSelectionChange?: (range: TraceTimeRange | null) => void;
  /** Off for the zero-duration case, which asserts a null render. */
  controls?: boolean;
}): React.ReactElement {
  // Mirrors the workbench: the drag-selected window scopes the playable set
  // (playback/stepping), seeks keep the unscoped set, and playback's window
  // follows the selection (or the whole trace).
  const [selection, setSelection] = useState<TraceTimeRange | null>(null);
  const allPlayableActions = useMemo(() => model.filteredActions([]), [model]);
  const playableActions = useMemo(
    () =>
      selection
        ? allPlayableActions.filter((a) => actionIntersectsRange(a, selection))
        : allPlayableActions,
    [allPlayableActions, selection],
  );
  const selectedAction = useMemo(
    () => model.actions.find((a) => a.callId === selectedCallId),
    [model, selectedCallId],
  );
  const playback = usePlayback({
    model,
    windowStartTime: selection?.start ?? model.startTime,
    windowEndTime: selection?.end ?? model.endTime,
    playableActions,
    selectedAction,
    onSelect,
  });
  return (
    <>
      {controls ? <PlaybackControls playback={playback} /> : null}
      <Timeline
        model={model}
        bridge={bridge}
        selectedAction={selectedAction}
        onSelect={onSelect}
        playback={playback}
        seekActions={allPlayableActions}
        selection={selection}
        onSelectionChange={(range) => {
          setSelection(range);
          onSelectionChange?.(range);
        }}
      />
    </>
  );
}

let restoreDomStubs: () => void;

// Controllable requestAnimationFrame: pending callbacks are keyed by id so
// the Timeline's cancelAnimationFrame cleanup genuinely cancels, and each
// `flushFrame(ts)` delivers exactly one "frame" with an explicit timestamp.
let originalRaf: typeof requestAnimationFrame;
let originalCaf: typeof cancelAnimationFrame;
let rafCallbacks: Map<number, FrameRequestCallback>;
let nextRafId = 1;

function flushFrame(timestamp: number): void {
  const callbacks = [...rafCallbacks.values()];
  rafCallbacks.clear();
  act(() => {
    for (const callback of callbacks) callback(timestamp);
  });
}

beforeEach(() => {
  // left:0/width:800 (the shared stub's default) is load-bearing for the
  // click-to-seek test's fraction math (clientX=400 -> fraction 0.5), not
  // just a sizing nicety. Timeline reads `entries[0].contentRect.width`,
  // unlike snapshot-pane's stage (which reads clientWidth/Height directly) —
  // the shared ResizeObserver stub feeds both shapes off the same rect mock.
  restoreDomStubs = installTraceViewerDomStubs({
    layout: true,
    objectUrl: true,
    pointerCapture: true,
  });

  originalRaf = globalThis.requestAnimationFrame;
  originalCaf = globalThis.cancelAnimationFrame;
  rafCallbacks = new Map();
  globalThis.requestAnimationFrame = (
    callback: FrameRequestCallback,
  ): number => {
    const id = nextRafId++;
    rafCallbacks.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id: number): void => {
    rafCallbacks.delete(id);
  };
});

afterEach(() => {
  // cleanup() unmounts while the rAF stubs are still installed, so a playing
  // Timeline's effect cleanup cancels through the stub, not the real API.
  cleanup();
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCaf;
  restoreDomStubs();
});

describe("Timeline", () => {
  it("renders one action bar per positive-duration action, flags the failing one, and rings the selected one", () => {
    const model = makeModel();
    // call@4 is the only action with an error — pick a DIFFERENT action as
    // selected so the fail-red and selected-ring styling land on separate
    // bars (selection styling takes precedence over the fail color).
    const { container } = render(
      <Harness
        model={model}
        bridge={makeBridge()}
        selectedCallId="call@1"
        onSelect={vi.fn()}
      />,
    );
    const bars = [
      ...container.querySelectorAll('[data-testid="timeline-bar"]'),
    ];
    // call@1 (400ms), call@2 (600ms), call@3 (10ms), call@4 (1000ms) — all
    // positive-duration, so all four actions get a bar.
    expect(bars).toHaveLength(4);
    expect(bars.some((bar) => bar.getAttribute("data-status") === "fail")).toBe(
      true,
    );
    expect(
      bars.some((bar) => bar.getAttribute("data-selected") === "true"),
    ).toBe(true);
  });

  it("renders filmstrip thumbnails fetched through the bridge", async () => {
    const model = makeModel();
    const bridge = makeBridge({
      "sha1/page@1-100.jpeg": new Blob(["a"]),
      "sha1/page@1-200.jpeg": new Blob(["b"]),
      "sha1/page@1-300.jpeg": new Blob(["c"]),
    });
    const { container } = render(
      <Harness
        model={model}
        bridge={bridge}
        selectedCallId={undefined}
        onSelect={vi.fn()}
      />,
    );
    // Thumbnails are decorative (`alt=""`), which maps to the "presentation"
    // ARIA role — getByRole("img") would never match them — so assert via a
    // plain DOM query instead, polled until the bridge blob fetches resolve.
    await waitFor(() => {
      expect(container.querySelectorAll("img").length).toBeGreaterThan(0);
    });
  });

  it("seeks to the action active at the clicked time on pointerdown", () => {
    const model = makeModel();
    const onSelect = vi.fn();
    const { container } = render(
      <Harness
        model={model}
        bridge={makeBridge()}
        selectedCallId={undefined}
        onSelect={onSelect}
      />,
    );
    const strip = container.querySelector('[data-testid="timeline-strip"]');
    expect(strip).toBeTruthy();
    // rect is {left:0, width:800}; clientX=400 -> fraction 0.5 -> t = 1000 +
    // 0.5*4000 = 3000, whose active action (latest startTime <= 3000) is
    // call@4 (startTime 3000).
    fireEvent.pointerDown(strip!, { clientX: 400, pointerId: 1 });
    expect(onSelect).toHaveBeenCalledWith("call@4");
  });

  it("keeps filmstrip thumbnails visible across an attempt swap while the new frames load", async () => {
    // A deferred bridge: fetchBlob never resolves on its own — the test
    // resolves individual paths explicitly, so it can inspect the DOM WHILE
    // a fetch is still in flight (the moment the old flash bug was visible).
    const resolvers = new Map<string, (blob: Blob) => void>();
    const bridge: TraceBridge = {
      ...makeBridge(),
      fetchJson: () => Promise.reject(new Error("unused in this test")),
      fetchBlob: (path: string) =>
        new Promise<Blob>((resolve) => {
          resolvers.set(path, resolve);
        }),
    };

    const modelA = makeModel();
    const { container, rerender } = render(
      <Harness
        model={modelA}
        bridge={bridge}
        selectedCallId={undefined}
        onSelect={vi.fn()}
      />,
    );

    await act(async () => {
      for (const frame of modelA.pages[0]!.screencastFrames) {
        resolvers.get(sha1Path(modelA.traceUri, frame.sha1))?.(new Blob(["a"]));
      }
      await Promise.resolve();
    });
    const initialCount = container.querySelectorAll("img").length;
    expect(initialCount).toBeGreaterThan(0);

    // Attempt swap: same slot count, all-new sha1s, whose blobs are left
    // unresolved — mirrors the workbench swapping the whole trace model in
    // place (`trace-viewer.tsx`) while the new attempt's frames are still
    // in flight through the bridge.
    const modelB = makeModel({
      pages: [
        {
          pageId: "page@1",
          screencastFrames: modelA.pages[0]!.screencastFrames.map((f) => ({
            ...f,
            sha1: `swapped-${f.sha1}`,
          })),
        },
      ],
    });
    rerender(
      <Harness
        model={modelB}
        bridge={bridge}
        selectedCallId={undefined}
        onSelect={vi.fn()}
      />,
    );

    // The strip must still show the outgoing attempt's thumbnails — not
    // blank boxes — until the new blobs resolve.
    expect(container.querySelectorAll("img").length).toBe(initialCount);
  });

  it("renders nothing for a zero-duration trace", () => {
    const model = makeModel({
      startTime: 1000,
      endTime: 1000,
      actions: [],
      pages: [],
      resources: [],
      events: [],
    });
    const { container } = render(
      <Harness
        model={model}
        bridge={makeBridge()}
        selectedCallId={undefined}
        onSelect={vi.fn()}
        controls={false}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("Timeline range selection", () => {
  it("drag past the threshold selects a time window and shows the selection overlay", () => {
    const model = makeModel();
    const onSelectionChange = vi.fn();
    const { container } = render(
      <Harness
        model={model}
        bridge={makeBridge()}
        selectedCallId={undefined}
        onSelect={vi.fn()}
        onSelectionChange={onSelectionChange}
      />,
    );
    const strip = container.querySelector('[data-testid="timeline-strip"]');
    // rect is {left:0, width:800} over startTime 1000 / duration 4000:
    // x=150 -> t=1750, x=450 -> t=3250.
    fireEvent.pointerDown(strip!, { clientX: 150, pointerId: 1 });
    fireEvent.pointerMove(strip!, { clientX: 450, pointerId: 1 });
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      start: 1750,
      end: 3250,
    });
    expect(
      container.querySelector('[data-testid="timeline-selection"]'),
    ).toBeTruthy();

    // Dragging back left of the anchor keeps start <= end.
    fireEvent.pointerMove(strip!, { clientX: 50, pointerId: 1 });
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      start: 1250,
      end: 1750,
    });
  });

  it("a plain click seeks without creating a selection", () => {
    const model = makeModel();
    const onSelect = vi.fn();
    const onSelectionChange = vi.fn();
    const { container } = render(
      <Harness
        model={model}
        bridge={makeBridge()}
        selectedCallId={undefined}
        onSelect={onSelect}
        onSelectionChange={onSelectionChange}
      />,
    );
    const strip = container.querySelector('[data-testid="timeline-strip"]');
    fireEvent.pointerDown(strip!, { clientX: 400, pointerId: 1 });
    // Sub-threshold jitter (4px) must not start a selection drag.
    fireEvent.pointerMove(strip!, { clientX: 403, pointerId: 1 });
    fireEvent.pointerUp(strip!, { clientX: 403, pointerId: 1 });
    expect(onSelect).toHaveBeenCalledWith("call@4");
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="timeline-selection"]'),
    ).toBeNull();
  });

  it("a click dismisses the active selection and seeks the full action set", () => {
    const model = makeModel();
    const onSelect = vi.fn();
    const onSelectionChange = vi.fn();
    const { container } = render(
      <Harness
        model={model}
        bridge={makeBridge()}
        selectedCallId={undefined}
        onSelect={onSelect}
        onSelectionChange={onSelectionChange}
      />,
    );
    const strip = container.querySelector('[data-testid="timeline-strip"]');
    // Select t=1750..3250 (call@2 + call@4 intersect it).
    fireEvent.pointerDown(strip!, { clientX: 150, pointerId: 1 });
    fireEvent.pointerMove(strip!, { clientX: 450, pointerId: 1 });
    fireEvent.pointerUp(strip!, { clientX: 450, pointerId: 1 });
    fireEvent.lostPointerCapture(strip!, { pointerId: 1 });
    expect(
      container.querySelector('[data-testid="timeline-selection"]'),
    ).toBeTruthy();
    onSelect.mockClear();

    // Click at x=50 -> t=1250, OUTSIDE the window. The seek must resolve
    // against the FULL set (call@1, 1000–1400) — never clamp to the window's
    // nearest action (call@2) — and the release dismisses the selection.
    fireEvent.pointerDown(strip!, { clientX: 50, pointerId: 1 });
    expect(onSelect).toHaveBeenLastCalledWith("call@1");
    fireEvent.pointerUp(strip!, { clientX: 50, pointerId: 1 });
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);
    expect(
      container.querySelector('[data-testid="timeline-selection"]'),
    ).toBeNull();
  });

  it("plays only the selected section and pauses at its end", () => {
    const model = makeModel();
    const onSelect = vi.fn();
    const { container } = render(
      <Harness
        model={model}
        bridge={makeBridge()}
        selectedCallId="call@2"
        onSelect={onSelect}
      />,
    );
    const strip = container.querySelector('[data-testid="timeline-strip"]');
    // Select t=1750..3250 — call@2 (2000–2600) and call@4 (3000–4000)
    // intersect it; call@1 (1000–1400) falls outside the window.
    fireEvent.pointerDown(strip!, { clientX: 150, pointerId: 1 });
    fireEvent.pointerMove(strip!, { clientX: 450, pointerId: 1 });
    fireEvent.pointerUp(strip!, { clientX: 450, pointerId: 1 });
    fireEvent.lostPointerCapture(strip!, { pointerId: 1 });
    onSelect.mockClear();

    // Play starts from the selected action (call@2, startTime 2000 — inside
    // the window) and the playhead's clock stops at the window end (3250),
    // not the trace end (5000).
    fireEvent.click(control(container, "Play"));
    expect(control(container, "Pause")).toBeTruthy();
    flushFrame(0); // baseline
    flushFrame(1050); // t=3050 -> call@4 (nearest in the window's set)
    expect(onSelect).toHaveBeenLastCalledWith("call@4");
    flushFrame(1300); // t=3300, clamped to 3250 -> playback pauses
    expect(control(container, "Play")).toBeTruthy();
    expect(rafCallbacks.size).toBe(0);
    // call@1 (outside the selection) was never selected during playback.
    expect(onSelect.mock.calls.map((c) => c[0])).not.toContain("call@1");
  });
});

/** aria-label lookup scoped to the render container. */
function control(container: HTMLElement, label: string): HTMLButtonElement {
  const el = container.querySelector(`button[aria-label="${label}"]`);
  expect(el).toBeTruthy();
  return el as HTMLButtonElement;
}

describe("Timeline playback toolbar", () => {
  it("disables Play (and stepping) when the trace has no actions", () => {
    const model = makeModel({ actions: [] });
    const { container } = render(
      <Harness
        model={model}
        bridge={makeBridge()}
        selectedCallId={undefined}
        onSelect={vi.fn()}
      />,
    );
    expect(control(container, "Play").disabled).toBe(true);
    expect(control(container, "Previous action").disabled).toBe(true);
    expect(control(container, "Next action").disabled).toBe(true);
    expect(control(container, "Stop").disabled).toBe(true);
  });

  it("enables Play and disables prev/stop on the first action, next on the last", () => {
    const model = makeModel();
    const first = render(
      <Harness
        model={model}
        bridge={makeBridge()}
        selectedCallId="call@1"
        onSelect={vi.fn()}
      />,
    );
    expect(control(first.container, "Play").disabled).toBe(false);
    expect(control(first.container, "Previous action").disabled).toBe(true);
    expect(control(first.container, "Stop").disabled).toBe(true);
    expect(control(first.container, "Next action").disabled).toBe(false);
    first.unmount();

    const last = render(
      <Harness
        model={model}
        bridge={makeBridge()}
        selectedCallId="call@4"
        onSelect={vi.fn()}
      />,
    );
    expect(control(last.container, "Previous action").disabled).toBe(false);
    expect(control(last.container, "Stop").disabled).toBe(false);
    expect(control(last.container, "Next action").disabled).toBe(true);
  });

  it("steps the selection with next/prev over the default-visible actions", () => {
    const model = makeModel();
    const onSelect = vi.fn();
    const { container } = render(
      <Harness
        model={model}
        bridge={makeBridge()}
        selectedCallId="call@2"
        onSelect={onSelect}
      />,
    );
    // Stepping walks `filteredActions([])` — startTime-ordered call@1(1000),
    // call@2(2000), call@4(3000). The route-grouped call@3(2050) is hidden
    // from the action list by default, so playback controls skip it too
    // (selecting it would land on an action with no visible row).
    fireEvent.click(control(container, "Next action"));
    expect(onSelect).toHaveBeenLastCalledWith("call@4");
    fireEvent.click(control(container, "Previous action"));
    expect(onSelect).toHaveBeenLastCalledWith("call@1");
  });

  it("stop selects the first action", () => {
    const model = makeModel();
    const onSelect = vi.fn();
    const { container } = render(
      <Harness
        model={model}
        bridge={makeBridge()}
        selectedCallId="call@4"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(control(container, "Stop"));
    expect(onSelect).toHaveBeenCalledWith("call@1");
  });

  it("cycles the speed label 1× → 2× → 0.5× → 1×", () => {
    const model = makeModel();
    const { container } = render(
      <Harness
        model={model}
        bridge={makeBridge()}
        selectedCallId="call@1"
        onSelect={vi.fn()}
      />,
    );
    const speed = control(container, "Playback speed");
    expect(speed.textContent).toBe("1×");
    fireEvent.click(speed);
    expect(speed.textContent).toBe("2×");
    fireEvent.click(speed);
    expect(speed.textContent).toBe("0.5×");
    fireEvent.click(speed);
    expect(speed.textContent).toBe("1×");
  });

  it("plays through the trace on rAF frames, selecting nearest actions, and stops at endTime", () => {
    const model = makeModel();
    const onSelect = vi.fn();
    const { container } = render(
      <Harness
        model={model}
        bridge={makeBridge()}
        selectedCallId={undefined}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(control(container, "Play"));
    expect(control(container, "Pause")).toBeTruthy();

    // No selection -> playback starts at model.startTime (1000). The first
    // frame only baselines the clock; each later frame advances the playhead
    // by the timestamp delta (speed 1×).
    flushFrame(0);
    flushFrame(100); // t=1100 -> call@1 (next at 2000 is farther)
    flushFrame(950); // t=1950 -> snaps forward to call@2 (2000 is closer)
    // The moving playhead cursor is rendered while playing.
    expect(
      container.querySelector('[data-testid="timeline-playhead"]'),
    ).toBeTruthy();
    // The route-grouped call@3 (2050) is skipped — playback walks the
    // default-visible `filteredActions([])`, matching the action list.
    flushFrame(2100); // t=3100 -> call@4 (3000)
    expect(onSelect.mock.calls.map((c) => c[0])).toEqual([
      "call@1",
      "call@2",
      "call@4",
    ]);

    flushFrame(4200); // t=5200, clamped to endTime 5000 -> playback stops
    expect(control(container, "Play")).toBeTruthy();
    // The loop is dead: no pending frames, no further selections.
    expect(rafCallbacks.size).toBe(0);
    flushFrame(9000);
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it("restarts from the first action when playing at/after the last action", () => {
    const model = makeModel();
    const onSelect = vi.fn();
    const { container } = render(
      <Harness
        model={model}
        bridge={makeBridge()}
        selectedCallId="call@4"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(control(container, "Play"));
    expect(onSelect).toHaveBeenCalledWith("call@1");
    expect(control(container, "Pause")).toBeTruthy();
  });

  it("pauses playback on a manual strip seek", () => {
    const model = makeModel();
    const { container } = render(
      <Harness
        model={model}
        bridge={makeBridge()}
        selectedCallId="call@1"
        onSelect={vi.fn()}
      />,
    );
    fireEvent.click(control(container, "Play"));
    expect(control(container, "Pause")).toBeTruthy();
    const strip = container.querySelector('[data-testid="timeline-strip"]');
    fireEvent.pointerDown(strip!, { clientX: 400, pointerId: 1 });
    expect(control(container, "Play")).toBeTruthy();
  });
});

describe("Timeline hover preview placement", () => {
  it("flips the preview card below the strip when there is no room above", () => {
    // The beforeEach mock already reports container top 0 — no room above.
    const model = makeModel();
    const { container } = render(
      <Harness
        model={model}
        bridge={makeBridge()}
        selectedCallId={undefined}
        onSelect={vi.fn()}
      />,
    );
    const strip = container.querySelector('[data-testid="timeline-strip"]');
    fireEvent.pointerMove(strip!, { clientX: 400, pointerId: 1 });
    const card = container.querySelector('[data-testid="timeline-preview"]');
    expect(card).toBeTruthy();
    expect(card!.getAttribute("data-side")).toBe("bottom");
  });

  it("captions the preview with the action active at the hovered time", () => {
    // clientX 400 of the 800-wide strip -> fraction 0.5 -> time 3000
    // (startTime 1000 + 0.5 * 4000), where the `Expect "toHaveText"` action
    // (startTime 3000, selector "#total") is active.
    const model = makeModel();
    const { container } = render(
      <Harness
        model={model}
        bridge={makeBridge()}
        selectedCallId={undefined}
        onSelect={vi.fn()}
      />,
    );
    const strip = container.querySelector('[data-testid="timeline-strip"]');
    fireEvent.pointerMove(strip!, { clientX: 400, pointerId: 1 });
    const card = container.querySelector('[data-testid="timeline-preview"]');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain('Expect "toHaveText"');
    expect(card!.textContent).toContain("#total");
  });

  it("keeps the preview card above the strip when there is room", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 800,
      height: 80,
      left: 0,
      top: 400,
      right: 800,
      bottom: 480,
      x: 0,
      y: 400,
      toJSON() {
        return {};
      },
    });
    const model = makeModel();
    const { container } = render(
      <Harness
        model={model}
        bridge={makeBridge()}
        selectedCallId={undefined}
        onSelect={vi.fn()}
      />,
    );
    const strip = container.querySelector('[data-testid="timeline-strip"]');
    fireEvent.pointerMove(strip!, { clientX: 400, pointerId: 1 });
    const card = container.querySelector('[data-testid="timeline-preview"]');
    expect(card).toBeTruthy();
    expect(card!.getAttribute("data-side")).toBe("top");
  });
});
