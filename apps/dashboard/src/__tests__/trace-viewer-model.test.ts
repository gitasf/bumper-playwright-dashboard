import { describe, expect, it } from "vite-plus/test";
import {
  collectSnapshots,
  defaultSelectedActionId,
  describeTraceLoadError,
  sha1DownloadUrl,
  sha1Path,
  snapshotIframeUrl,
  snapshotInfoPath,
  snapshotViewport,
} from "@/trace-viewer/model";
import { TraceModel } from "@/trace-viewer/vendor/model-util";
import {
  FIXTURE_TRACE_URL,
  makeAction,
  makeContext,
} from "./trace-viewer-fixture";

/**
 * Exercises the vendored `TraceModel` adapter (`collectSnapshots`,
 * `defaultSelectedActionId`, the sha1/snapshot URL builders) against the
 * shared synthetic fixture (`trace-viewer-fixture.ts`), trimmed down to the
 * three actions (a goto with before+after snapshots, a click with only an
 * input snapshot, and a failing expect with no snapshots) these assertions
 * need.
 */

function fixtureContext() {
  return makeContext({
    actions: [
      makeAction({
        callId: "call@1",
        method: "goto",
        startTime: 1000,
        endTime: 1100,
        beforeSnapshot: "before@call@1",
        afterSnapshot: "after@call@1",
      }),
      makeAction({
        callId: "call@2",
        method: "click",
        startTime: 1200,
        endTime: 1300,
        inputSnapshot: "input@call@2",
        point: { x: 10, y: 20 },
      }),
      makeAction({
        callId: "call@3",
        method: "expect",
        startTime: 1400,
        endTime: 1500,
        error: { name: "Error", message: "expect failed" },
      }),
    ],
  });
}

describe("trace-viewer model adapter", () => {
  const model = new TraceModel(FIXTURE_TRACE_URL, [fixtureContext()]);

  it("vendored TraceModel builds from a contexts payload", () => {
    expect(model.actions.map((a) => a.callId)).toEqual([
      "call@1",
      "call@2",
      "call@3",
    ]);
    expect(model.startTime).toBe(1000);
    expect(model.errorDescriptors).toHaveLength(1);
    expect(model.errorDescriptors[0]?.message).toBe("expect failed");
  });

  it("collectSnapshots uses the action's own snapshots when present", () => {
    const snapshots = collectSnapshots(model.actions[0]);
    expect(snapshots.before?.snapshotName).toBe("before@call@1");
    expect(snapshots.after?.snapshotName).toBe("after@call@1");
    // No inputSnapshot -> the Action tab falls back to After, carrying the
    // action's own (absent) point.
    expect(snapshots.action?.snapshotName).toBe("after@call@1");
    expect(snapshots.action?.point).toBeUndefined();
  });

  it("collectSnapshots borrows the previous afterSnapshot as Before", () => {
    const snapshots = collectSnapshots(model.actions[1]);
    expect(snapshots.before?.snapshotName).toBe("after@call@1");
    expect(snapshots.action?.snapshotName).toBe("input@call@2");
    expect(snapshots.action?.point).toEqual({ x: 10, y: 20 });
    // No own/descendant afterSnapshot -> falls back to the computed Before.
    expect(snapshots.after?.snapshotName).toBe("after@call@1");
  });

  it("collectSnapshots returns nothing for an empty selection", () => {
    expect(collectSnapshots(undefined)).toEqual({});
  });

  it("defaultSelectedActionId prefers the last failed action", () => {
    expect(defaultSelectedActionId(model)).toBe("call@3");
    const passing = new TraceModel(FIXTURE_TRACE_URL, [
      {
        ...fixtureContext(),
        actions: fixtureContext().actions.slice(0, 2),
      },
    ]);
    expect(defaultSelectedActionId(passing)).toBe("call@2");
  });

  it("defaultSelectedActionId picks the innermost failed action for a nested test.step", () => {
    // Playwright propagates a step's descendant error onto the wrapping
    // test.step action too, and those sort parent-first — so the outer step
    // action (call@step) appears before the inner failing action (call@inner)
    // in `model.actions`. `failedAction()` (vendor) is a `findLast`, so it
    // must resolve to the innermost/last one, not the outer step wrapper.
    const nested = new TraceModel(FIXTURE_TRACE_URL, [
      makeContext({
        actions: [
          makeAction({
            callId: "call@step",
            method: "step",
            startTime: 1000,
            endTime: 1500,
            error: { name: "Error", message: "step failed" },
          }),
          makeAction({
            callId: "call@inner",
            method: "click",
            startTime: 1100,
            endTime: 1200,
            error: { name: "Error", message: "click failed" },
          }),
        ],
      }),
    ]);
    expect(defaultSelectedActionId(nested)).toBe("call@inner");
  });

  it("snapshotIframeUrl targets the SW scope with trace/name/point params", () => {
    const snapshots = collectSnapshots(model.actions[1]);
    const url = new URL(
      snapshotIframeUrl(FIXTURE_TRACE_URL, snapshots.action!),
      "https://dash.example",
    );
    expect(url.pathname).toBe("/trace-viewer/snapshot/page@1");
    expect(url.searchParams.get("trace")).toBe(FIXTURE_TRACE_URL);
    expect(url.searchParams.get("name")).toBe("input@call@2");
    expect(url.searchParams.get("pointX")).toBe("10");
    expect(url.searchParams.get("pointY")).toBe("20");
  });

  it("sha1DownloadUrl carries download name and content type", () => {
    const url = new URL(
      sha1DownloadUrl(
        FIXTURE_TRACE_URL,
        "abc123",
        "screenshot.png",
        "image/png",
      ),
      "https://dash.example",
    );
    expect(url.pathname).toBe("/trace-viewer/sha1/abc123");
    expect(url.searchParams.get("dn")).toBe("screenshot.png");
    expect(url.searchParams.get("dct")).toBe("image/png");
    expect(url.searchParams.get("trace")).toBe(FIXTURE_TRACE_URL);
  });

  it("bridge-proxy paths are scope-relative and carry the trace param", () => {
    // Bridge fetches resolve against /trace-viewer/bridge.html, so these
    // must be RELATIVE paths (no leading slash) with ?trace= for the SW.
    const info = snapshotInfoPath(
      FIXTURE_TRACE_URL,
      collectSnapshots(model.actions[1]).action!,
    );
    expect(info.startsWith("snapshotInfo/page@1?")).toBe(true);
    expect(info).toContain(`trace=${encodeURIComponent(FIXTURE_TRACE_URL)}`);
    expect(info).toContain("name=input%40call%402");

    const sha1 = sha1Path(FIXTURE_TRACE_URL, "src@abc.txt");
    expect(sha1.startsWith("sha1/src@abc.txt?")).toBe(true);
    expect(sha1).toContain(`trace=${encodeURIComponent(FIXTURE_TRACE_URL)}`);
  });

  it("snapshotViewport reads the recorded context viewport", () => {
    expect(snapshotViewport(model.actions[0]!)).toEqual({
      width: 1280,
      height: 720,
    });
  });

  it("describeTraceLoadError makes the version mismatch actionable", () => {
    expect(
      describeTraceLoadError(
        "The trace was created by a newer version of Playwright and is not supported…",
      ),
    ).toMatch(/newer Playwright version/);
    expect(describeTraceLoadError("boom")).toBe("boom");
  });
});
