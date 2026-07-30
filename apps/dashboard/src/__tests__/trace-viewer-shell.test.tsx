import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { cleanup, render, screen } from "@testing-library/react";
import { TraceViewer } from "@/trace-viewer/components/trace-viewer";
import type { TraceModelState } from "@/trace-viewer/use-trace-model";
import { useTraceModel } from "@/trace-viewer/use-trace-model";
import {
  FIXTURE_TRACE_URL,
  makeAction,
  makeBridge,
  makeContext,
} from "./trace-viewer-fixture";
import { installTraceViewerDomStubs } from "./trace-viewer-test-env";

/**
 * The `TraceViewer` shell — the component that turns `useTraceModel`'s state
 * into the loading / error / workbench surfaces. The hook itself is covered
 * by `trace-viewer-hooks.test.tsx` and the workbench children by their own
 * suites, so the hook is mocked here and each state shape (including the
 * stale-while-switching window introduced for in-place attempt switching) is
 * driven through the REAL component tree.
 */

vi.mock("@/trace-viewer/use-trace-model", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTraceModel: vi.fn(),
}));
const useTraceModelMock = vi.mocked(useTraceModel);

function mockState(state: TraceModelState): void {
  // Mirrors the real hook's invariant: the bridge's `traceUrl` is the same
  // string as the ready model's `state.traceUrl` (see `useTraceModel`).
  const traceUrl =
    state.status === "ready" ? state.traceUrl : FIXTURE_TRACE_URL;
  useTraceModelMock.mockReturnValue({
    state,
    bridge: makeBridge({}, traceUrl),
  });
}

function readyState(
  over?: Partial<Extract<TraceModelState, { status: "ready" }>>,
): TraceModelState {
  return {
    status: "ready",
    traceUrl: FIXTURE_TRACE_URL,
    contextEntries: [makeContext()],
    switching: null,
    ...over,
  };
}

let restoreDomStubs: () => void;

beforeEach(() => {
  restoreDomStubs = installTraceViewerDomStubs({
    layout: true,
    objectUrl: true,
    scrollIntoView: true,
    pointerCapture: true,
    getAnimations: true,
  });
  useTraceModelMock.mockReset();
});

afterEach(() => {
  cleanup();
  restoreDomStubs();
});

describe("TraceViewer shell", () => {
  it("renders the spinner without a progress bar while loading with no progress", () => {
    mockState({ status: "loading", progress: null });
    render(<TraceViewer traceUrl={FIXTURE_TRACE_URL} />);

    expect(screen.getByText("Loading trace…")).toBeDefined();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("reflects zip download progress in the loading bar", () => {
    mockState({ status: "loading", progress: { done: 1, total: 2 } });
    render(<TraceViewer traceUrl={FIXTURE_TRACE_URL} />);

    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
  });

  it("renders the error surface through describeTraceLoadError", () => {
    mockState({ status: "error", error: "the trace URL returned HTTP 404" });
    render(<TraceViewer traceUrl={FIXTURE_TRACE_URL} />);

    expect(screen.getByText("Couldn't load this trace")).toBeDefined();
    expect(screen.getByText(/HTTP 404/)).toBeDefined();
  });

  it("renders the workbench for a ready model, with no switch indicator", () => {
    mockState(readyState());
    const { container } = render(<TraceViewer traceUrl={FIXTURE_TRACE_URL} />);

    // Fixture action titles prove the real ActionList mounted.
    expect(screen.getByText("Navigate to app")).toBeDefined();
    expect(screen.getByText("Click checkout")).toBeDefined();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(
      screen.getByRole("separator", {
        name: "Resize action list and trace details",
      }),
    ).toBeDefined();
    expect(
      screen.getByRole("separator", {
        name: "Resize snapshot and action details",
      }),
    ).toBeDefined();
  });

  it("keeps the workbench rendered during a switch, with an indeterminate bar", () => {
    mockState(readyState({ switching: { progress: null } }));
    const { container } = render(<TraceViewer traceUrl={FIXTURE_TRACE_URL} />);

    // The stale workbench must survive the switch — that's the whole point.
    expect(screen.getByText("Navigate to app")).toBeDefined();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-label")).toBe("Loading attempt");
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
  });

  it("shows determinate switch progress once the SW reports it", () => {
    mockState(readyState({ switching: { progress: { done: 3, total: 4 } } }));
    render(<TraceViewer traceUrl={FIXTURE_TRACE_URL} />);

    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "75",
    );
  });

  it("resets the selection to the new model's default when the ready model swaps in place", () => {
    // The single aria-selected row in the action list (option role — action
    // titles also render in the Call tab, so text queries alone are ambiguous).
    const selectedActionText = (): string => {
      const selected = screen
        .getAllByRole("option")
        .filter((el) => el.getAttribute("aria-selected") === "true");
      expect(selected).toHaveLength(1);
      return selected[0]!.textContent ?? "";
    };

    mockState(readyState());
    const { rerender } = render(<TraceViewer traceUrl={FIXTURE_TRACE_URL} />);
    // Fixture default selection: the first errored action.
    expect(selectedActionText()).toContain('Expect "toHaveText"');

    // The next attempt's model swaps in WITHOUT a workbench remount (the
    // workbench is un-keyed) — the stale callId must be replaced by the new
    // model's default selection, not carried across traces.
    const nextTraceUrl = "https://dash.test/api/artifacts/a2/download?t=next";
    mockState(
      readyState({
        traceUrl: nextTraceUrl,
        contextEntries: [
          makeContext({
            actions: [
              makeAction({
                callId: "call@b1",
                title: "B step one",
                startTime: 1000,
                endTime: 2000,
              }),
              makeAction({
                callId: "call@b2",
                title: "B step two",
                startTime: 2000,
                endTime: 3000,
                error: { name: "Error", message: "b fail" },
              }),
            ],
          }),
        ],
      }),
    );
    rerender(<TraceViewer traceUrl={nextTraceUrl} />);

    expect(selectedActionText()).toContain("B step two");
  });

  it("renders the workbench from the READY model's trace, not the prop", () => {
    // Mid-switch the prop already points at the NEXT trace; the workbench
    // must keep rendering the ready model (snapshot/source fetches would
    // otherwise mix traces).
    mockState(readyState({ switching: { progress: null } }));
    render(
      <TraceViewer traceUrl="https://dash.test/api/artifacts/a2/download?t=next" />,
    );

    expect(screen.getByText("Navigate to app")).toBeDefined();
  });
});
