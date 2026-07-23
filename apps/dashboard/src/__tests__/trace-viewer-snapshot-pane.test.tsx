import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ScaledSnapshotStage } from "@/trace-viewer/components/snapshot-stage";
import type { PlaybackController } from "@/trace-viewer/components/use-playback";
import { SnapshotPane } from "@/trace-viewer/components/snapshot-pane";
import { collectSnapshots } from "@/trace-viewer/model";
import {
  FIXTURE_TRACE_URL,
  makeAction,
  makeBridge,
  makeModel,
} from "./trace-viewer-fixture";
import { installTraceViewerDomStubs } from "./trace-viewer-test-env";

/**
 * Inert playback controller — these tests exercise the snapshot scrubber, not
 * the prev/play/stop/next/speed cluster (that lives in `usePlayback` +
 * `PlaybackControls`, covered by `trace-viewer-timeline.test.tsx`). The pane
 * only forwards these values into the control cluster; a no-op stub keeps the
 * buttons rendered without pulling the whole workbench into scope.
 */
const STUB_PLAYBACK: PlaybackController = {
  playing: false,
  speedIndex: 1,
  atStart: true,
  atEnd: false,
  hasActions: true,
  session: 0,
  playFrom: 0,
  playTo: 0,
  initialSelectedCallId: undefined,
  playableActions: [],
  togglePlay: () => {},
  pause: () => {},
  stopPlayback: () => {},
  step: () => {},
  cycleSpeed: () => {},
};

/**
 * Component tests for the center snapshot-scrubber pane: Before/Action/After
 * iframe derivation (`collectSnapshots`), the click-point carried on the
 * Action tab, the `snapshotInfo` URL bar, the popout link, and the "no
 * snapshot" empty state — all against the shared synthetic fixture.
 */

let restoreDomStubs: () => void;

beforeEach(() => {
  // SnapshotPane's stage sizes itself off the container's clientWidth/Height
  // (not getBoundingClientRect), but the shared stub mocks both — the fixed
  // ~800×400 read is what lets `scale > 0` and the iframes actually mount.
  restoreDomStubs = installTraceViewerDomStubs({
    layout: true,
    objectUrl: true,
    scrollIntoView: true,
    pointerCapture: true,
  });
});

afterEach(() => {
  cleanup();
  restoreDomStubs();
});

/** Parse a mounted snapshot iframe's `src` into a URL for param assertions. */
function iframeSrc(title: string): URL {
  const iframe = screen.getByTitle(title);
  return new URL(iframe.getAttribute("src") ?? "", "http://localhost");
}

describe("SnapshotPane", () => {
  it("renders Before/After iframes pointed at the action's before/after snapshots", () => {
    const model = makeModel();
    const action = model.actions.find((a) => a.callId === "call@1")!;
    render(
      <SnapshotPane
        action={action}
        bridge={makeBridge()}
        playback={STUB_PLAYBACK}
      />,
    );
    expect(iframeSrc("DOM snapshot (Before)").searchParams.get("name")).toBe(
      "before@call@1",
    );
    expect(iframeSrc("DOM snapshot (After)").searchParams.get("name")).toBe(
      "after@call@1",
    );
  });

  it("carries the recorded click point on the Action snapshot iframe", () => {
    const model = makeModel();
    const action = model.actions.find((a) => a.callId === "call@2")!;
    render(
      <SnapshotPane
        action={action}
        bridge={makeBridge()}
        playback={STUB_PLAYBACK}
      />,
    );
    const url = iframeSrc("DOM snapshot (Action)");
    expect(url.searchParams.get("pointX")).toBe("5");
    expect(url.searchParams.get("pointY")).toBe("6");
  });

  it("shows the captured page URL once the snapshotInfo sidecar resolves", async () => {
    const model = makeModel();
    const action = model.actions.find((a) => a.callId === "call@1")!;
    const bridge = makeBridge({
      "snapshotInfo/page@1": {
        url: "https://app.example/cart",
        viewport: { width: 800, height: 600 },
      },
    });
    render(
      <SnapshotPane action={action} bridge={bridge} playback={STUB_PLAYBACK} />,
    );
    expect(await screen.findByText("https://app.example/cart")).toBeTruthy();
  });

  it("links the popout to the vendored snapshot.html shell", () => {
    const model = makeModel();
    const action = model.actions.find((a) => a.callId === "call@1")!;
    render(
      <SnapshotPane
        action={action}
        bridge={makeBridge()}
        playback={STUB_PLAYBACK}
      />,
    );
    const link = screen.getByRole("link", {
      name: "Open snapshot in a new tab",
    });
    expect(link.getAttribute("href")).toContain(
      "/trace-viewer/snapshot.html?r=",
    );
  });

  it("keeps the previous snapshot visible while a changed URL loads, then promotes it (double buffer)", () => {
    const model = makeModel();
    const action = model.actions.find((a) => a.callId === "call@1")!;
    const OTHER_TRACE_URL = "https://dash.test/api/artifacts/a2/download?t=t2";
    const { rerender } = render(
      <SnapshotPane
        action={action}
        bridge={makeBridge()}
        playback={STUB_PLAYBACK}
      />,
    );

    // Attempt swap: same pane instance, new trace → every slot's URL changes.
    rerender(
      <SnapshotPane
        action={action}
        bridge={makeBridge({}, OTHER_TRACE_URL)}
        playback={STUB_PLAYBACK}
      />,
    );

    // The Action slot (the active tab) now holds TWO iframes: the old
    // document still visible, the new one loading hidden behind it.
    const frames = screen.getAllByTitle("DOM snapshot (Action)");
    expect(frames).toHaveLength(2);
    const src = (el: Element): string | null =>
      new URL(
        el.getAttribute("src") ?? "",
        "http://localhost",
      ).searchParams.get("trace");
    const front = frames.find((f) => f.getAttribute("aria-hidden") === "false");
    const back = frames.find((f) => f.getAttribute("aria-hidden") === "true");
    expect(front && src(front)).toBe(FIXTURE_TRACE_URL);
    expect(back && src(back)).toBe(OTHER_TRACE_URL);

    // New document finishes loading → promoted in place, old front retired.
    fireEvent.load(back!);
    const remaining = screen.getAllByTitle("DOM snapshot (Action)");
    expect(remaining).toHaveLength(1);
    expect(src(remaining[0]!)).toBe(OTHER_TRACE_URL);
    expect(remaining[0]!.getAttribute("aria-hidden")).toBe("false");
  });

  it("keeps the visible snapshot's viewport until the replacement is promoted", () => {
    const model = makeModel();
    const action = model.actions.find((a) => a.callId === "call@1")!;
    const OTHER_TRACE_URL = "https://dash.test/api/artifacts/a2/download?t=t2";
    const snapshots = collectSnapshots(action);
    const available = ["before", "action", "after"] as const;
    const { rerender } = render(
      <ScaledSnapshotStage
        traceUrl={FIXTURE_TRACE_URL}
        snapshots={snapshots}
        available={[...available]}
        activeTab="action"
        viewport={{ width: 800, height: 600 }}
      />,
    );

    rerender(
      <ScaledSnapshotStage
        traceUrl={OTHER_TRACE_URL}
        snapshots={snapshots}
        available={[...available]}
        activeTab="action"
        viewport={{ width: 1600, height: 900 }}
      />,
    );

    const frames = screen.getAllByTitle("DOM snapshot (Action)");
    const front = frames.find(
      (frame) => frame.getAttribute("aria-hidden") === "false",
    );
    const back = frames.find(
      (frame) => frame.getAttribute("aria-hidden") === "true",
    );
    expect(front?.style.width).toBe("800px");
    expect(back?.style.width).toBe("1600px");
  });

  it("drops the back buffer when the URL returns to the visible document mid-load", () => {
    const model = makeModel();
    const action = model.actions.find((a) => a.callId === "call@1")!;
    const OTHER_TRACE_URL = "https://dash.test/api/artifacts/a2/download?t=t2";
    const { rerender } = render(
      <SnapshotPane
        action={action}
        bridge={makeBridge()}
        playback={STUB_PLAYBACK}
      />,
    );

    rerender(
      <SnapshotPane
        action={action}
        bridge={makeBridge({}, OTHER_TRACE_URL)}
        playback={STUB_PLAYBACK}
      />,
    );
    expect(screen.getAllByTitle("DOM snapshot (Action)")).toHaveLength(2);

    // Swap back before the pending load ever finishes — the still-visible
    // original must simply stay, with the abandoned buffer unmounted.
    rerender(
      <SnapshotPane
        action={action}
        bridge={makeBridge()}
        playback={STUB_PLAYBACK}
      />,
    );
    const frames = screen.getAllByTitle("DOM snapshot (Action)");
    expect(frames).toHaveLength(1);
    expect(
      new URL(
        frames[0]!.getAttribute("src") ?? "",
        "http://localhost",
      ).searchParams.get("trace"),
    ).toBe(FIXTURE_TRACE_URL);
  });

  it("shows the No snapshot empty state for an action that captured none", () => {
    // A standalone single-action model — collectSnapshots() would otherwise
    // walk sideways (previousActionByEndTime/nextActionByStartTime) and
    // borrow a neighboring action's before/after snapshot. Building this
    // through makeModel (rather than a bare makeAction()) still runs it
    // through the real TraceModel indexing pass, so those prev/next
    // links exist (as no-ops, being the only action) instead of being
    // symbol-absent — the same shape a real single-action trace would have.
    const noSnapshotAction = makeAction({
      callId: "call@none",
      pageId: undefined,
      startTime: 4500,
      endTime: 4900,
    });
    const model = makeModel({ actions: [noSnapshotAction] });
    const action = model.actions.find((a) => a.callId === "call@none")!;
    render(
      <SnapshotPane
        action={action}
        bridge={makeBridge()}
        playback={STUB_PLAYBACK}
      />,
    );
    expect(screen.getByText("No snapshot")).toBeTruthy();
    expect(
      screen.getByText("This action did not capture a DOM snapshot."),
    ).toBeTruthy();
  });
});
