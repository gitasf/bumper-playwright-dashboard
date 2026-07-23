import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vite-plus/test";
import { cleanup, render, screen } from "@testing-library/react";
import { CallTab } from "@/trace-viewer/components/call-tab";
import { makeModel, makeTabProps } from "./trace-viewer-fixture";
import { installTraceViewerDomStubs } from "./trace-viewer-test-env";

// happy-dom gap: the vendored Base UI ScrollArea (used by ErrorsTab's sibling
// panels within DetailTabs) polls viewport.getAnimations() on a timer; stub
// it so that doesn't throw.
let restoreDomStubs: () => void;
beforeAll(() => {
  restoreDomStubs = installTraceViewerDomStubs({ getAnimations: true });
});
afterAll(() => {
  restoreDomStubs();
});

afterEach(() => {
  cleanup();
});

describe("CallTab", () => {
  it("renders params for the selected action (#checkout)", () => {
    const model = makeModel();
    const selectedAction = model.actions.find((a) => a.callId === "call@2");
    render(<CallTab {...makeTabProps({ model, selectedAction })} />);
    expect(screen.getByText('"#checkout"')).toBeTruthy();
  });

  it("renders the return value, duration and ANSI-colorized error for a failed action", () => {
    const model = makeModel();
    const selectedAction = model.actions.find((a) => a.callId === "call@4");
    render(<CallTab {...makeTabProps({ model, selectedAction })} />);

    // Return value JSON preview.
    const returnValue = screen.getByText(/"received"/);
    expect(returnValue.textContent).toContain("received");
    expect(returnValue.textContent).toContain("12");

    // Duration (endTime 4000 - startTime 3000 = 1000ms -> formatDuration).
    expect(screen.getByText("1s")).toBeTruthy();

    // Error block is rendered via dangerouslySetInnerHTML from ansiToHtml —
    // assert the ANSI-colorized container carries the message text.
    expect(screen.getByText("Error")).toBeTruthy();
    const errorBlock = Array.from(document.querySelectorAll("pre")).find((el) =>
      el.textContent?.includes("expect failed: total mismatch"),
    );
    expect(errorBlock).toBeTruthy();
  });

  it("shows the empty-state message when no action is selected", () => {
    render(<CallTab {...makeTabProps()} />);
    expect(
      screen.getByText("Select an action to see its call details."),
    ).toBeTruthy();
  });
});
