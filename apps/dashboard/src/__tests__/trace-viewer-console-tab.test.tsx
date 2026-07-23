import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { cleanup, render, screen } from "@testing-library/react";
import { ConsoleTab } from "@/trace-viewer/components/console-tab";
import {
  makeAction,
  makeContext,
  makeModel,
  makeTabProps,
} from "./trace-viewer-fixture";
import { installTraceViewerDomStubs } from "./trace-viewer-test-env";

/**
 * Component tests for the Console detail tab — ANSI stripping and
 * action-window scoping — against the shared synthetic fixture
 * (`trace-viewer-fixture.ts`).
 */

let restoreDomStubs: () => void;

beforeEach(() => {
  // Shared happy-dom gap stubs — see trace-viewer-test-env.ts for the
  // rationale behind each option.
  restoreDomStubs = installTraceViewerDomStubs({
    layout: true,
    objectUrl: true,
    scrollIntoView: true,
    pointerCapture: true,
    getAnimations: true,
  });
});

afterEach(() => {
  cleanup();
  restoreDomStubs();
});

describe("ConsoleTab", () => {
  it("renders every console/pageError row, stripping ANSI residue", () => {
    render(<ConsoleTab {...makeTabProps()} />);
    expect(screen.getByText("loading cart")).toBeTruthy();
    expect(screen.getByText("boom red")).toBeTruthy();
    expect(screen.getByText("Uncaught kaboom")).toBeTruthy();
    expect(screen.queryByText(/\[31m/)).toBeNull();
  });

  it("scopes to the selected action's window, keeping only in-window events", () => {
    const model = makeModel();
    const selectedAction = model.actions.find((a) => a.callId === "call@2")!;
    render(
      <ConsoleTab
        {...makeTabProps({ model, selectedAction, scopeToSelected: true })}
      />,
    );
    expect(screen.getByText("boom red")).toBeTruthy();
    expect(screen.queryByText("loading cart")).toBeNull();
    expect(screen.queryByText("Uncaught kaboom")).toBeNull();
  });

  it("shows a scoped-empty message when the action's window has no console output", () => {
    const defaultActions = makeContext().actions;
    const quietAction = makeAction({
      callId: "call@5",
      method: "click",
      title: "Click nothing",
      startTime: 4500,
      endTime: 4900,
    });
    const model = makeModel({ actions: [...defaultActions, quietAction] });
    const selectedAction = model.actions.find((a) => a.callId === "call@5")!;
    render(
      <ConsoleTab
        {...makeTabProps({ model, selectedAction, scopeToSelected: true })}
      />,
    );
    expect(
      screen.getByText("No console output during this action."),
    ).toBeTruthy();
  });

  it("filters rows to the timeline selection window", () => {
    // Fixture console rows: "loading cart" (1200), "boom red" (2200),
    // pageError "Uncaught kaboom" (3500) — only the middle one is in window.
    render(
      <ConsoleTab
        {...makeTabProps({ selection: { start: 2000, end: 3000 } })}
      />,
    );
    expect(screen.getByText("boom red")).toBeTruthy();
    expect(screen.queryByText("loading cart")).toBeNull();
    expect(screen.queryByText("Uncaught kaboom")).toBeNull();
  });

  it("shows a selection-empty message when the window has no console output", () => {
    render(
      <ConsoleTab
        {...makeTabProps({ selection: { start: 4500, end: 4900 } })}
      />,
    );
    expect(
      screen.getByText("No console output in the selected timeline range."),
    ).toBeTruthy();
  });
});
